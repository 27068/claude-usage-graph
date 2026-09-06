// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { IClock, ICredentialStore, ILogger } from '../core/interfaces';
import type { CredentialResult, Millis } from '../core/types';

/**
 * Reads the OAuth access token Claude Code already maintains.
 *
 * This class deliberately has exactly one public method. There is no refresh, no
 * write, and no token of our own: the *absence* of those code paths is the
 * guarantee that a bug here can never corrupt someone's Claude Code login, and
 * the reason no refresh-token rotation race is possible.
 *
 * Renewal is entirely Claude Code's job. We re-read on every poll, so whenever
 * it refreshes we pick the new token up on the next tick for free.
 */

/** Treat a token as expired slightly early so it cannot die mid-request. */
export const EXPIRY_SKEW_MS = 60_000;

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export interface CredentialSourceOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Reads the credentials file. Must reject with ENOENT when absent. */
  readFile?: (target: string) => Promise<string>;
  /** Reads the macOS keychain entry. */
  readKeychain?: () => Promise<string>;
}

export class CredentialReader implements ICredentialStore {
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly readFile: (target: string) => Promise<string>;
  private readonly readKeychain: () => Promise<string>;

  constructor(
    private readonly clock: IClock,
    private readonly logger: ILogger,
    options: CredentialSourceOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? os.homedir();
    this.readFile = options.readFile ?? ((target) => fs.readFile(target, 'utf8'));
    this.readKeychain = options.readKeychain ?? defaultKeychainReader;
  }

  async read(): Promise<CredentialResult> {
    let raw: string;
    try {
      raw = this.platform === 'darwin' ? await this.readKeychain() : await this.readFile(this.credentialsPath());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== undefined && code !== 'ENOENT') {
        this.logger.warn(`Could not read Claude Code credentials: ${String(error)}`);
      }
      return { state: 'missing' };
    }

    return this.parse(raw);
  }

  private credentialsPath(): string {
    return path.join(this.homeDir, '.claude', '.credentials.json');
  }

  private parse(raw: string): CredentialResult {
    const text = decodeIfHex(raw.trim());

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { state: 'malformed', reason: 'credential store is not valid JSON' };
    }

    const oauth = (parsed as { claudeAiOauth?: unknown })?.claudeAiOauth;
    if (typeof oauth !== 'object' || oauth === null) {
      return { state: 'malformed', reason: 'no claudeAiOauth section' };
    }

    const { accessToken, expiresAt, refreshTokenExpiresAt } = oauth as {
      accessToken?: unknown;
      expiresAt?: unknown;
      refreshTokenExpiresAt?: unknown;
    };
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return { state: 'malformed', reason: 'no access token' };
    }
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      return { state: 'malformed', reason: 'no expiry' };
    }

    const expiry = normalizeExpiry(expiresAt);
    if (expiry - EXPIRY_SKEW_MS <= this.clock.now()) {
      // An absent refresh expiry is treated as renewable. Getting this wrong in
      // that direction costs one CLI start; the other direction puts a sign-in
      // prompt in front of somebody who is already signed in.
      const refreshExpiry =
        typeof refreshTokenExpiresAt === 'number' && Number.isFinite(refreshTokenExpiresAt)
          ? normalizeExpiry(refreshTokenExpiresAt)
          : undefined;
      const renewable = refreshExpiry === undefined || refreshExpiry > this.clock.now();
      return { state: renewable ? 'stale' : 'signed-out', expiresAt: expiry };
    }

    return { state: 'ok', token: accessToken, expiresAt: expiry };
  }
}

/**
 * Claude Code has stored this value as seconds in some versions and
 * milliseconds in others. Anything below this threshold cannot be a plausible
 * millisecond timestamp, so it must be seconds.
 */
function normalizeExpiry(value: number): Millis {
  return value < 1e12 ? value * 1000 : value;
}

/** The macOS keychain entry has been observed both as raw JSON and hex-encoded. */
function decodeIfHex(value: string): string {
  if (value.length < 2 || value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) {
    return value;
  }
  try {
    return Buffer.from(value, 'hex').toString('utf8');
  } catch {
    return value;
  }
}

function defaultKeychainReader(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', os.userInfo().username, '-w'],
      (error, stdout) => {
        if (error) {
          // `security` exits non-zero when the item is absent; treat that the
          // same as a missing file so callers have one "not signed in" path.
          reject(Object.assign(error, { code: 'ENOENT' }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
