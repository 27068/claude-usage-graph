// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { IClock, ICredentialRefresher, ILogger } from '../core/interfaces';

/**
 * Renews Claude Code's access token by redeeming its refresh token directly.
 *
 * **The only thing that can cost a login is the gap between the server issuing a
 * new token pair and that pair being durably on disk.** Everything else is
 * ordered around it: work before the request is free, and so is work after the
 * flush. Judge any change here by what it adds between those two points.
 *
 * Safe while Claude Code is running, which it always is. It re-reads this file
 * and checks the expiry before building a grant of its own, so a rotation
 * written here propagates rather than racing, and concurrent redemptions do not
 * collide. Nothing is locked: a blocked read of a credential store does not
 * queue, it fails, and inducing an untested error path in someone else's auth
 * code is the worse trade.
 *
 * Why this does not spawn the CLI instead: `docs/DECISIONS.md`, section 2.
 */

const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

/**
 * Claude Code's own OAuth client, read from the shipped binary beside the token
 * URL above. The neighbouring identities in that config are not
 * interchangeable: one belongs to a local development build and one to Claude
 * Design.
 */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const OAUTH_BETA = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * **This must not identify as Claude Code**, which is the exact opposite of the
 * rule on the usage endpoint, and the two are on different hosts for that
 * reason. `platform.claude.com` refuses a Claude Code user agent at
 * Cloudflare's edge with a 429 and no request id, so the redemption never
 * reaches the application at all — it looks like rate limiting and is not, which
 * costs a night of expired token before anyone works it out. Our own name is
 * accepted, so there is nothing to gain by impersonating anything here.
 */
const DEFAULT_USER_AGENT = 'claude-usage-graph';

/** Windows fails a rename onto an open path; a scanner's grip is momentary. */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);
const RENAME_ATTEMPTS = 5;

/** The credential file is the user's alone, and the temp file becomes it. */
const OWNER_ONLY = 0o600;

let sequence = 0;

interface Grant {
  accessToken: string;
  /** Absent when the server keeps the caller on the refresh token it sent. */
  refreshToken: string | undefined;
  expiresInMs: number;
  /**
   * How long the *refresh* token has left, when the server says.
   *
   * Observed to be anchored to the original grant rather than extended on
   * rotation, so storing it changes nothing today. It is stored anyway because
   * the reader decides "renewable" against this field, and inferring a value the
   * server is willing to state is how that quietly goes stale.
   */
  refreshExpiresInMs: number | undefined;
}

export interface CredentialRefresherOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  fetch?: typeof fetch;
  /** Ours. Never a Claude Code agent string — see `DEFAULT_USER_AGENT`. */
  userAgent?: string;
  /**
   * Reads the credential store. Injected only so a test can rewrite the file
   * between the rename and the read-back, which is a real race with Claude Code
   * and cannot be staged from outside this process.
   */
  readFile?: (target: string) => Promise<string>;
}

export class CredentialRefresher implements ICredentialRefresher {
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly fetch: typeof fetch;
  private readonly userAgent: string;
  private readonly readFile: (target: string) => Promise<string>;

  constructor(
    private readonly clock: IClock,
    private readonly logger: ILogger,
    options: CredentialRefresherOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? os.homedir();
    this.fetch = options.fetch ?? ((...args) => fetch(...args));
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.readFile = options.readFile ?? ((target) => fs.readFile(target, 'utf8'));
  }

  /**
   * True only when a renewed credential is on disk and reads back renewed.
   *
   * Never throws, and never reports success from the response alone. The engine
   * puts a half-hour cooldown behind a false, so a wrong true is the expensive
   * direction: it would keep polling a token that is not there.
   */
  async refresh(): Promise<boolean> {
    // macOS keeps this credential in the keychain rather than a file, so the
    // temp-file-and-rename this is built on has nothing to rename. Renewal there
    // stays Claude Code's job, exactly as it is today.
    if (this.platform === 'darwin') {
      this.logger.info('Not renewing: the credential lives in the macOS keychain, not a file.');
      return false;
    }

    const target = this.credentialsPath();

    // Everything up to the request is free, so all of it happens here: reading,
    // parsing, checking there is a grant worth spending, and creating the file
    // the new one will land in. Directory entry, permissions, and whatever a
    // scanner does on first touch are all paid for while the old token is still
    // good.
    const document = await this.readDocument(target);
    if (document === undefined) {
      return false;
    }

    const previousRefreshToken = document.oauth.refreshToken;
    if (typeof previousRefreshToken !== 'string' || previousRefreshToken.length === 0) {
      this.logger.warn('Not renewing: the credential holds no refresh token to redeem.');
      return false;
    }

    sequence += 1;
    const temporary = `${target}.${process.pid}.${sequence}.tmp`;

    let handle: FileHandle;
    try {
      handle = await fs.open(temporary, 'w', OWNER_ONLY);
    } catch (error) {
      this.logger.warn(`Not renewing: could not create ${temporary}: ${String(error)}`);
      return false;
    }

    let expiresAt = 0;
    let written = false;
    // Both expiries are measured from here, before the request, rather than
    // from whenever the reply lands. The server states a duration and not an
    // instant — RFC 6749, so a client with a wrong clock still works — which
    // means our own round trip is added to whatever we compute. Taking the
    // earlier bound makes each rotation err towards expiring early, and early is
    // the only safe direction: it costs one premature renewal, where late means
    // presenting a token the server has already retired.
    const issuedAt = this.clock.now();

    try {
      const grant = await this.redeem(previousRefreshToken);

      // The window opens above and closes at the flush below. Substitution and
      // serialisation only — anything else added between these lines is added
      // to the one interval where a crash costs the user a sign-in.
      document.oauth.accessToken = grant.accessToken;
      document.oauth.refreshToken = grant.refreshToken ?? previousRefreshToken;
      expiresAt = issuedAt + grant.expiresInMs;
      document.oauth.expiresAt = expiresAt;
      if (grant.refreshExpiresInMs !== undefined) {
        document.oauth.refreshTokenExpiresAt = issuedAt + grant.refreshExpiresInMs;
      }
      await handle.writeFile(JSON.stringify(document.root), 'utf8');
      await handle.sync();
      written = true;
    } catch (error) {
      this.logger.warn(`Renewal failed, credential untouched: ${String(error)}`);
      return false;
    } finally {
      await handle.close().catch(() => undefined);
      // The one deletion this class permits, and only because this file is
      // empty: the request failed, so it never held a credential and renaming it
      // over the real one by hand would sign the user out rather than recover
      // them. Once a token has been written, see `rename` — it is kept.
      if (!written) {
        await fs.unlink(temporary).catch(() => undefined);
      }
    }

    if (!(await this.rename(temporary, target))) {
      return false;
    }

    return await this.verify(target, expiresAt);
  }

  private credentialsPath(): string {
    return path.join(this.homeDir, '.claude', '.credentials.json');
  }

  /**
   * The whole file, with the OAuth section picked out of it.
   *
   * The root object is kept rather than a rebuilt one because three of its
   * fields are ours to change and the rest are Claude Code's — scopes, the
   * subscription, the rate limit tier, the refresh token's own expiry. Writing
   * back only what this codebase understands would quietly drop whatever the
   * next release adds.
   */
  private async readDocument(
    target: string,
  ): Promise<{ root: unknown; oauth: Record<string, unknown> } | undefined> {
    let raw: string;
    try {
      raw = await this.readFile(target);
    } catch (error) {
      this.logger.warn(`Not renewing: could not read the credential store: ${String(error)}`);
      return undefined;
    }

    let root: unknown;
    try {
      root = JSON.parse(raw);
    } catch {
      this.logger.warn('Not renewing: the credential store is not valid JSON.');
      return undefined;
    }

    const oauth = (root as { claudeAiOauth?: unknown })?.claudeAiOauth;
    if (typeof oauth !== 'object' || oauth === null) {
      this.logger.warn('Not renewing: the credential store has no claudeAiOauth section.');
      return undefined;
    }

    return { root, oauth: oauth as Record<string, unknown> };
  }

  /** POST the grant. Throws on anything that is not a usable token pair. */
  private async redeem(refreshToken: string): Promise<Grant> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-beta': OAUTH_BETA,
          'User-Agent': this.userAgent,
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // The body is not logged. It is an OAuth error document on a bad day and
        // a token on a good one, and this line is the one most likely to be
        // pasted into an issue.
        throw new Error(`the token endpoint returned ${response.status}`);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const accessToken = payload.access_token;
      const expiresIn = Number(payload.expires_in);
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new Error('the token endpoint returned no access token');
      }
      if (!Number.isFinite(expiresIn)) {
        throw new Error('the token endpoint returned no usable expires_in');
      }

      // A response that omits `refresh_token` leaves the caller on the one it
      // already holds. Reading the absence as a blank would write an empty
      // refresh token, which is what a signed-out store looks like.
      const rotated = payload.refresh_token;
      const refreshExpiresIn = Number(payload.refresh_token_expires_in);
      return {
        accessToken,
        refreshToken: typeof rotated === 'string' && rotated.length > 0 ? rotated : undefined,
        expiresInMs: expiresIn * 1000,
        refreshExpiresInMs: Number.isFinite(refreshExpiresIn)
          ? refreshExpiresIn * 1000
          : undefined,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Move the finished credential into place, retrying the contention Windows
   * reports and keeping the file whatever happens.
   *
   * The temp file is not scaffolding around the write; it *is* the write, and
   * once a token is in it, it is also the only copy of a grant that has already
   * been spent. So a failure here leaves it on disk and says where — renaming it
   * by hand is a complete recovery, and deleting it would be the sign-out this
   * whole class exists to avoid.
   */
  private async rename(temporary: string, target: string): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temporary, target);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!TRANSIENT_CODES.has(code) || attempt >= RENAME_ATTEMPTS - 1) {
          this.logger.error(
            `The renewed Claude Code credential is complete at ${temporary}, but it could not ` +
              `be moved onto ${target} (${String(error)}). The previous token has already been ` +
              `spent, so rename that file over ${target} to restore the login.`,
          );
          return false;
        }
        await delay(10 * 2 ** attempt);
      }
    }
  }

  /**
   * Read the store back and confirm the renewal is what a reader will find.
   *
   * The response saying yes is not evidence that the file says yes, and this is
   * the one place cheap enough to check: everything here happens after the
   * durable write, so it costs nothing that matters.
   */
  private async verify(target: string, expiresAt: number): Promise<boolean> {
    const document = await this.readDocument(target);
    if (document === undefined) {
      this.logger.error('Renewal was written but the credential store no longer reads back.');
      return false;
    }

    if (document.oauth.expiresAt !== expiresAt) {
      // Another process rewrote the file between the rename and this read. That
      // is Claude Code renewing at the same moment rather than a fault, and its
      // credential is as good as ours — but only if what it left is a token. A
      // rewrite that blanked the section is a sign-out, and calling that success
      // would keep polling a credential that is gone.
      const token = document.oauth.accessToken;
      if (typeof token !== 'string' || token.length === 0) {
        this.logger.error('Renewed, but the store was blanked immediately afterwards.');
        return false;
      }
      this.logger.info('Renewed, and the store was rewritten again before it could be read back.');
      return true;
    }

    this.logger.info(
      `Renewed the Claude Code access token; it now expires at ${new Date(expiresAt).toISOString()}.`,
    );
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
