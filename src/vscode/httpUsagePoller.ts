// SPDX-License-Identifier: AGPL-3.0-only

import { ClientVersion } from '../core/clientVersion';
import type { IClock, ICredentialStore, ILogger, IUsagePoller } from '../core/interfaces';
import { normalizeSnapshot } from '../core/normalize';
import { PollError } from '../core/types';
import type { UsageSnapshot } from '../core/types';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Reads subscription utilization from Anthropic's OAuth usage endpoint.
 *
 * This is the only network call the extension makes, and the only file that
 * touches HTTP. Two things about it are load-bearing:
 *
 *  - The `User-Agent` must identify as Claude Code. Without it the endpoint
 *    drops into an aggressively rate-limited bucket that returns 429 for tens of
 *    minutes with no `Retry-After` to guide a client back. `ClientVersion`
 *    builds it, shared with the token request so the two cannot disagree.
 *  - A missing or expired credential is resolved *before* any request, so the
 *    common "not signed in" case costs nothing and can be retried on the normal
 *    cadence without hammering anyone.
 */
export class HttpUsagePoller implements IUsagePoller {
  private readonly clientVersion: ClientVersion;

  constructor(
    private readonly credentials: ICredentialStore,
    private readonly clock: IClock,
    logger: ILogger,
    clientVersion?: ClientVersion,
  ) {
    this.clientVersion = clientVersion ?? new ClientVersion(logger);
  }

  async poll(): Promise<UsageSnapshot> {
    const credential = await this.credentials.read();

    switch (credential.state) {
      case 'missing':
        throw new PollError('no-credentials', 'Claude Code credentials were not found');
      case 'malformed':
        // The store read and parsed; only its contents make no sense. Saying it
        // was unreadable would send somebody looking at file permissions.
        throw new PollError(
          'no-credentials',
          `The Claude Code credential store is not in a shape this understands: ${credential.reason}`,
        );
      case 'unreadable':
        throw new PollError(
          'unreadable-store',
          'Claude Code keeps its credential in a store this extension cannot read',
        );
      case 'signed-out':
        throw new PollError(
          'no-credentials',
          'The Claude Code login has expired. Run `claude` in a terminal and sign in.',
        );
      case 'stale':
        throw new PollError('stale-token', 'The Claude Code access token needs renewing');
      default:
        break;
    }

    const response = await this.request(credential.token);

    if (response.status === 401 || response.status === 403) {
      throw new PollError('auth-error', `Usage endpoint rejected the token (${response.status})`);
    }
    if (response.status === 429) {
      // This endpoint sends no Retry-After, so the engine's backoff is the only
      // thing standing between us and a self-inflicted lockout.
      throw new PollError('rate-limited', 'Usage endpoint is rate limiting this client');
    }
    if (!response.ok) {
      throw new PollError('network-error', `Usage endpoint returned ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new PollError('network-error', `Usage response was not JSON: ${String(error)}`);
    }

    return normalizeSnapshot(payload, this.clock.now());
  }

  private async request(token: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fetch(USAGE_ENDPOINT, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'User-Agent': await this.clientVersion.userAgent(),
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (error) {
      const reason = controller.signal.aborted ? 'timed out' : String(error);
      throw new PollError('network-error', `Could not reach the usage endpoint: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }

}
