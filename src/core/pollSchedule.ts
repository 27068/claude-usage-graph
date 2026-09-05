// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWrite } from './atomicWrite';
import type { IClock, ILogger } from './interfaces';
import { Mutex } from './mutex';
import type { Millis } from './types';

/**
 * The shared polling schedule for every VS Code window on this machine.
 *
 * Each window runs its own extension host and its own timer, so without
 * coordination five open windows would make five requests every interval
 * against an endpoint that answers a burst with a 429 carrying no
 * `Retry-After`. What is shared is therefore not an owner but a *deadline*:
 * one file says when the next poll is due, and a window may poll only by
 * winning a compare-and-set on it.
 *
 * This is deliberately not a lease, and the difference is the whole design.
 * A lease is held for as long as its holder keeps renewing — across the
 * network call, across idle intervals, across the holder's whole lifetime —
 * which means the lease must also answer "what if the holder dies?", and the
 * only available answers are a staleness timeout (minutes of blindness) or a
 * liveness probe (only sound on one machine). Here the claim is held for the
 * milliseconds between writing it and reading it back, and the schedule is
 * carried by the deadline rather than by ownership. A window that dies
 * mid-poll costs one skipped sample and nothing else: the deadline it wrote on
 * the way in comes round on time, and whoever wakes first takes the next turn.
 *
 * The pattern is an ordinary one — optimistic concurrency on a shared next-run
 * time, the same shape a database-backed cron uses when it locks a trigger row,
 * advances its next-fire time and releases immediately, rather than holding the
 * lock for the duration of the job.
 *
 * The file is still named `poll.lease`, because renaming it would strand a file
 * in the global storage of every existing install to no one's benefit.
 */

/**
 * How early a wake-up may be and still count as due.
 *
 * Timers fire when they please, and a few milliseconds under is normal. Without
 * this tolerance a fire that lands fractionally early fails the due test,
 * re-arms for a *whole further interval*, and quietly halves the polling rate —
 * from one four-millisecond miss. One second is far wider than the error it
 * absorbs, and polling one second early costs 0.5% more requests in the worst
 * case, so the asymmetry is all in its favour.
 */
export const DUE_TOLERANCE_MS = 1_000;

/**
 * How long a claim is assumed to still be polling.
 *
 * This is the only mutual exclusion in the design, and it covers exactly the
 * critical section: the network call and the ledger write behind it. It has to
 * exist because `LedgerStorage.commit` is read-modify-write under an
 * *in-process* mutex — two hosts appending to one session file would lose a
 * sample to the last rename.
 *
 * It must outlast the slowest legitimate poll, so it is set against
 * `httpUsagePoller`'s 30s request timeout with room for the write that follows.
 * Shorter than that and a request still waiting to be aborted would stop
 * counting as in flight, which is the one way this design could put two writers
 * on one file. Longer costs only a delayed forced refresh after a hard crash.
 */
export const POLL_GUARD_MS = 60_000;

interface ScheduleState {
  /** Whoever last claimed a turn. Only meaningful alongside `pollingSince`. */
  owner: string;
  /** Set while that turn is in flight; cleared by `settle`. */
  pollingSince: Millis | null;
  /** When the next poll is due. The schedule itself, and the shared part. */
  nextDueAt: Millis;
  /**
   * Consecutive failures, kept here rather than in the window that saw them so
   * a backoff survives the window closing. Otherwise a fresh window inherits
   * the endpoint's bad mood with a clean slate and starts the ladder again.
   */
  failures: number;
}

export interface PollClaim {
  /** True if this window won the turn and must call `settle` when it is done. */
  granted: boolean;
  /** When the next poll is due — the caller's cue for its next wake-up. */
  dueAt: Millis;
  /** The machine-wide failure count, for computing this attempt's backoff. */
  failures: number;
}

export class PollSchedule {
  private readonly statePath: string;
  private readonly mutex = new Mutex();

  constructor(
    root: string,
    private readonly owner: string,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly intervalMs: number,
  ) {
    this.statePath = path.join(root, 'poll.lease');
  }

  /**
   * Ask for a turn. Grant obliges the caller to `settle`.
   *
   * `force` is for a refresh the user asked for by hand: it ignores the
   * deadline but not the guard, so an explicit request preempts the schedule
   * without ever putting two writers on the ledger at once. Automatic work must
   * never pass it — deferring is the entire point of the deadline.
   */
  async claim({ force = false }: { force?: boolean } = {}): Promise<PollClaim> {
    return this.mutex.runExclusive(async () => {
      const now = this.clock.now();
      const current = await this.read();
      const failures = current?.failures ?? 0;
      const dueAt = current?.nextDueAt ?? now;

      if (current !== undefined && current.owner !== this.owner) {
        const since = current.pollingSince;
        if (since !== null && now - since < POLL_GUARD_MS) {
          return { granted: false, dueAt, failures };
        }
      }

      if (!force && current !== undefined && now + DUE_TOLERANCE_MS < current.nextDueAt) {
        return { granted: false, dueAt, failures };
      }

      // The deadline written here is provisional, and writing it *before* the
      // poll rather than after is what keeps a crash from wedging anything: die
      // now and the next window simply waits one ordinary interval. `settle`
      // replaces it with the real figure, which may be longer under backoff.
      const claimed: ScheduleState = {
        owner: this.owner,
        pollingSince: now,
        nextDueAt: now + this.intervalMs,
        failures,
      };

      try {
        await this.write(claimed);
      } catch (error) {
        // Another window won the rename. A lost claim is an ordinary outcome,
        // not something to fail a tick over.
        this.logger.info(`Could not claim a poll turn: ${String(error)}`);
        return { granted: false, dueAt, failures };
      }

      // Two windows can read the same free deadline and both write. The
      // read-back settles it within the same tick: last write wins, and the
      // loser stands down here rather than polling alongside the winner. At
      // worst one extra request is made once, never repeatedly.
      const confirmed = await this.read();
      if (confirmed?.owner !== this.owner) {
        return {
          granted: false,
          dueAt: confirmed?.nextDueAt ?? dueAt,
          failures: confirmed?.failures ?? failures,
        };
      }

      return { granted: true, dueAt: claimed.nextDueAt, failures };
    });
  }

  /**
   * Record when the next poll is due and stand down.
   *
   * Skipped if another window has claimed in the meantime — that only happens
   * when a hand-forced refresh preempted us, and their deadline is the newer
   * fact. Overwriting it would drag the next poll back to a moment they have
   * already served.
   */
  async settle(nextDueAt: Millis, failures: number): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const current = await this.read();
      if (current !== undefined && current.owner !== this.owner) {
        return;
      }
      try {
        await this.write({ owner: this.owner, pollingSince: null, nextDueAt, failures });
      } catch (error) {
        // The provisional deadline from `claim` is still on disk, so the cost of
        // losing this write is one mistimed wake-up, not a stuck schedule.
        this.logger.info(`Could not record the next poll time: ${String(error)}`);
      }
    });
  }

  /**
   * Stand down on shutdown without touching the deadline.
   *
   * Only clears our own in-flight mark, so a window closed mid-poll does not
   * make everyone else wait out the guard. The deadline deliberately survives:
   * a window that reopens a minute later should honour the poll that already
   * happened rather than making a fresh request for data it has on disk.
   */
  async release(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const current = await this.read();
      if (current?.owner !== this.owner || current.pollingSince === null) {
        return;
      }
      try {
        await this.write({ ...current, pollingSince: null });
      } catch {
        // Shutting down; the guard ages out on its own.
      }
    });
  }

  private async read(): Promise<ScheduleState | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as Partial<ScheduleState>;
      // A file written by the old lease format has an owner but no deadline.
      // Treating it as absent costs one early poll on upgrade and leaves no
      // migration to maintain.
      if (typeof parsed.owner !== 'string' || typeof parsed.nextDueAt !== 'number') {
        return undefined;
      }
      return {
        owner: parsed.owner,
        pollingSince: typeof parsed.pollingSince === 'number' ? parsed.pollingSince : null,
        nextDueAt: parsed.nextDueAt,
        failures: typeof parsed.failures === 'number' ? parsed.failures : 0,
      };
    } catch {
      // Missing or unreadable both mean "nobody demonstrably has a turn".
      return undefined;
    }
  }

  private async write(state: ScheduleState): Promise<void> {
    await atomicWrite(this.statePath, JSON.stringify(state));
  }
}
