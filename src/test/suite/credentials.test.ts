// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { CredentialReader, EXPIRY_SKEW_MS } from '../../auth/credentialReader';
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

  it('reports a missing credential store rather than throwing', async () => {
    const { reader, logger } = readerFor(missingError());

    assert.deepStrictEqual(await reader.read(), { state: 'missing' });
    assert.deepStrictEqual(logger.warns, [], 'an absent file is normal, not a warning');
  });

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

  it('treats an absent refresh expiry as renewable', async () => {
    // Claude Code has not always written the field. Guessing "signed out" here
    // would put a sign-in prompt in front of someone who is signed in; guessing
    // the other way costs one CLI start that finds nothing to do.
    const { reader } = readerFor(store(validPayload(NOW - HOUR)));
    assert.strictEqual((await reader.read()).state, 'stale');
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
      [store({ claudeAiOauth: {} }), 'no token'],
      [store({ claudeAiOauth: { accessToken: 'x' } }), 'no expiry'],
      [store({ claudeAiOauth: { accessToken: '', expiresAt: NOW + HOUR } }), 'empty token'],
    ] as const) {
      const { reader } = readerFor(contents);
      const result = await reader.read();
      assert.strictEqual(result.state, 'malformed', `${label} should be malformed`);
    }
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
      ['credentialsPath', 'parse', 'read'],
      'the public surface should stay minimal',
    );
  });
});
