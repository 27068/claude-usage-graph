// SPDX-License-Identifier: AGPL-3.0-only

import { Evictor } from './eviction';
import { toFileName } from './fileNames';
import type { IClock, IEventBus, ILedgerStorage, ILogger, IUsagePoller } from './interfaces';
import type { LedgerCache } from './ledgerCache';
import { newModelCols, sessionValues, weekValues } from './normalize';
import type { PollSchedule } from './pollSchedule';
import { applySample } from './sampleRules';
import { FIVE_HOUR_MS, WEEK_MS } from './windows';
import { PollError, SESSION_COLS, WEEK_BASE_COLS } from './types';
import type {
  LedgerFile,
  LedgerUpdatedEvent,
  Meta,
  Millis,
  SampleOutcome,
  StatusEvent,
  StatusState,
  UsageSnapshot,
} from './types';

/**
 * The polling cadence, and the one place it is written down.
 *
 * The engine still takes its interval as an option so tests can drive it fast,
 * but the composition root and the status bar both read this — the status bar
 * because its auth tooltips promise the user a resume "within three minutes",
 * and a promise derived from anything but the real cadence is a promise that
 * silently goes stale.
 *
 * 180s is the interval community tooling has settled on for an endpoint that
 * answers bursts with a 429 carrying no `Retry-After`.
 */
export const POLL_INTERVAL_MS = 180_000;

export interface UsageEngineOptions {
  intervalMs: number;
  maxBackoffMs?: number;
  mock?: boolean;
  /** Omitted means the default window; see `core/eviction.ts`. */
  retentionMs?: number;
  /** Per-pass eviction budget. Omitted means `EVICTION_BUDGET_MS`. */
  evictionBudgetMs?: number;
}

export interface TickOptions {
  /**
   * Poll even if the shared schedule says the next one is not due yet. For work
   * the user asked for by hand, and for draining a fixture — never for the
   * timer, which is what the schedule exists to pace.
   */
  force?: boolean;
}

/**
 * Floor on how soon a wake-up may be scheduled.
 *
 * Only reachable when a deadline read from disk is already in the past — a
 * corrupt file, or a clock moved backwards. Without it the timer would re-arm
 * for zero and spin.
 */
const MIN_WAKE_MS = 5_000;

/**
 * Spread added to each wake-up.
 *
 * Every window aims at the same shared deadline rather than at its own phase, so
 * they wake together and race for one turn. The race is correct and cheap — a
 * file read and at most a rename, no network — but a few hundred milliseconds of
 * scatter keeps them from contending on the same rename every cycle, which on
 * Windows is what `atomicWrite` has to retry through.
 */
const WAKE_JITTER_MS = 400;

/**
 * The persistent core. Runs from IDE start to shutdown, entirely independent of
 * whether a dashboard panel has ever been opened — it holds no reference to one,
 * and publishes to an event bus that may have no listeners at all.
 */
export class UsageEngine {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private stopped = false;
  private revision = 0;
  private consecutiveFailures = 0;
  /** The shared deadline this window is currently waiting on. */
  private nextDueAt: Millis = 0;
  private lastSnapshot: UsageSnapshot | undefined;
  private readonly maxBackoffMs: number;
  /** Built by `start`, then drained a pass at a time by `sweepExpired`. */
  private evictor: Evictor | undefined;
  private evictionPass: Promise<void> | undefined;

  constructor(
    private readonly poller: IUsagePoller,
    private readonly storage: ILedgerStorage,
    private readonly cache: LedgerCache,
    private readonly updates: IEventBus<LedgerUpdatedEvent>,
    private readonly statuses: IEventBus<StatusEvent>,
    private readonly schedule: PollSchedule,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly options: UsageEngineOptions,
  ) {
    this.maxBackoffMs = options.maxBackoffMs ?? 30 * 60_000;
  }

  async start(): Promise<void> {
    await this.storage.ensureLayout();
    // One listing and one read per kind, whatever the retention window holds —
    // the cache holds the live file and history is paged from storage.
    await this.cache.reload();
    // Built, and not run. The cutoff is fixed here: files age by the day, so
    // re-deriving it every three minutes would buy nothing and would mean a
    // lowered setting deleting history under a running window. What follows is a
    // series of budgeted passes that nothing awaits; see `Evictor`. Independent
    // of the reload above in both directions — it resolves its own candidates
    // from the listing, and announces its own removals.
    this.evictor = new Evictor(
      this.storage,
      this.cache,
      this.clock.now(),
      this.logger,
      this.options.retentionMs,
      this.options.evictionBudgetMs === undefined
        ? {}
        : { budgetMs: this.options.evictionBudgetMs },
    );
    this.logger.info(`Usage engine started; polling every ${this.options.intervalMs / 1000}s`);
    await this.tick();
  }

  dispose(): void {
    this.stopped = true;
    this.evictor?.cancel();
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    void this.schedule.release();
  }

  /** Exposed for the "Refresh Now" command, the fixture drain, and tests. */
  async tick(options: TickOptions = {}): Promise<void> {
    if (this.stopped) {
      return;
    }
    // A slow poll must not build a backlog: skip this tick rather than queue it.
    if (this.inFlight) {
      this.logger.info('Skipping tick; previous poll still in flight');
      return;
    }

    this.inFlight = true;
    // Overwritten by whichever branch of runTick runs. Standing in for it here
    // means a thrown tick still re-arms on a sane deadline rather than on zero.
    this.nextDueAt = this.clock.now() + this.options.intervalMs;
    try {
      await this.runTick(options.force === true);
    } catch (error) {
      this.logger.error(`Unexpected failure during tick: ${String(error)}`);
    } finally {
      this.inFlight = false;
      this.armTimer();
      this.sweepExpired();
    }
  }

  /**
   * Hand eviction one budgeted pass, and do not wait for it.
   *
   * Not awaited, by design: a panel hydrating behind `start()` must never be
   * held up by however long a thousand unlinks take on a redirected storage root
   * — that is the whole point of the budget, and awaiting it here would put the
   * wait back a second at a time. Nothing downstream depends on the result; an
   * expired file that is still on disk is real data, and the removal patch
   * tidies the panel when it goes.
   *
   * The `pending` check is what keeps this free. Once a pass finishes — the
   * usual case, on the first one — this is a boolean per tick and no I/O ever
   * again.
   *
   * The in-flight guard is against passes overlapping each other, not against
   * overlapping a tick: a manual "Refresh Now" landing on top of a slow sweep
   * would otherwise start a second one over the same entries. A sweep *can*
   * still run alongside the next tick's reload, and that is harmless — it
   * removes the file before forgetting it, so a concurrent reload either fails
   * to read it or carries it one more tick before the next listing drops it.
   */
  private sweepExpired(): void {
    const evictor = this.evictor;
    const idle = evictor !== undefined && evictor.pending && this.evictionPass === undefined;
    if (!idle || this.stopped) {
      return;
    }
    this.evictionPass = evictor
      .sweep()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error(`Eviction pass failed: ${String(error)}`);
      })
      .finally(() => {
        this.evictionPass = undefined;
      });
  }

  /**
   * Settle once the eviction pass in flight, if any, has finished.
   *
   * For tests, and for nothing else. Production code deliberately never waits
   * on eviction — that is the whole point of the budget — but a test asserting
   * that a stale file is gone has to await the pass that removes it, and the
   * alternative is polling the directory on a timer.
   */
  async whenEvicted(): Promise<void> {
    await this.evictionPass;
  }

  private async runTick(force: boolean): Promise<void> {
    // One window on the machine talks to the network per turn. The rest read the
    // same files and update their charts for free, and — the point of taking the
    // deadline back with them — wake when the next turn is actually due rather
    // than an interval after their own arbitrary phase.
    const claim = await this.schedule.claim({ force });
    if (!claim.granted) {
      this.nextDueAt = claim.dueAt;
      await this.cache.reload();
      this.publish({ kind: 'append' });
      return;
    }

    // Adopt the machine-wide count rather than this window's own. A window that
    // has just opened has seen no failures, but the endpoint does not care who
    // is asking, and starting the backoff ladder again would hammer it.
    this.consecutiveFailures = claim.failures;

    try {
      let snapshot: UsageSnapshot;
      try {
        snapshot = await this.poller.poll();
      } catch (error) {
        this.handleFailure(error);
        return;
      }

      this.consecutiveFailures = 0;
      this.lastSnapshot = snapshot;
      const outcome = await this.record(snapshot);
      this.emitStatus(this.options.mock === true ? 'mock' : 'ok');
      this.publish(outcome);
    } finally {
      // Unconditional, including when recording threw: an unsettled claim leaves
      // `pollingSince` set, and every other window would defer to a poll that is
      // no longer happening until the guard aged out.
      this.nextDueAt = this.clock.now() + this.currentDelay();
      await this.schedule.settle(this.nextDueAt, this.consecutiveFailures);
    }
  }

  /** Fold the snapshot into the session file and the week file for this tick. */
  private async record(snapshot: UsageSnapshot): Promise<SampleOutcome> {
    let outcome: SampleOutcome = { kind: 'skipped' };

    const fiveReset = snapshot.fiveHour.resetsAt;
    if (fiveReset !== null) {
      // A change in resets_at *is* the session boundary: it rolls us onto a new
      // file, so the drop to zero renders as a segment break rather than a line.
      const startAt = fiveReset - FIVE_HOUR_MS;
      outcome = await this.commit('five_hour', startAt, fiveReset, snapshot.at, () =>
        sessionValues(snapshot),
      );
    }

    const sevenReset = snapshot.sevenDay.resetsAt;
    if (sevenReset !== null) {
      const startAt = sevenReset - WEEK_MS;
      const weekOutcome = await this.commit(
        'seven_day',
        startAt,
        sevenReset,
        snapshot.at,
        // Adopt first, then read the order back off the file, so a tier that
        // appeared this poll gets both a column and a value in the same row.
        (target) => {
          target.cols.push(...newModelCols(snapshot, target.cols));
          return weekValues(snapshot, target.cols);
        },
      );
      if (outcome.kind === 'skipped') {
        outcome = weekOutcome;
      }
    }

    return outcome;
  }

  private async commit(
    kind: 'five_hour' | 'seven_day',
    startAt: Millis,
    resetAt: Millis,
    at: Millis,
    /**
     * Builds the row against the open file, and may append to its `cols` first —
     * which is why it is a callback rather than a precomputed array. The columns
     * are only knowable once the file is open and under its lock, so a caller
     * that had to pass values in would be guessing at the header its row will be
     * stored under. Appending only: see `LedgerFile.cols`.
     */
    buildValues: (target: LedgerFile) => Array<number | null>,
  ): Promise<SampleOutcome> {
    const name = toFileName(startAt);
    let outcome: SampleOutcome = { kind: 'skipped' };

    const file = await this.storage.commit(
      kind,
      name,
      () => seedFile(kind, startAt, resetAt),
      (target) => {
        outcome = applySample(target, at, buildValues(target));
      },
    );

    this.cache.put(kind, name, file);
    return outcome;
  }

  private handleFailure(error: unknown): void {
    const failure = error instanceof PollError ? error : undefined;
    const kind = failure?.kind ?? 'network-error';
    const message = failure?.message ?? String(error);

    // A missing or expired credential costs no network call, so retrying on the
    // normal cadence is free and means we notice the moment Claude Code renews.
    const shouldBackOff = kind === 'rate-limited' || kind === 'network-error';
    if (shouldBackOff) {
      this.consecutiveFailures += 1;
    }

    const retryAt = this.clock.now() + this.currentDelay();
    this.logger.warn(`Poll failed (${kind}): ${message}`);
    this.emitStatus(kind, message, shouldBackOff ? retryAt : undefined);
  }

  private currentDelay(): number {
    if (this.consecutiveFailures === 0) {
      return this.options.intervalMs;
    }
    const grown = this.options.intervalMs * 2 ** this.consecutiveFailures;
    return Math.min(grown, this.maxBackoffMs);
  }

  /**
   * Wake when the next poll is *due*, not one interval from now.
   *
   * This is the half that stops the cadence decaying. Re-arming at
   * `now + interval` means a window that woke a moment too early to take its
   * turn waits a whole further interval — and with several windows in play, the
   * one that keeps missing by a hair keeps pushing its own next attempt back
   * until the machine is polling at half the rate nobody asked it to. Aiming at
   * the shared deadline instead makes a missed turn cost the few seconds until
   * that deadline and nothing more.
   */
  private armTimer(): void {
    if (this.stopped) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    const wait =
      Math.max(MIN_WAKE_MS, this.nextDueAt - this.clock.now()) + Math.random() * WAKE_JITTER_MS;
    // setTimeout rather than setInterval so the delay can differ every time, and
    // so a suspended machine simply resumes late instead of firing a burst.
    this.timer = setTimeout(() => void this.tick(), wait);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Announce what moved, not what exists.
   *
   * The patch is drained from the cache rather than assembled here, so a
   * mutation made outside a tick — the scenario runner wiping the ledger — is
   * carried by the next publish instead of being lost. No snapshot is built:
   * both always-on subscribers want the newest file of each kind, and the panel
   * pulls the full ledger itself when it hydrates.
   */
  private publish(outcome: SampleOutcome): void {
    this.revision += 1;
    const newest = {
      five_hour: this.cache.newest('five_hour'),
      seven_day: this.cache.newest('seven_day'),
    };
    this.updates.fire({
      revision: this.revision,
      patch: this.cache.drainPatch(),
      newest,
      meta: this.meta(newest),
      outcome,
    });
  }

  private emitStatus(state: StatusState, message?: string, retryAt?: Millis): void {
    const event: StatusEvent = { state };
    if (message !== undefined) {
      event.message = message;
    }
    if (retryAt !== undefined) {
      event.retryAt = retryAt;
    }
    this.statuses.fire(event);
  }

  private meta(newest: Record<'five_hour' | 'seven_day', LedgerFile | undefined>): Meta {
    const now = this.clock.now();
    return {
      now,
      fiveResetAt: openReset(this.lastSnapshot?.fiveHour.resetsAt, newest.five_hour, now),
      sevenResetAt: openReset(this.lastSnapshot?.sevenDay.resetsAt, newest.seven_day, now),
      tzOffsetMinutes: new Date(now).getTimezoneOffset(),
      mock: this.options.mock === true,
    };
  }
}

/**
 * The boundary of the window currently open: the live poll's, else the newest
 * file's header.
 *
 * The fallback matters because a window that lost the lease race never polls, so
 * it has no snapshot of its own — but the files it just read from disk carry the
 * boundary, which is the reason `resetAt` lives in the header. Without it a
 * second VS Code window reports the reset times as unknown while the leader is
 * recording them perfectly well.
 *
 * Either source is discarded once it is in the past. A boundary that has passed
 * belongs to a window that has closed, and the poll naming its successor has not
 * landed — reporting it would leave a long-idle window advertising a countdown
 * pinned at zero, which reads as live.
 */
function openReset(
  live: Millis | null | undefined,
  newest: LedgerFile | undefined,
  now: Millis,
): Millis | null {
  for (const candidate of [live, newest?.resetAt]) {
    if (typeof candidate === 'number' && candidate > now) {
      return candidate;
    }
  }
  return null;
}

function seedFile(kind: 'five_hour' | 'seven_day', startAt: Millis, resetAt: Millis): LedgerFile {
  return {
    v: 1,
    kind,
    startAt,
    resetAt,
    cols: kind === 'five_hour' ? [...SESSION_COLS] : [...WEEK_BASE_COLS],
    samples: [],
  };
}
