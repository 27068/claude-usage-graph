// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CredentialRefresher } from '../../auth/credentialRefresher';
import type { IClock, ILogger } from '../../core/interfaces';

/**
 * The failure modes here are not "the test went red". They are "the user is
 * signed out of Claude Code and does not know why", so every test below asks
 * what is on disk afterwards rather than what the method returned.
 */

const NOW = 1_700_000_000_000;

const clock: IClock = { now: () => NOW };

class RecordingLogger implements ILogger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  /** Everything logged, for asserting a recovery path was actually named. */
  text(): string {
    return this.lines.join('\n');
  }
}

/** The shape Claude Code actually stores, extra fields included. */
function storedCredential(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      expiresAt: NOW - 1000,
      refreshTokenExpiresAt: NOW + 2_000_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      ...overrides,
    },
  });
}

interface Harness {
  home: string;
  target: string;
  logger: RecordingLogger;
  /** Every request the refresher made, so "no request" is assertable. */
  requests: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[];
  refresher: CredentialRefresher;
  read(): Record<string, unknown>;
  raw(): string;
  temps(): string[];
}

function harness(options: {
  file?: string;
  respond?: (body: Record<string, unknown>) => Promise<Response>;
  readFile?: (target: string) => Promise<string>;
}): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cug-refresh-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const target = path.join(home, '.claude', '.credentials.json');
  if (options.file !== undefined) {
    fs.writeFileSync(target, options.file, 'utf8');
  }

  const logger = new RecordingLogger();
  const requests: Harness['requests'] = [];

  const stubFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({
      url: String(url),
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const respond = options.respond ?? okResponse;
    return await respond(body);
  }) as unknown as typeof fetch;

  return {
    home,
    target,
    logger,
    requests,
    refresher: new CredentialRefresher(clock, logger, {
      platform: 'linux',
      homeDir: home,
      fetch: stubFetch,
      readFile: options.readFile,
    }),
    read: () =>
      (JSON.parse(fs.readFileSync(target, 'utf8')) as { claudeAiOauth: Record<string, unknown> })
        .claudeAiOauth,
    raw: () => fs.readFileSync(target, 'utf8'),
    temps: () =>
      fs.readdirSync(path.join(home, '.claude')).filter((name) => name.endsWith('.tmp')),
  };
}

function okResponse(): Promise<Response> {
  return jsonResponse(200, {
    access_token: 'access-new',
    refresh_token: 'refresh-new',
    expires_in: 28_800,
  });
}

function jsonResponse(status: number, payload: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  } as Response);
}

describe('credential refresher', () => {
  it('writes the new pair and keeps every field it does not own', async () => {
    const h = harness({ file: storedCredential() });

    assert.strictEqual(await h.refresher.refresh(), true);

    const after = h.read();
    assert.strictEqual(after.accessToken, 'access-new');
    assert.strictEqual(after.refreshToken, 'refresh-new');
    assert.strictEqual(after.expiresAt, NOW + 28_800_000);

    // The half that is not ours. Dropping these would not fail a poll, it would
    // quietly degrade whatever Claude Code reads them for.
    assert.deepStrictEqual(after.scopes, ['user:inference', 'user:profile']);
    assert.strictEqual(after.subscriptionType, 'max');
    assert.strictEqual(after.rateLimitTier, 'default_claude_max_20x');
    assert.strictEqual(after.refreshTokenExpiresAt, NOW + 2_000_000);
  });

  it('stores the refresh expiry the server states, rather than keeping the old one', async () => {
    // The reader decides "renewable" against this field, so a value carried
    // forward from an earlier grant is how it silently goes stale. The live
    // endpoint returns roughly the same instant each time, which is exactly why
    // an inferred value would look correct until the day it stopped being.
    const h = harness({
      file: storedCredential(),
      respond: () =>
        jsonResponse(200, {
          access_token: 'access-new',
          refresh_token: 'refresh-new',
          expires_in: 28_800,
          refresh_token_expires_in: 2_515_732,
        }),
    });

    assert.strictEqual(await h.refresher.refresh(), true);
    assert.strictEqual(h.read().refreshTokenExpiresAt, NOW + 2_515_732_000);
  });

  it('sends the grant Claude Code sends, to the endpoint it sends it to', async () => {
    const h = harness({ file: storedCredential() });
    await h.refresher.refresh();

    assert.strictEqual(h.requests.length, 1);
    const [request] = h.requests;
    assert.strictEqual(request.url, 'https://platform.claude.com/v1/oauth/token');
    assert.strictEqual(request.body.grant_type, 'refresh_token');
    assert.strictEqual(request.body.refresh_token, 'refresh-old');
    assert.strictEqual(request.body.client_id, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    assert.strictEqual(request.headers['anthropic-beta'], 'oauth-2025-04-20');
  });

  it('never identifies as Claude Code to the token endpoint', () => {
    // Not cosmetic. `platform.claude.com` refuses a `claude-code/*` agent at the
    // edge with a 429 and no request id, so renewal fails in a way that reads as
    // rate limiting and costs a full token lifetime to notice. The usage
    // endpoint demands the opposite, which is exactly why sharing one agent
    // between them is the mistake this guards.
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'src/auth/credentialRefresher.ts'),
      'utf8',
    );

    assert.ok(
      !/['"`]claude-code\//.test(source),
      'the refresher must not send a claude-code user agent',
    );
    assert.ok(
      !/ClientVersion/.test(source),
      'the usage endpoint agent must not be reused here',
    );
  });

  it('sends our own name, so a block is legible rather than silent', async () => {
    const h = harness({ file: storedCredential() });
    await h.refresher.refresh();

    assert.match(h.requests[0].headers['User-Agent'], /^claude-usage-graph/);
  });

  it('keeps the old refresh token when the response does not rotate it', async () => {
    // Reading the absence as a blank would write an empty refresh token, which
    // is exactly what a signed-out store looks like to the reader.
    const h = harness({
      file: storedCredential(),
      respond: () => jsonResponse(200, { access_token: 'access-new', expires_in: 3600 }),
    });

    assert.strictEqual(await h.refresher.refresh(), true);
    assert.strictEqual(h.read().refreshToken, 'refresh-old');
    assert.strictEqual(h.read().accessToken, 'access-new');
  });

  it('leaves the file byte-for-byte untouched when the server refuses', async () => {
    const before = storedCredential();
    const h = harness({ file: before, respond: () => jsonResponse(400, { error: 'invalid_grant' }) });

    assert.strictEqual(await h.refresher.refresh(), false);
    assert.strictEqual(h.raw(), before);
  });

  it('removes the empty temp file when the request fails, so nothing looks recoverable', async () => {
    // The one deletion the design allows. A zero-byte file that a log invited
    // somebody to rename over their credentials would be the sign-out this class
    // exists to prevent.
    const h = harness({
      file: storedCredential(),
      respond: () => Promise.reject(new Error('offline')),
    });

    assert.strictEqual(await h.refresher.refresh(), false);
    assert.deepStrictEqual(h.temps(), []);
    assert.strictEqual(h.raw(), storedCredential());
  });

  it('rejects a response with no usable expiry rather than storing a guess', async () => {
    const h = harness({
      file: storedCredential(),
      respond: () => jsonResponse(200, { access_token: 'access-new' }),
    });

    assert.strictEqual(await h.refresher.refresh(), false);
    assert.strictEqual(h.read().accessToken, 'access-old');
    assert.deepStrictEqual(h.temps(), []);
  });

  it('keeps the temp file and names it when the credential cannot be moved into place', async () => {
    // A directory cannot be replaced by a rename, which stands in for the
    // Windows contention this survives in the field. The read is stubbed because
    // the destination has to be unreadable *and* the source has to parse, which
    // one path on disk cannot be at once.
    const h = harness({ file: storedCredential(), readFile: () => Promise.resolve(storedCredential()) });
    fs.rmSync(h.target);
    fs.mkdirSync(h.target);

    assert.strictEqual(await h.refresher.refresh(), false);

    const [temp] = h.temps();
    assert.ok(temp !== undefined, 'the only copy of the new credential must survive');

    // It has to be a complete credential, because the log tells a human to
    // rename it over theirs.
    const rescued = JSON.parse(
      fs.readFileSync(path.join(h.home, '.claude', temp), 'utf8'),
    ) as { claudeAiOauth: Record<string, unknown> };
    assert.strictEqual(rescued.claudeAiOauth.accessToken, 'access-new');
    assert.strictEqual(rescued.claudeAiOauth.subscriptionType, 'max');

    assert.ok(h.logger.text().includes(temp), 'the log must name the file to rename');
  });

  it('spends nothing when there is no refresh token to spend', async () => {
    const h = harness({ file: storedCredential({ refreshToken: '' }) });

    assert.strictEqual(await h.refresher.refresh(), false);
    assert.deepStrictEqual(h.requests, []);
  });

  it('makes no request when the store is missing or unreadable', async () => {
    const missing = harness({});
    assert.strictEqual(await missing.refresher.refresh(), false);
    assert.deepStrictEqual(missing.requests, []);

    const garbage = harness({ file: 'not json at all' });
    assert.strictEqual(await garbage.refresher.refresh(), false);
    assert.deepStrictEqual(garbage.requests, []);
  });

  it('declines on macOS instead of writing a file the keychain does not read', async () => {
    const logger = new RecordingLogger();
    const refresher = new CredentialRefresher(clock, logger, {
      platform: 'darwin',
      homeDir: os.tmpdir(),
      fetch: (() => Promise.reject(new Error('must not be called'))) as unknown as typeof fetch,
    });

    assert.strictEqual(await refresher.refresh(), false);
    assert.ok(/keychain/i.test(logger.text()), logger.text());
  });

  // Claude Code renewing at the same instant, which the read-back sees as a file
  // that is no longer the one we renamed into place. Whether that is success
  // turns entirely on what the other process left behind, and the two cases must
  // not be collapsed.
  describe('when another process rewrites the store first', () => {
    /** Serves the stored file, then whatever the other process left. */
    function racing(second: string): CredentialRefresher {
      const logger = new RecordingLogger();
      let reads = 0;
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cug-race-'));
      // The rename still happens for real; only what is read back is staged.
      fs.mkdirSync(path.join(home, '.claude'));
      return new CredentialRefresher(clock, logger, {
        platform: 'linux',
        homeDir: home,
        fetch: (() => okResponse()) as unknown as typeof fetch,
        readFile: () => {
          reads += 1;
          return Promise.resolve(reads === 1 ? storedCredential() : second);
        },
      });
    }

    it('accepts a credential the other process renewed', async () => {
      // Its token is as good as ours. Calling this a failure would start a
      // half-hour cooldown over a store that is perfectly healthy.
      const refresher = racing(
        storedCredential({ accessToken: 'access-theirs', expiresAt: NOW + 9_000_000 }),
      );

      assert.strictEqual(await refresher.refresh(), true);
    });

    it('refuses a credential the other process blanked', async () => {
      // Claude Code empties this section rather than deleting it when it refuses
      // a renewal. Reading that as success would poll a login that is gone.
      const refresher = racing(storedCredential({ accessToken: '', refreshToken: '', expiresAt: 0 }));

      assert.strictEqual(await refresher.refresh(), false);
    });
  });
});
