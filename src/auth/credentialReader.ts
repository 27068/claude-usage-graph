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
 * One public method, no write path and no network call. Renewal lives next door
 * in `credentialRefresher.ts`, and the separation is the point: every poll comes
 * through here and only an expired credential goes there, so nothing on the
 * common path can disturb a login however it fails.
 *
 * Re-read on every poll rather than cached, so a token renewed by anyone — this
 * extension, a terminal, another window — is picked up on the next tick.
 */

/**
 * Claude Code's own pre-emptive refresh band, read from the shipped binary.
 *
 * Its token provider renews in the background once a token has under two
 * minutes left, and synchronously under thirty seconds — but only when
 * something asks it for a token, never on a timer. So this is the window in
 * which an active Claude Code may rotate the credential out from under a
 * redemption we have already started.
 */
export const CLAUDE_CODE_REFRESH_BAND_MS = 120_000;

/**
 * How early a token is treated as expired.
 *
 * Two constraints set this, and neither is the request timeout — the request is
 * never the binding constraint:
 *
 *  - **Longer than one poll.** The interval decides when we next get to act at
 *    all, so a shorter skew is simply stepped over: a poll lands while the token
 *    still reads fresh, and the next chance to notice arrives after it has
 *    genuinely expired.
 *  - **Finished before Claude Code's band opens.** The latest we can renew is
 *    one interval after the window opens, so that moment must still fall before
 *    `CLAUDE_CODE_REFRESH_BAND_MS`. Otherwise both of us can redeem the same
 *    refresh token at once, and a server that treats reuse as theft revokes the
 *    family and signs the user out.
 *
 * So: one poll interval, plus Claude Code's band, plus a minute of slack. Six
 * minutes, worst case renewing three minutes before expiry and a minute before
 * the band. It costs 1.25% of an eight-hour token. `credentials.test.ts` asserts
 * the arithmetic rather than trusting this comment to survive a constant moving.
 */
export const EXPIRY_SKEW_MS = 360_000;

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
      return (await this.accountConfigured()) ? { state: 'unreadable' } : { state: 'missing' };
    }

    return this.parse(raw);
  }

  /**
   * Whether Claude Code has an account signed in, asked without the credential.
   *
   * `~/.claude.json` records the account — an address, a user id, an org — and no
   * token at all, so it survives wherever the credential itself went. It is the
   * only local evidence separating "nobody is signed in" from "signed in, stored
   * somewhere unreadable", and those two need opposite messages.
   *
   * It cannot say whether that login is still current: the expiry is inside the
   * credential nobody here can read. The message is worded to claim only what
   * this establishes.
   *
   * Read only when the credential is already absent, so the common path still
   * touches one file. Any failure answers no, which asks for a sign-in that is
   * at worst redundant — a wrong yes would leave somebody with no action at all.
   */
  private async accountConfigured(): Promise<boolean> {
    try {
      const parsed = JSON.parse(await this.readFile(this.configPath())) as {
        oauthAccount?: unknown;
      };
      return typeof parsed.oauthAccount === 'object' && parsed.oauthAccount !== null;
    } catch {
      return false;
    }
  }

  private credentialsPath(): string {
    return path.join(this.homeDir, '.claude', '.credentials.json');
  }

  private configPath(): string {
    return path.join(this.homeDir, '.claude.json');
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

    const { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt } = oauth as {
      accessToken?: unknown;
      refreshToken?: unknown;
      expiresAt?: unknown;
      refreshTokenExpiresAt?: unknown;
    };

    const expiry =
      typeof expiresAt === 'number' && Number.isFinite(expiresAt)
        ? normalizeExpiry(expiresAt)
        : undefined;

    const access = typeof accessToken === 'string' ? accessToken : '';
    const hasAccess = access.length > 0;
    const hasRefresh = typeof refreshToken === 'string' && refreshToken.length > 0;

    // Claude Code empties this section rather than deleting it when it refuses a
    // renewal: blank tokens and a zeroed expiry, every key still in place. With
    // neither token there is nothing left to renew from, whatever the expiries
    // claim, so this is a login signed out and not a store that cannot be read.
    // The difference is the whole message — one sends somebody to `claude`, the
    // other after a corruption that is not there.
    if (!hasAccess && !hasRefresh) {
      return { state: 'signed-out', expiresAt: expiry ?? 0 };
    }

    // A blank access token beside a refresh token that is still there is Claude
    // Code between tokens, which is the same wait as an expired one.
    if (!hasAccess) {
      return {
        state: renewable(refreshTokenExpiresAt, this.clock.now()) ? 'stale' : 'signed-out',
        expiresAt: expiry ?? 0,
      };
    }

    if (expiry === undefined) {
      return { state: 'malformed', reason: 'no expiry' };
    }

    if (expiry - EXPIRY_SKEW_MS <= this.clock.now()) {
      return {
        state: renewable(refreshTokenExpiresAt, this.clock.now()) ? 'stale' : 'signed-out',
        expiresAt: expiry,
      };
    }

    return { state: 'ok', token: access, expiresAt: expiry };
  }
}

/**
 * Whether Claude Code can still renew a credential it holds a refresh token for.
 *
 * An absent refresh expiry counts as renewable. Getting this wrong in that
 * direction costs one CLI start; the other direction puts a sign-in prompt in
 * front of somebody who is already signed in.
 */
function renewable(refreshTokenExpiresAt: unknown, now: Millis): boolean {
  if (typeof refreshTokenExpiresAt !== 'number' || !Number.isFinite(refreshTokenExpiresAt)) {
    return true;
  }
  return normalizeExpiry(refreshTokenExpiresAt) > now;
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
