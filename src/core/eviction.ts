// SPDX-License-Identifier: AGPL-3.0-only

import { namesAtOrBefore } from './fileNames';
import type { ILedgerStorage, ILogger } from './interfaces';
import type { LedgerCache } from './ledgerCache';
import type { LedgerKind, Millis } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Default retention. Mirrored by `claudeUsageGraph.retentionDays`, and pinned to
 * it by a test — two places for one number is exactly what drifts.
 *
 * A year costs one thing only, which is disk: ~1.5 MB, against ~120 KB at a
 * month. No read path is linear in the window — the cache holds the live window,
 * hydrate carries it, history is paged — and "how much did I use in March?" is
 * the question the calendar exists to answer.
 */
export const RETENTION_DAYS = 365;
export const RETENTION_MS = RETENTION_DAYS * DAY_MS;

/**
 * A floor so that "keep some history" always means some.
 *
 * It does not have to protect the window in progress — `Evictor` ages a file by
 * the `resetAt` in its header, which is when its data stops rather than when it
 * was named.
 */
export const MIN_RETENTION_DAYS = 1;

/**
 * The ceiling, which is a decade.
 *
 * `list()` is the one cost linear in file count: every page request enumerates a
 * directory, ~5 ms at a decade's 11,500 files on a warm SSD and proportionally
 * worse on a UNC path. Fine on a click, and would not stay fine at a century —
 * so the cap is a real limit, two orders of magnitude above the default.
 *
 * Disk at the cap is ~14.6 MB. A row is 18 bytes and bookending collapses idle
 * runs to two of them, so the cost here is file count, not bytes.
 */
export const MAX_RETENTION_DAYS = 3650;

/**
 * Turn the setting into a cutoff, clamped.
 *
 * Clamped here rather than trusted to `package.json`, because the declared
 * `minimum` only drives the settings UI: an edited `settings.json`, a synced
 * profile or a workspace file can still deliver anything at all, and this one
 * reads as a licence to delete.
 */
export function retentionMsFromDays(days: unknown): number {
  if (typeof days !== 'number' || !Number.isFinite(days)) {
    return RETENTION_MS;
  }
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.floor(days))) * DAY_MS;
}

const KINDS: LedgerKind[] = ['five_hour', 'seven_day'];

/**
 * How long one eviction pass may run before it puts the rest down.
 *
 * A second is long enough that an ordinary sweep — a handful of files a day
 * falling out of a 30-day window — finishes in its first pass and is never
 * heard from again, and short enough that nothing waiting on a tick notices it.
 */
export const EVICTION_BUDGET_MS = 1_000;

export interface EvictorOptions {
  /** Wall-clock budget for a single pass. */
  budgetMs?: number;
  /**
   * Elapsed-time source for the budget, and deliberately *not* `IClock`.
   *
   * The injected clock is the one a scenario pins to a fixed instant, so timing
   * a pass by it would measure zero however long the pass ran and the budget
   * would silently stop existing. This measures real time even when the ledger's
   * idea of "now" is three weeks ago.
   */
  monotonic?: () => number;
}

/**
 * Drops ledger files whose window closed before the retention cutoff, a bounded
 * slice at a time.
 *
 * Retention asks one question — "has this stopped being current?" — and
 * `resetAt` is the answer, straight from the API. Nothing here derives it. The
 * filename is the moment a window *opened*, which is a different fact: the
 * weekly file being written to right now opened up to seven days ago, so aged
 * by its name it would look a week old while holding this morning's samples.
 *
 * Candidates come from the listing, not from the cache. `namesAtOrBefore` proves
 * that a file named after the cutoff is still current, so the candidates are the
 * prefix below it — in a steady state empty, because the previous window already
 * deleted everything down there. A pass with nothing to evict therefore costs
 * one directory listing per kind and no reads at all.
 *
 * Each candidate's header is read before anything goes: the name only chooses
 * what to open, `resetAt` decides. Elsewhere a bad bound costs a missing chart
 * line; here it would cost data.
 *
 * Every removal is announced to the cache, which is the only way a panel hears
 * about it. The cache holds the live window and nothing else, so it cannot diff
 * a listing to work out what went — the file just deleted is precisely one it
 * never held.
 *
 * ### Why this is a resumable object and not a function
 *
 * Deleting *n* files is *n* unlinks, irreducibly — 141 µs each here, so 0.16 s
 * for the ~1,100 files that lowering `retentionDays` from 365 to 30 produces.
 * But `globalStorageUri` lands in the user's config directory, routinely a
 * roaming profile, a redirected folder or a network home on a managed machine,
 * and at ~30 ms an operation over SMB those same unlinks are 33 seconds.
 *
 * So a pass takes a budget and stops when it runs out, and the engine kicks off
 * another at the end of the next tick — and *only* then, so a ledger with
 * nothing left to evict does no per-tick work. Nothing waits on any of it: an
 * expired-but-not-yet-deleted file is real data, and the removal patch tidies
 * the panel when it does go. The cost is laziness — at one second a pass and a
 * tick every three minutes, a VPN-bound backlog drains over hours rather than
 * minutes — and the budget is the dial if that is ever too slow.
 *
 * The cutoff is captured **once, at construction**, so a lowered setting takes
 * effect on the next window rather than deleting history under a running one.
 *
 * Nothing is persisted about an unfinished pass. Eviction is idempotent, so a
 * window that dies mid-sweep recomputes the same work at the next startup. Nor
 * is there cross-window coordination: `storage.remove` swallows ENOENT, so a
 * second window evicting concurrently finds the file already gone and moves on.
 */
export class Evictor {
  /** Captured at construction. See the class comment — do not re-derive it. */
  private readonly cutoff: Millis;
  private readonly budgetMs: number;
  private readonly monotonic: () => number;
  private finished = false;
  private cancelled = false;

  constructor(
    private readonly storage: ILedgerStorage,
    private readonly cache: LedgerCache,
    now: Millis,
    private readonly logger: ILogger,
    private readonly retentionMs: number = RETENTION_MS,
    options: EvictorOptions = {},
  ) {
    this.cutoff = now - retentionMs;
    this.budgetMs = options.budgetMs ?? EVICTION_BUDGET_MS;
    this.monotonic = options.monotonic ?? Date.now;
  }

  /**
   * Whether a further pass would do anything.
   *
   * The engine reads this before scheduling one, so the common case — a ledger
   * swept clean by the first pass — costs a boolean per tick and no I/O.
   */
  get pending(): boolean {
    return !this.finished && !this.cancelled;
  }

  /** Stop between files; for a window shutting down mid-sweep. */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Delete what the budget allows, and report how many went.
   *
   * The deadline is checked *after* each removal, which gives every pass a
   * minimum of one file: a budget that can decline to delete anything is one
   * under which a pathological unlink stalls the backlog forever.
   */
  async sweep(): Promise<number> {
    if (!this.pending) {
      return 0;
    }

    const deadline = this.monotonic() + this.budgetMs;
    let removed = 0;
    let exhausted = false;

    for (const kind of KINDS) {
      if (exhausted || this.cancelled) {
        break;
      }
      // Re-listed on every pass: another window may have written or removed
      // files since, and a stale candidate list would delete names blind.
      const candidates = namesAtOrBefore(await this.storage.list(kind), this.cutoff);
      for (const name of candidates) {
        if (this.cancelled) {
          break;
        }
        const file = await this.storage.read(kind, name);
        if (file === undefined) {
          // Already gone, or quarantined by the read that just failed.
          continue;
        }
        if (file.resetAt >= this.cutoff) {
          // The bound is conservative by design; the header is the authority.
          continue;
        }
        await this.storage.remove(kind, name);
        // `startAt` from the header we just read, never from the name.
        this.cache.announceRemoved(kind, name, file.startAt);
        removed += 1;
        if (this.monotonic() >= deadline) {
          exhausted = true;
          break;
        }
      }
    }

    let quarantined = 0;
    if (!exhausted && !this.cancelled) {
      // Quarantined files are invisible to `list`, so this is the only thing
      // that clears them. Same cutoff: a damaged file is kept for hand recovery
      // as long as a healthy one of its age would have been. On the finishing
      // pass only — it is a directory scan, so repeating it per pass would be
      // the one part of eviction whose cost did not shrink with the backlog.
      quarantined = await this.storage.sweepQuarantined(this.cutoff);
      this.finished = true;
    }

    if (removed > 0 || quarantined > 0) {
      const days = this.retentionMs / DAY_MS;
      // Read by a user wondering why their history has not shrunk yet, so it
      // says what happens next rather than just reporting a count.
      const more = exhausted ? '; more to remove, continuing on the next poll' : '';
      this.logger.info(
        `Evicted ${removed} ledger file(s) and ${quarantined} quarantined ` +
          `file(s) past ${days} days${more}`,
      );
    }
    return removed;
  }
}

/**
 * Remove every ledger file, leaving the directory layout and the poll schedule.
 *
 * Only the scenario runner calls this. Loading a second test case on top of the
 * first would show neither: the engine appends, so the two scripts' sessions
 * would interleave into a ledger that never existed. Walks KINDS rather than
 * deleting the root, because the root also holds `poll.lease`, and dropping the
 * shared deadline out from under live windows would let them all poll at once.
 *
 * Each file is opened before it goes, as in `Evictor`: the announcement carries
 * `startAt`, which comes from the header.
 */
export async function clearLedger(
  storage: ILedgerStorage,
  cache: LedgerCache,
  logger: ILogger,
): Promise<number> {
  let removed = 0;
  for (const kind of KINDS) {
    for (const name of await storage.list(kind)) {
      const file = await storage.read(kind, name);
      await storage.remove(kind, name);
      removed += 1;
      if (file !== undefined) {
        cache.announceRemoved(kind, name, file.startAt);
      }
    }
  }
  logger.info(`Cleared ${removed} ledger file(s)`);
  return removed;
}
