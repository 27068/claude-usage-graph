// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import {
  CLAUDE_CODE_REFRESH_BAND_MS,
  CredentialReader,
  EXPIRY_SKEW_MS,
} from '../../auth/credentialReader';
import { POLL_INTERVAL_MS } from '../../core/usageEngine';
import { FakeClock, RecordingLogger } from './helpers';

const NOW = 1_770_400_800_000;
const HOUR = 3_600_000;

function store(payload: unknown): string {
  return JSON.stringify(payload);
}

function validPayload(expiresAt: number) {
  return {
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-example',
      refreshToken: 'sk-ant-ort01-example',
      expiresAt,
      scopes: ['user:inference'],
    },
  };
}

function withRefreshExpiry(expiresAt: number, refreshTokenExpiresAt: number) {
  return {
    claudeAiOauth: { ...validPayload(expiresAt).claudeAiOauth, refreshTokenExpiresAt },
  };
}

function readerFor(contents: string | Error, platform: NodeJS.Platform = 'win32') {
  const clock = new FakeClock(NOW);
  const logger = new RecordingLogger();
  const reader = new CredentialReader(clock, logger, {
    platform,
    homeDir: '/home/test',
    readFile: async () => {
      if (contents instanceof Error) {
        throw contents;
      }
      return contents;
    },
    readKeychain: async () => {
      if (contents instanceof Error) {
        throw contents;
      }
      return contents;
    },
  });
  return { reader, clock, logger };
}

function missingError(): Error {
  return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

describe('CredentialReader', () => {
  it('returns a valid token', async () => {
    const { reader } = readerFor(store(validPayload(NOW + 8 * HOUR)));
    const result = await reader.read();

    assert.strictEqual(result.state, 'ok');
    assert.strictEqual(result.state === 'ok' && result.token, 'sk-ant-oat01-example');
  });

  // Claude Code keeps one credential store and picks it by platform, so a
  // successful write to Windows Credential Manager deletes the file. The account
  // in `~/.claude.json` is the only local thing left that separates that from a
  // real sign-out, and the two need opposite messages: one has an action, the
  // other has none.
  describe('when the credential file is absent', () => {
    function readerWithConfig(config: string | Error) {
      const logger = new RecordingLogger();
      const reader = new CredentialReader(new FakeClock(NOW), logger, {
        platform: 'win32',
        homeDir: '/home/test',
        readFile: async (target: string) => {
          if (target.endsWith('.claude.json')) {
            if (config instanceof Error) {
              throw config;
            }
            return config;
          }
          throw missingError();
        },
      });
      return { reader, logger };
    }

    it('reads a configured account as signed in somewhere unreadable', async () => {
      const { reader } = readerWithConfig(
        JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com' } }),
      );

      assert.deepStrictEqual(await reader.read(), { state: 'unreadable' });
    });

    it('reads no account as genuinely signed out', async () => {
      const { reader } = readerWithConfig(JSON.stringify({ hasCompletedOnboarding: true }));

      assert.deepStrictEqual(await reader.read(), { state: 'missing' });
    });

    it('asks for a sign-in when the config cannot be read either', async () => {
      // An instruction that may be redundant beats none: claiming the credential
      // is unreadable would leave somebody with nothing at all to try.
      const { reader } = readerWithConfig(missingError());

      assert.deepStrictEqual(await reader.read(), { state: 'missing' });
    });
  });

  it('reports a missing credential store rather than throwing', async () => {
    const { reader, logger } = readerFor(missingError());

    assert.deepStrictEqual(await reader.read(), { state: 'missing' });
    assert.deepStrictEqual(logger.warns, [], 'an absent file is normal, not a warning');
  });

  // `validPayload` carries no `refreshTokenExpiresAt`, so this is also the case
  // where Claude Code has not written that field: absent must read as renewable.
  // Guessing "signed out" here would put a sign-in prompt in front of somebody
  // who is signed in; guessing this way costs one CLI start that finds nothing.
  it('reports an expired token without attempting anything else', async () => {
    const { reader } = readerFor(store(validPayload(NOW - HOUR)));
    const result = await reader.read();

    assert.strictEqual(result.state, 'stale');
  });

  it('separates a renewable token from a login that is actually over', async () => {
    // The same expired access token twice. Only the refresh expiry differs, and
    // it is the whole difference between "wait" and "go and sign in".
    const live = readerFor(store(withRefreshExpiry(NOW - HOUR, NOW + 20 * 24 * HOUR)));
    assert.strictEqual((await live.reader.read()).state, 'stale');

    const dead = readerFor(store(withRefreshExpiry(NOW - HOUR, NOW - HOUR)));
    assert.strictEqual((await dead.reader.read()).state, 'signed-out');
  });

  it('renews early enough to finish before Claude Code would start', () => {
    // The latest we can act is one interval after the window opens, and that
    // must land before Claude Code's own pre-emptive band — otherwise both of us
    // redeem the same refresh token, and a server that treats reuse as theft
    // signs the user out. Moving the interval or the band without moving the
    // skew reintroduces that silently, which is the only reason this is asserted
    // rather than left to the comment beside the constant.
    const latestRenewal = EXPIRY_SKEW_MS - POLL_INTERVAL_MS;

    assert.ok(
      latestRenewal > CLAUDE_CODE_REFRESH_BAND_MS,
      `worst-case renewal is ${latestRenewal}ms before expiry, inside Claude Code's ` +
        `${CLAUDE_CODE_REFRESH_BAND_MS}ms band`,
    );
  });

  it('treats a token inside the skew window as already expired', async () => {
    const { reader } = readerFor(store(validPayload(NOW + EXPIRY_SKEW_MS - 1)));
    assert.strictEqual((await reader.read()).state, 'stale');
  });

  it('accepts a token just outside the skew window', async () => {
    const { reader } = readerFor(store(validPayload(NOW + EXPIRY_SKEW_MS + 1000)));
    assert.strictEqual((await reader.read()).state, 'ok');
  });

  it('picks the token up again once Claude Code renews it', async () => {
    const clock = new FakeClock(NOW);
    const logger = new RecordingLogger();
    let contents = store(validPayload(NOW - HOUR));

    const reader = new CredentialReader(clock, logger, {
      platform: 'linux',
      homeDir: '/home/test',
      readFile: async () => contents,
    });

    assert.strictEqual((await reader.read()).state, 'stale');

    // Claude Code refreshes; we notice on the very next read with no action of
    // our own. This is the entire renewal mechanism.
    contents = store(validPayload(NOW + 8 * HOUR));
    assert.strictEqual((await reader.read()).state, 'ok');
  });

  it('accepts a seconds-based expiry as well as milliseconds', async () => {
    const { reader } = readerFor(store(validPayload(Math.floor((NOW + 8 * HOUR) / 1000))));
    assert.strictEqual((await reader.read()).state, 'ok');
  });

  it('decodes a hex-encoded keychain payload on macOS', async () => {
    const hex = Buffer.from(store(validPayload(NOW + 8 * HOUR)), 'utf8').toString('hex');
    const { reader } = readerFor(hex, 'darwin');

    const result = await reader.read();
    assert.strictEqual(result.state, 'ok');
  });

  it('accepts a plain JSON keychain payload on macOS', async () => {
    const { reader } = readerFor(store(validPayload(NOW + 8 * HOUR)), 'darwin');
    assert.strictEqual((await reader.read()).state, 'ok');
  });

  it('reports malformed contents distinctly from missing ones', async () => {
    for (const [contents, label] of [
      ['not json at all', 'invalid JSON'],
      [store({}), 'no oauth section'],
      [store({ claudeAiOauth: { accessToken: 'x' } }), 'no expiry'],
    ] as const) {
      const { reader } = readerFor(contents);
      const result = await reader.read();
      assert.strictEqual(result.state, 'malformed', `${label} should be malformed`);
    }
  });

  // What a refusal Claude Code will not renew actually leaves on disk: the keys
  // are all still there, emptied. Reading that as damage rather than as a signed
  // out login tells somebody their store is broken when all they need is
  // `claude`, and it stays wrong until they sign in for unrelated reasons.
  it('reads a store Claude Code cleared as signed out, not as damage', async () => {
    for (const [contents, label] of [
      [
        store({
          claudeAiOauth: {
            accessToken: '',
            refreshToken: '',
            expiresAt: 0,
            refreshTokenExpiresAt: 0,
            scopes: [],
          },
        }),
        'cleared by a refused renewal',
      ],
      [store({ claudeAiOauth: {} }), 'emptied section'],
      [
        store({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: NOW + HOUR } }),
        'tokens blanked, expiry left alone',
      ],
    ] as const) {
      const { reader } = readerFor(contents);
      assert.strictEqual((await reader.read()).state, 'signed-out', `${label} should be signed out`);
    }
  });

  // The other half of the same read: a blank access token beside a refresh token
  // that is still good is Claude Code mid-renewal, and waiting is the answer.
  it('waits on a blank access token while the refresh token still lives', async () => {
    const { reader } = readerFor(
      store({
        claudeAiOauth: {
          accessToken: '',
          refreshToken: 'sk-ant-ort01-example',
          expiresAt: 0,
          refreshTokenExpiresAt: NOW + 28 * 24 * HOUR,
        },
      }),
    );

    assert.strictEqual((await reader.read()).state, 'stale');
  });

  it('warns on an unreadable store but still degrades cleanly', async () => {
    const { reader, logger } = readerFor(Object.assign(new Error('denied'), { code: 'EACCES' }));

    assert.deepStrictEqual(await reader.read(), { state: 'missing' });
    assert.strictEqual(logger.warns.length, 1, 'a permission error is worth surfacing');
  });

  // The read-only guarantee is structural, not a comment. If someone ever adds a
  // write path to this class, this fails.
  it('exposes no method that could modify the credential store', () => {
    const surface = Object.getOwnPropertyNames(CredentialReader.prototype);
    const forbidden = surface.filter((name) => /write|save|refresh|update|set|delete/i.test(name));

    assert.deepStrictEqual(forbidden, [], `unexpected mutating methods: ${forbidden.join(', ')}`);
    assert.deepStrictEqual(
      surface.filter((name) => name !== 'constructor' && !name.startsWith('_')).sort(),
      ['accountConfigured', 'configPath', 'credentialsPath', 'parse', 'read'],
      'the public surface should stay minimal',
    );
  });
});
