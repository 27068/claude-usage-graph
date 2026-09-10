// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { IClock, ICredentialRefresher, ILogger } from '../core/interfaces';
import type { Millis, RefreshOutcome } from '../core/types';

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
/** Exported so `tokenTiming.test.ts` can assert the cutoff clears it. */
export const REQUEST_TIMEOUT_MS = 30_000;

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

/**
 * How old an abandoned temp file must be before another process clears it.
 *
 * Comfortably beyond both the request timeout and `POLL_GUARD_MS`, which bounds
 * how long a window may hold the renewal claim. So a file another window is
 * still writing is never old enough to be in range.
 */
const ABANDONED_AFTER_MS = 5 * 60_000;

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

/**
 * A failure carrying what the caller must do about it.
 *
 * Thrown rather than returned because it comes from inside the request, and the
 * one thing that must not grow is the stretch between the server answering and
 * the new pair reaching disk.
 */
class RedemptionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RedemptionError';
  }
}

/**
 * How long to wait when the server names a figure.
 *
 * `Retry-After` is seconds or an HTTP date. Anything unreadable answers
 * undefined, and the caller's own cooldown stands.
 */
function parseRetryAfter(header: string | null, now: Millis): number | undefined {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
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
   * Redeem the refresh token once and say what came of it.
   *
   * Never throws, and never reports success from the response alone. A wrong
   * `renewed` is the expensive direction: it would leave the caller polling a
   * token that is not there.
   *
   * The classification matters as much as the result, and it follows the shape
   * of the file. Anything that fails *before* the request has spent nothing but
   * will not clear in fifteen seconds, so it waits. Anything that fails *after*
   * a token was written has already spent the grant, so it must wait. Only the
   * request itself can fail in a way that leaves the grant untouched and
   * unknown, and only that is worth another rung.
   */
  async refresh(): Promise<RefreshOutcome> {
    // macOS keeps this credential in the keychain rather than a file, so the
    // temp-file-and-rename this is built on has nothing to rename. Renewal there
    // stays Claude Code's job, exactly as it is today.
    if (this.platform === 'darwin') {
      return this.wait('the credential lives in the macOS keychain, not a file');
    }

    const target = this.credentialsPath();

    // Everything up to the request is free, so all of it happens here: reading,
    // parsing, checking there is a grant worth spending, and creating the file
    // the new one will land in. Directory entry, permissions, and whatever a
    // scanner does on first touch are all paid for while the old token is still
    // good.
    const document = await this.readDocument(target);
    if (document === undefined) {
      return this.wait('the credential store could not be read');
    }

    const previousRefreshToken = document.oauth.refreshToken;
    if (typeof previousRefreshToken !== 'string' || previousRefreshToken.length === 0) {
      return this.wait('the credential holds no refresh token to redeem');
    }

    sequence += 1;
    const temporary = `${target}.${process.pid}.${sequence}.tmp`;

    let handle: FileHandle;
    try {
      handle = await fs.open(temporary, 'w', OWNER_ONLY);
    } catch (error) {
      return this.wait(`could not create ${temporary}: ${String(error)}`);
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
      const reason = `renewal failed, credential untouched: ${String(error)}`;
      this.logger.warn(reason);
      const failure = error instanceof RedemptionError ? error : undefined;
      return failure?.retryable === true
        ? { state: 'retry', reason }
        : { state: 'cooldown', reason, retryAfterMs: failure?.retryAfterMs };
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
      // The grant is spent and its replacement is in the temp file. Redeeming
      // again would present a refresh token the server has already retired, so
      // this waits however transient the rename failure looked.
      return { state: 'cooldown', reason: 'the renewed credential could not be moved into place' };
    }

    return await this.verify(target, expiresAt);
  }

  /**
   * Remove temp files left behind by a rename that never landed.
   *
   * **Housekeeping over a shared directory, not a step of `refresh`.** The files
   * found here belong to whoever left them — another window, an older run of
   * this one — and nothing about the renewal in front of you says anything about
   * them. Hanging this off the end of a redemption would tie clearing anyone's
   * file to this process happening to renew.
   *
   * Deleting one where the rename failed is not worth attempting either, because
   * whatever stopped the rename is just as likely to stop the delete. A lock
   * does not last, so this runs later instead, and a failed delete is ignored
   * and met again next time. The process that left a file may well be the one
   * that removes it.
   *
   * Without this they accumulate. A server that answers without rotating the
   * refresh token leaves the old one working, so every attempt redeems, fails
   * the same rename, and keeps another file, each holding a live credential.
   *
   * Age is measured against `Date.now()` rather than the injected clock, because
   * it is compared with an mtime the operating system wrote.
   */
  async sweepAbandoned(): Promise<void> {
    if (this.platform === 'darwin') {
      return;
    }
    const target = this.credentialsPath();
    const directory = path.dirname(target);
    const prefix = `${path.basename(target)}.`;

    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) {
        continue;
      }
      const abandoned = path.join(directory, entry);
      try {
        const stats = await fs.stat(abandoned);
        if (Date.now() - stats.mtimeMs < ABANDONED_AFTER_MS) {
          continue;
        }
        await fs.unlink(abandoned);
        this.logger.info(`Removed an abandoned credential temp file: ${entry}`);
      } catch {
        // Still locked, or already gone. The next renewal to land tries again,
        // which is the whole reason this is not attempted at the point of
        // failure.
      }
    }
  }

  /** A failure that spends nothing and will not clear on the next rung. */
  private wait(reason: string): RefreshOutcome {
    this.logger.warn(`Not renewing: ${reason}.`);
    return { state: 'cooldown', reason };
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

    let response: Response;
    try {
      response = await this.fetch(TOKEN_ENDPOINT, {
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
    } catch (error) {
      // Nothing came back, so nothing is known about the grant and the next rung
      // may as well try. A timeout is treated the same way even though the abort
      // is ours and the server may have rotated regardless: round trips here run
      // to a third of a second against a thirty second bound, so a reply that
      // never arrives is a request that almost certainly never landed. That
      // assumption is deliberate — `docs/DECISIONS.md`, section 2.
      const reason = controller.signal.aborted ? 'timed out' : String(error);
      clearTimeout(timeout);
      throw new RedemptionError(`could not reach the token endpoint: ${reason}`, true);
    }

    try {
      if (!response.ok) {
        throw this.refusal(response);
      }

      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch (error) {
        // A 200 whose body will not parse is an answer, not an absence. It may
        // well have rotated the token, so this must not be tried again.
        throw new RedemptionError(`the token endpoint returned unreadable JSON: ${String(error)}`, false);
      }
      const accessToken = payload.access_token;
      const expiresIn = Number(payload.expires_in);
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new RedemptionError('the token endpoint returned no access token', false);
      }
      if (!Number.isFinite(expiresIn)) {
        throw new RedemptionError('the token endpoint returned no usable expires_in', false);
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
   * What a refusal means for the next rung.
   *
   * Only a server that is temporarily failing is worth retrying. A refused grant
   * refuses again fifteen seconds later, and a fast ladder over it would turn
   * one refusal into seven requests.
   */
  private refusal(response: Response): RedemptionError {
    if (response.status >= 500) {
      return new RedemptionError(`the token endpoint returned ${response.status}`, true);
    }

    if (response.status === 429) {
      // A 429 carrying no request id never reached the application: Cloudflare
      // refused it at the edge over the user agent, which is a blocklist rather
      // than a rate. Neither answer changes on a retry, but they need different
      // words or the next person spends a night reading it as throttling.
      const reachedApp = response.headers.get('request-id') !== null;
      return new RedemptionError(
        reachedApp
          ? 'the token endpoint is rate limiting this client'
          : 'the token endpoint refused this client at the edge, before the application saw it',
        false,
        parseRetryAfter(response.headers.get('retry-after'), this.clock.now()),
      );
    }

    // The body is not logged. It is an OAuth error document on a bad day and a
    // token on a good one, and this line is the one most likely to be pasted
    // into an issue.
    return new RedemptionError(`the token endpoint returned ${response.status}`, false);
  }

  /**
   * Move the finished credential into place, retrying the contention Windows
   * reports and keeping the file whatever happens.
   *
   * The temp file is not scaffolding around the write; it *is* the write, and
   * once a token is in it, it holds the only copy of a credential the server has
   * already issued. So a failure here leaves it on disk and logs where it is.
   *
   * That is not a recovery route in practice, and it is not deleted here either:
   * whatever stopped the rename would probably stop the delete. `sweepAbandoned`
   * clears it from a later renewal, once a rename has been seen to work again.
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
              `be moved onto ${target} (${String(error)}). Claude Code may need signing in ` +
              `again.`,
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
  private async verify(target: string, expiresAt: number): Promise<RefreshOutcome> {
    const document = await this.readDocument(target);
    if (document === undefined) {
      const reason = 'renewal was written but the credential store no longer reads back';
      this.logger.error('Renewal was written but the credential store no longer reads back.');
      return { state: 'cooldown', reason };
    }

    if (document.oauth.expiresAt !== expiresAt) {
      // Another process rewrote the file between the rename and this read. That
      // is Claude Code renewing at the same moment rather than a fault, and its
      // credential is as good as ours — but only if what it left is a token. A
      // rewrite that blanked the section is a sign-out, and calling that success
      // would keep polling a credential that is gone.
      const token = document.oauth.accessToken;
      if (typeof token !== 'string' || token.length === 0) {
        const reason = 'renewed, but the store was blanked immediately afterwards';
        this.logger.error('Renewed, but the store was blanked immediately afterwards.');
        return { state: 'cooldown', reason };
      }
      this.logger.info('Renewed, and the store was rewritten again before it could be read back.');
      // Ours rather than theirs, and only for scheduling. The field on disk is
      // whatever encoding that process chose, and normalising it here would
      // duplicate the reader; the two grants are seconds apart in any case, and
      // the next read takes the real figure through the reader.
      return { state: 'renewed', expiresAt };
    }

    this.logger.info(
      `Renewed the Claude Code access token; it now expires at ${new Date(expiresAt).toISOString()}.`,
    );
    return { state: 'renewed', expiresAt };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
