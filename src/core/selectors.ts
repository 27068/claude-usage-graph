// SPDX-License-Identifier: AGPL-3.0-only

import {
  HOUR_MS,
  addLocalDays,
  formatDayLabel,
  formatClock24,
  formatResetWall,
  formatShortDate,
  localDayKey,
  sessionsForDay,
  startOfLocalDay,
} from './sessions';
import { frameContains } from './markers';
import { SESSION_COLS } from './types';
import { DAY_OVERHANG_MS, WEEK_MS } from './windows';
import type {
  CalendarWeekView,
  ChartPoint,
  ChartSeries,
  LedgerFile,
  Millis,
  PoolDayView,
} from './types';

/**
 * Pure view derivation. No I/O, no vscode, no Date.now() — every result is a
 * function of (ledger, now, offset) alone.
 *
 * That purity is what keeps the viewport still. When a background refresh
 * arrives, the client recomputes with the same offset it already held; for any
 * historical page the inputs are immutable, so the domain comes back identical
 * and assigning it is a no-op. Only offset 0 moves, which is correct — that is
 * the live window.
 */

/** A nominal day, for counting whole days apart. See `maxDayOffset` on DST. */
const DAY_MS = 24 * HOUR_MS;

export const POOL_BUFFER_MS = HOUR_MS;
export const CALENDAR_BUFFER_MS = 12 * HOUR_MS;

/** Frame shown for a day with no sessions, so the axis is never degenerate. */
const EMPTY_DAY_FROM_HOUR = 9;
const EMPTY_DAY_TO_HOUR = 18;

/**
 * Widen a frame so it contains `now`, giving it the same air the frame already
 * gives its data.
 *
 * Only the live page can need this, and while a window is open it is a no-op:
 * the frame already runs to that window's reset, which is ahead of now. It bites
 * once the day's last window has closed and nothing has reopened one. The frame
 * then ends an hour after a reset that is hours behind us, `charts.ts` drops the
 * Now marker for falling outside the scale, and what is left is a chart that has
 * quietly stopped being live with nothing on it to say so — indistinguishable
 * from one that is still tracking. Keeping Now on the axis makes it legible
 * instead: a reset wall, then empty space, then Now.
 *
 * The empty space is deliberately left empty. After a reset the pool really is
 * at zero, but we never observed that — no window existed to report — and
 * drawing a 0% line would be inventing a measurement rather than showing one.
 */
function includeNow([from, to]: [Millis, Millis], now: Millis, buffer: number): [Millis, Millis] {
  return [Math.min(from, now - buffer), Math.max(to, now + buffer)];
}

/**
 * Where the live page's frame ends: the newest observed boundary stepped forward
 * in whole weeks until it is ahead of now.
 *
 * This is *alignment*, not a claim about a cycle. The frame is seven days wide
 * and navigation moves it in whole weeks regardless of what any cycle actually
 * did; all the recorded boundary contributes is the phase — which weekday, and
 * which time of day, the frame breaks on. A reset of Tue 09:00 puts every page's
 * edges on Tue 09:00, buffers aside, forever.
 *
 * Keeping it to phase is what decouples navigation from cycle length: a cycle
 * that ran short or long moves where the *wall* is drawn and does not disturb
 * paging at all. Reading it as "the current cycle's reset" instead would assert
 * that every cycle is seven days, and then draw walls asserting it.
 */
function liveFrameEnd(recorded: Millis, now: Millis): Millis {
  if (recorded > now) {
    return recorded;
  }
  // Strictly forward: a boundary landing exactly on now has just closed a cycle,
  // so the live one ends a week later.
  return recorded + (Math.floor((now - recorded) / WEEK_MS) + 1) * WEEK_MS;
}

/**
 * Legend and tooltip names, read under the panel heading that already supplies
 * the noun: "Usage" sits below *Session Usage*, "All models" below *Weekly
 * Usage*.
 *
 * `five_hour` is deliberately not "All models" even though it is equally a
 * combined figure. That label earns its keep on graph 2 by contrasting with the
 * per-model lines beside it; on graph 1 there is nothing to contrast with and
 * never will be — the API reports one session number, not a breakdown — so it
 * would only advertise lines the reader is then left hunting for.
 */
const SERIES_LABELS: Record<string, string> = {
  five_hour: 'Usage',
  seven_day: 'All models',
};

/** The wire prefix marking a per-model weekly column, as in `normalize.ts`. */
const MODEL_PREFIX = 'seven_day_';

/**
 * Which columns graph 2 draws, in first-seen order across the visible files.
 *
 * **A column is charted only where it carries a reading.** That one rule keeps
 * the legend honest as plans change, in both directions and without a code change
 * for either. A tier the account is not metered on — reported as
 * present-but-null on every poll — never earns a line, so the chart does not
 * advertise allowances the reader does not have; a tier that starts reporting
 * appears by itself.
 *
 * Scoped to the frame rather than to all of history, which lets a retired tier
 * fall off the current page while still drawing on the pages where it was real.
 *
 * Columns are filtered by prefix as well. A file may carry an `extra_usage`
 * column, which is a monthly credit balance rather than a percentage of a
 * window, so it must never be handed to an axis that reads as percent.
 */
function chartedCols(files: readonly LedgerFile[]): string[] {
  const keys: string[] = [];

  for (const file of files) {
    file.cols.forEach((col, index) => {
      if (keys.includes(col)) {
        return;
      }
      if (col !== 'seven_day' && !col.startsWith(MODEL_PREFIX)) {
        return;
      }
      if (file.samples.some((sample) => sample[index + 1] !== null && sample[index + 1] !== undefined)) {
        keys.push(col);
      }
    });
  }

  return keys;
}

/**
 * The range each graph is asking for, and the one definition of it.
 *
 * Exported because the client has to compute the *same* range to request a page
 * with, and the selectors then derive the view from what comes back. Two
 * definitions of "which day is offset 3" is a bug that shows as a chart drawn
 * from the wrong page — visible only on the boundaries, which is where nobody
 * looks.
 */

/**
 * Which instant Graph 1 pages from, which is not always `now`.
 *
 * A session belongs to the day it started on — that is what the 29-hour overhang
 * exists to draw. So anchoring the live page to `now` moves it at midnight onto
 * a day nobody has worked yet, while the pool being spent at that moment sits on
 * the page behind it, for as long as five hours. Midnight to 05:00 is not an
 * hour nobody looks: it is precisely when a session opened late last night is
 * the only thing worth seeing.
 *
 * So while a window is open the live page follows it, and moves on by itself
 * once it resets. Every caller has to use this — the day the clamp permits, the
 * day the page is fetched for and the day drawn are the same day or the chart is
 * built from the wrong page.
 */
export function poolAnchor(live: LedgerFile | undefined, now: Millis): Millis {
  return live !== undefined && live.resetAt > now ? live.startAt : now;
}

/** Graph 1: the local day at `dayOffset` pages back, `[start, end)`. */
export function poolDayRange(anchor: Millis, dayOffset: number): [Millis, Millis] {
  const dayStart = startOfLocalDay(addLocalDays(startOfLocalDay(anchor), -dayOffset));
  return [dayStart, startOfLocalDay(addLocalDays(dayStart, 1))];
}

/**
 * Graph 2: the frame at `weekOffset` cycles back, buffers included.
 *
 * Takes the newest recorded boundary rather than a ledger, because the client
 * holds exactly one week file before it has asked for anything — the live one —
 * and that is all the phase needs. Returns the drawn domain, so the page fetched
 * is precisely the page rendered.
 */
export function calendarFrameRange(
  latestResetAt: Millis,
  now: Millis,
  weekOffset: number,
): [Millis, Millis] {
  const resetAt = liveFrameEnd(latestResetAt, now) - weekOffset * WEEK_MS;
  return [resetAt - WEEK_MS - CALENDAR_BUFFER_MS, resetAt + CALENDAR_BUFFER_MS];
}

/**
 * How far back either graph may be paged, in its own units.
 *
 * The other half of "range in, files out": the client needs the *last* range
 * that still holds anything, or the back button walks off the end of the ledger
 * into blank frames indefinitely with nothing to say the data ran out. Both take
 * the oldest `startAt` on record, which is the one thing only the directory
 * knows — see `ILedgerStorage.oldest`.
 *
 * They live here rather than in the client because they are the inverse of the
 * two range functions above, and a clamp derived from a different notion of
 * "one page back" than the fetch uses is a button that disables itself on the
 * wrong page.
 */

/**
 * Graph 1: the largest `dayOffset` whose day still contains recorded sessions.
 *
 * Rounded rather than floored, because local days are not all 86,400,000 ms
 * long: across a DST boundary the difference between two local midnights is off
 * by an hour, which floors to one day short. Rounding is exact for any span
 * where the error stays under half a day, which is every span there can be.
 */
export function maxDayOffset(anchor: Millis, oldestStartAt: Millis): number {
  const days = (startOfLocalDay(anchor) - startOfLocalDay(oldestStartAt)) / DAY_MS;
  return Math.max(0, Math.round(days));
}

/**
 * Graph 2: the largest `weekOffset` whose frame still overlaps a recorded cycle.
 *
 * The frame at offset `k` ends at `liveFrameEnd - k * WEEK_MS`, so it shows
 * something as long as that end is still after the oldest window opened. Phase
 * comes from the same recorded boundary `calendarFrameRange` pages by, so the
 * clamp and the fetch cannot disagree about where a frame sits.
 */
export function maxWeekOffset(
  latestResetAt: Millis,
  now: Millis,
  oldestStartAt: Millis,
): number {
  const spans = (liveFrameEnd(latestResetAt, now) - oldestStartAt) / WEEK_MS;
  return Math.max(0, Math.ceil(spans) - 1);
}

/**
 * Graph 1 — one local day, scoped by the day each session *started* on.
 *
 * The axis is clipped to the sessions that actually exist, so a day whose first
 * session began at 07:00 starts at 06:00 rather than padding eight empty hours
 * onto the left. On the live page it is then widened to hold Now; see
 * `includeNow`.
 */
export function selectPoolDay(
  sessions: readonly LedgerFile[],
  anchor: Millis,
  now: Millis,
  dayOffset: number,
): PoolDayView {
  const [dayStart] = poolDayRange(anchor, dayOffset);
  const dayKey = localDayKey(dayStart);
  const label = formatDayLabel(dayStart);
  const todays = sessionsForDay(sessions, dayStart);

  if (todays.length === 0) {
    const frame: [Millis, Millis] = [
      dayStart + EMPTY_DAY_FROM_HOUR * HOUR_MS,
      dayStart + EMPTY_DAY_TO_HOUR * HOUR_MS,
    ];
    return {
      // A quiet day is not an empty view. A calendar day needs no ledger to
      // define it, so the frame, the label and Now are all still meaningful and
      // the day simply draws blank — which is the honest report of a day nobody
      // worked. Only a ledger holding no sessions at all has nothing to say, and
      // that is the one case that earns the placeholder message. Graph 2 draws
      // the same line in the same place, for the same reason.
      empty: sessions.length === 0,
      dayKey,
      label,
      domain: dayOffset === 0 ? includeNow(frame, now, POOL_BUFFER_MS) : frame,
      series: [{ key: 'five_hour', label: SERIES_LABELS.five_hour, points: [] }],
      sessionCount: 0,
      resets: [],
    };
  }

  // Computed through local-day arithmetic, not dayStart + 29h, so the ceiling
  // stays 05:00 wall-clock across a DST boundary.
  const overhangCeiling = startOfLocalDay(addLocalDays(dayStart, 1)) + DAY_OVERHANG_MS;

  const dataMin = Math.min(...todays.map((file) => file.startAt));
  const dataMax = Math.min(Math.max(...todays.map((file) => file.resetAt)), overhangCeiling);

  const frame: [Millis, Millis] = [dataMin - POOL_BUFFER_MS, dataMax + POOL_BUFFER_MS];

  return {
    empty: false,
    dayKey,
    label,
    domain: dayOffset === 0 ? includeNow(frame, now, POOL_BUFFER_MS) : frame,
    series: [
      {
        key: 'five_hour',
        label: SERIES_LABELS.five_hour,
        points: joinColumns(todays, SESSION_COLS)[0],
      },
    ],
    sessionCount: todays.length,
    // Only the resets that actually fall inside the frame; a session clipped by
    // the 05:00 overhang ceiling should not draw a wall off the edge.
    resets: todays
      .map((file) => file.resetAt)
      .filter((at) => at <= dataMax)
      .map((at) => ({ at, label: `Reset ${formatClock24(at)}` })),
  };
}

/**
 * Graph 2 — one weekly cycle with 12-hour buffers on both sides, anchored to the
 * reset boundary the API reports rather than to midnight.
 */
export function selectCalendarWeek(
  weeks: readonly LedgerFile[],
  now: Millis,
  weekOffset: number,
): CalendarWeekView {
  // Ordered by `resetAt`, which the API reports, rather than by `startAt`, which
  // `usageEngine.record` derives by subtracting WEEK_MS. The two sort identically
  // while every cycle is the same length — so this changes nothing today. It
  // matters the day one is not: ordering the record of what happened by a value
  // computed from an assumption about it is how a wrong assumption becomes a
  // wrong chart, and `resetAt` is the only field here that was actually observed.
  const ordered = [...weeks].sort((a, b) => a.resetAt - b.resetAt);
  const latest = ordered[ordered.length - 1];

  if (latest === undefined) {
    return {
      empty: true,
      label: `${formatShortDate(now - WEEK_MS)} – ${formatShortDate(now)}`,
      domain: [now - WEEK_MS - CALENDAR_BUFFER_MS, now + CALENDAR_BUFFER_MS],
      resetAt: null,
      resets: [],
      // No files, so nothing has reported a column yet. Naming series here would
      // be guessing at the plan's shape before the first poll has said.
      series: [],
    };
  }

  // Paging is seven days per step, always, and offset 0 is the page containing
  // now. Only the phase comes from the ledger — see `liveFrameEnd`.
  const resetAt = liveFrameEnd(latest.resetAt, now) - weekOffset * WEEK_MS;
  const domain = calendarFrameRange(latest.resetAt, now, weekOffset);

  const visible = ordered.filter((file) => overlaps(file, domain));

  // Walls are read off the ledger, not computed from the frame. A red line says
  // "the allowance reset here", and that is a measurement — every boundary in
  // the ledger was reported by the API, whereas a boundary derived by stepping
  // whole weeks is only true while every cycle is one. Drawing the derived one
  // anyway is how the frame's own arithmetic ends up looking like evidence.
  const observed = ordered
    .map((file) => file.resetAt)
    .filter((at) => frameContains(domain, at))
    .map((at) => ({ at, label: `Reset ${formatResetWall(at)}` }));

  // The single exception, and only on the live page: with no boundary recorded
  // anywhere in the current frame there is nothing to show for the cycle being
  // spent right now, and when it ends is the one thing worth knowing. Projected
  // from the newest boundary on record and labelled as expected rather than
  // observed, so the chart never passes arithmetic off as a reading. Historical
  // pages get no such fallback: a week with no data has no reset worth guessing.
  const resets =
    observed.length === 0 && weekOffset === 0
      ? [{ at: resetAt, label: `Expected reset ${formatResetWall(resetAt)}` }]
      : observed;

  const keys = chartedCols(visible);

  return {
    // A cycle with no samples is not an empty *view*: the frame and the label
    // are still meaningful, so it draws as a framed, labelled week that has no
    // line in it yet. Only a ledger with nothing in it at all leaves us unable
    // to say where a week even breaks, and that is the branch above.
    empty: false,
    label: `${formatShortDate(resetAt - WEEK_MS)} – ${formatShortDate(resetAt)}`,
    domain,
    resetAt,
    resets,
    series: joinColumns(visible, keys).map((points, column) => ({
      key: keys[column],
      label: seriesLabel(keys[column]),
      points,
    })),
  };
}

/**
 * Concatenate every value column across several files at once, separating each
 * file from the next with a null point so Chart.js does not draw a line from the
 * end of one window to the start of the next. Separate files are separate
 * windows by construction, which is why breaks between them cost nothing to
 * represent.
 *
 * All columns are built in one walk rather than one walk per column, because
 * graph 2 can have several series over the same rows. The columns stay in
 * lockstep — every sample contributes a point to each of them, `undefined` slots
 * included — so each column sees the same x sequence a separate pass would.
 *
 * Series are addressed by column *name*, and the slot is resolved against each
 * file's own header. Two files in one frame need not agree on their columns:
 * they are written weeks apart, by whatever build and whatever plan was in force
 * at the time. A fixed index would read whatever happened to sit in that slot in
 * the older file, quietly plotting one tier's history under another's name.
 */
function joinColumns(files: readonly LedgerFile[], keys: readonly string[]): ChartPoint[][] {
  const series: ChartPoint[][] = keys.map(() => []);

  for (const file of files) {
    if (file.samples.length === 0) {
      continue;
    }
    // -1 for a column this file never had, which reads as null throughout: the
    // series simply has no line over this file's span.
    const slots = keys.map((key) => file.cols.indexOf(key));
    for (const points of series) {
      if (points.length > 0) {
        points.push({ x: points[points.length - 1].x + 1, y: null });
      }
    }
    for (const sample of file.samples) {
      for (let column = 0; column < keys.length; column += 1) {
        const slot = slots[column];
        const value = slot === -1 ? null : sample[slot + 1];
        series[column].push({ x: sample[0], y: value === undefined ? null : value });
      }
    }
  }

  return series;
}

function overlaps(file: LedgerFile, [from, to]: [Millis, Millis]): boolean {
  if (file.samples.length === 0) {
    return false;
  }
  const first = file.samples[0][0];
  const last = file.samples[file.samples.length - 1][0];
  return last >= from && first <= to;
}

/**
 * Series definitions, exported so the webview can build its legend from them.
 *
 * Unknown keys are titled from the wire name rather than looked up, so a tier
 * this code has never heard of still gets a readable legend the day it appears:
 * `seven_day_fable` reads as "Fable". A table of known names would have to be
 * edited — and shipped — before a new tier could be labelled.
 */
export function seriesLabel(key: string): string {
  const known = SERIES_LABELS[key];
  if (known !== undefined) {
    return known;
  }
  const name = key.startsWith(MODEL_PREFIX) ? key.slice(MODEL_PREFIX.length) : key;
  return name.replace(/_/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

export type { ChartSeries };
