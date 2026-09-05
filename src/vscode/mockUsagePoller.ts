// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import * as path from 'path';
import type { IClock, ILogger, IUsagePoller } from '../core/interfaces';
import { normalizeSnapshot } from '../core/normalize';
import { startOfLocalDay, addLocalDays } from '../core/sessions';
import { PollError } from '../core/types';
import type { Millis, UsageSnapshot } from '../core/types';

/**
 * Scenario scripts live in this subdirectory of `fixtures/`.
 *
 * Declared here rather than beside the runner that reads them because the runner
 * imports `vscode`, which the terminal test suite has no way to load — so the
 * tests that check these files could not see the constant that names their
 * directory. This module owns the scenario *format*; the directory is part of it.
 */
export const SCENARIO_DIR = 'scenarios';

export interface Frame {
  atMin: number;
  five: number | null;
  /**
   * Null means the API reported no five-hour window at all.
   *
   * Not a decoration: a pool that has lapsed with nothing run inside it is
   * reported as a null `resets_at`, the engine skips the session commit, and the
   * ledger simply stops — which is the state behind the idle status bar and the
   * blank tail on graph 1. While this field was a required number the harness
   * could not express that state, so the one case most worth looking at by hand
   * was the one case no fixture could produce.
   */
  fiveResetMin: number | null;
  seven: number | null;
  /**
   * Per-model weekly windows, keyed by wire name — `seven_day_opus`,
   * `seven_day_fable`, whatever a plan reports.
   *
   * A map rather than the named `sonnet`/`opus` fields it replaces, because the
   * real payload's set is plan-dependent and the pipeline now discovers it. Two
   * fixed fields could only ever rehearse the two tiers that happened to exist
   * when they were written, which is the assumption this whole path exists to
   * stop making — a fixture could not express a tier arriving or going away, so
   * neither could a test.
   *
   * Omitted means a plan metering nothing per model, which is what Pro reports.
   */
  models?: Record<string, number | null>;
  /** Null for completeness; a weekly allowance is not observed to lapse. */
  sevenResetMin: number | null;
}

export interface Scenario {
  name?: string;
  description?: string;
  /**
   * Where to freeze the clock, in the same minutes-from-base coordinates as
   * `atMin`. Undefined leaves real time running.
   */
  nowMin?: number;
  /**
   * The local calendar date every offset is measured from, `YYYY-MM-DD`.
   *
   * Lets a fixture pin itself to a specific past week rather than to whichever
   * day it happens to be replayed on, which is what makes a screenshot script
   * reproducible: the weekday labels, the reset walls and the pinned NOW all
   * land on the dates the generator chose. Omitted means the anchor falls back
   * to local midnight of the previous day, which is what an open-ended fixture
   * like `mock-usage.json` wants.
   */
  baseDate?: string;
  frames?: Frame[];
}

const MINUTE_MS = 60_000;

/**
 * Replays a scripted set of frames instead of contacting Anthropic.
 *
 * Frames are turned into the raw payload shape and passed through the same
 * `normalizeSnapshot` the live poller uses, so a development run exercises the
 * real pipeline — normalizer, dedupe rules, dead-zone detection, file rollover —
 * rather than injecting pre-baked ledger files past all of it.
 *
 * Offsets are anchored to local midnight of the previous day so the fixture's
 * midnight-crossing session lands where it is supposed to, and so everything
 * stays inside the retention window.
 */
export class MockUsagePoller implements IUsagePoller {
  private frames: Frame[] | undefined;
  private index = 0;
  private base: Millis | undefined;
  /** From the loaded scenario, and read by `anchor` before it caches. */
  private baseDate: string | undefined;

  constructor(
    private readonly fixturePath: string,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private fixtureFile = 'mock-usage.json',
    /**
     * Anchor for every `atMin`, supplied rather than derived when a scenario is
     * driving. A scenario freezes the clock at `base + nowMin`, so deriving the
     * base from the clock would make the two definitions circular: the anchor
     * would move every time a scenario moved the time it is meant to anchor.
     */
    private readonly baseOverride?: Millis,
  ) {}

  /** How many frames have been handed out. Only moves when one is consumed. */
  get consumed(): number {
    return this.index;
  }

  /**
   * True once the script has been played to its end.
   *
   * A fixture dense enough to draw a convincing day is a hundred frames or more,
   * and on the live three-minute timer that is half a day of waiting for a
   * picture the file already describes in full. The composition root drains the
   * script on activation and uses this to know when to stop.
   */
  get exhausted(): boolean {
    return this.frames !== undefined && this.index >= this.frames.length;
  }

  /**
   * Point the poller at a different script and rewind it.
   *
   * This is what lets one window step through a set of test cases rather than
   * one per launch. The ledger the previous script wrote is not this class's
   * concern — the caller clears it, because replaying scenario B on top of
   * scenario A's files would show neither.
   */
  async loadScenario(fixtureFile: string): Promise<Scenario> {
    this.fixtureFile = fixtureFile;
    this.frames = undefined;
    this.index = 0;
    this.base = undefined;
    const scenario = await this.read();
    this.baseDate = scenario.baseDate;
    this.frames = scenario.frames ?? [];
    this.logger.info(`Mock poller loaded ${this.frames.length} frames from ${fixtureFile}`);
    return scenario;
  }

  /**
   * The anchor every `atMin` and `nowMin` is measured from.
   *
   * A date declared by the fixture outranks the supplied override, because it is
   * the more specific claim: the override says "wherever yesterday was", while
   * `baseDate` names the week the script was actually written for. Cached on
   * first call, so it must not be asked before the scenario has been read.
   */
  anchor(): Millis {
    if (this.base === undefined) {
      this.base =
        parseLocalDate(this.baseDate) ??
        this.baseOverride ??
        addLocalDays(startOfLocalDay(this.clock.now()), -1);
    }
    return this.base;
  }

  async poll(): Promise<UsageSnapshot> {
    const frames = await this.load();
    if (frames.length === 0) {
      throw new PollError('network-error', 'Mock fixture contained no frames');
    }

    // Hold on the final frame once the script runs out, so the dashboard keeps
    // showing a stable picture instead of looping or going blank.
    const frame = frames[Math.min(this.index, frames.length - 1)];
    this.index += 1;

    const base = this.anchor();
    return normalizeSnapshot(
      {
        five_hour: {
          utilization: frame.five,
          resets_at: isoAt(base, frame.fiveResetMin),
        },
        seven_day: {
          utilization: frame.seven,
          resets_at: isoAt(base, frame.sevenResetMin),
        },
        ...Object.fromEntries(
          Object.entries(frame.models ?? {}).map(([key, utilization]) => [
            key,
            { utilization, resets_at: isoAt(base, frame.sevenResetMin) },
          ]),
        ),
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 0, utilization: null },
      },
      base + frame.atMin * MINUTE_MS,
    );
  }

  private async load(): Promise<Frame[]> {
    if (this.frames !== undefined) {
      return this.frames;
    }
    // Read before anchoring, not after: `anchor` caches, and the scenario is
    // what may name the date it should cache.
    const scenario = await this.read();
    this.baseDate = scenario.baseDate;
    this.anchor();
    this.frames = scenario.frames ?? [];
    this.logger.info(`Mock poller loaded ${this.frames.length} frames from ${this.fixtureFile}`);
    return this.frames;
  }

  private async read(): Promise<Scenario> {
    try {
      const raw = await fs.readFile(path.join(this.fixturePath, this.fixtureFile), 'utf8');
      const parsed = JSON.parse(raw) as Scenario;
      return { ...parsed, frames: Array.isArray(parsed.frames) ? parsed.frames : [] };
    } catch (error) {
      this.logger.error(`Could not load mock fixture ${this.fixtureFile}: ${String(error)}`);
      return { frames: [] };
    }
  }
}

/**
 * `YYYY-MM-DD` as **local** midnight.
 *
 * Split by hand rather than handed to `Date.parse`, which reads that exact form
 * as UTC — anchoring a fixture a whole timezone away from the day it names, and
 * on this side of the world putting it on the wrong date entirely.
 */
function parseLocalDate(value: string | undefined): Millis | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return undefined;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

/**
 * A null offset becomes a null `resets_at` rather than a date, which is how the
 * API reports a window that does not currently exist.
 */
function isoAt(base: Millis, offsetMinutes: number | null): string | null {
  if (offsetMinutes === null) {
    return null;
  }
  return new Date(base + offsetMinutes * MINUTE_MS).toISOString();
}
