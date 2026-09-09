// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ILogger } from './interfaces';

/**
 * The `User-Agent` for the **usage endpoint only**, where it must identify as
 * Claude Code: without that, `api.anthropic.com` drops into an aggressively
 * rate-limited bucket that returns 429 for tens of minutes with no `Retry-After`
 * to guide a client back.
 *
 * **The token endpoint requires the opposite and must not use this.** A
 * `claude-code/*` agent is refused at `platform.claude.com` before it reaches the
 * application. Sharing one agent between the two looks tidy and silently breaks
 * renewal — see `auth/credentialRefresher.ts` and `docs/DECISIONS.md` section 2.
 */

const FALLBACK_CLIENT_VERSION = '2.1.0';

/** Keys `~/.claude.json` has carried the installed version under. */
const VERSION_KEYS = ['version', 'lastReleaseNotesSeen', 'installedVersion'];

export interface ClientVersionOptions {
  homeDir?: string;
  readFile?: (target: string) => Promise<string>;
}

export class ClientVersion {
  private cached: string | undefined;
  private readonly homeDir: string;
  private readonly readFile: (target: string) => Promise<string>;

  constructor(
    private readonly logger: ILogger,
    options: ClientVersionOptions = {},
  ) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.readFile = options.readFile ?? ((target) => fs.readFile(target, 'utf8'));
  }

  async userAgent(): Promise<string> {
    return `claude-code/${await this.resolve()}`;
  }

  /** Prefer the installed Claude Code version; fall back to a pinned constant. */
  private async resolve(): Promise<string> {
    if (this.cached !== undefined) {
      return this.cached;
    }

    try {
      const parsed = JSON.parse(
        await this.readFile(path.join(this.homeDir, '.claude.json')),
      ) as Record<string, unknown>;
      for (const key of VERSION_KEYS) {
        const candidate = parsed[key];
        if (typeof candidate === 'string' && /^\d+\.\d+/.test(candidate)) {
          this.cached = candidate;
          return candidate;
        }
      }
    } catch {
      // Not fatal: the header only has to look like Claude Code, not match it.
    }

    this.logger.info(`Using fallback client version ${FALLBACK_CLIENT_VERSION}`);
    this.cached = FALLBACK_CLIENT_VERSION;
    return this.cached;
  }
}
