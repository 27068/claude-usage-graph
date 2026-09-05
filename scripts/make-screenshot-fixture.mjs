// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Generates `fixtures/screenshot-usage.json` — a dense, gapless replay script
 * for taking README screenshots.
 *
 * The composition is a fixed working pattern rather than an offset from whenever
 * this ran: Monday nine to six with an hour off at noon, then the same shape
 * again on Tuesday, stopping mid-afternoon at NOW. That shape is the point. A
 * screenshot has to be legible in one glance, and "two working days" is a thing
 * a reader already understands, so the plateaus land where they expect them —
 * lunch, overnight — and the steps read as work rather than as noise.
 *
 * Tuesday running past its first window is what gives graph 1 its composition:
 * a wall behind NOW from the window that has already reset, and one ahead of it
 * from the window still open. A morning alone leaves only the wall ahead.
 *
 * Everything is pinned to a **past** week. `fixtureWeekStart` picks the most
 * recent Monday whose whole composition has already happened, and the fixture
 * carries that date plus a `nowMin`, so the extension freezes its clock there
 * instead of drawing NOW at the real time. That is what makes the output stable:
 * the same command produces the same picture whenever it runs, and a screenshot
 * taken from it does not go stale an hour later.
 *
 * What the script is shaped to produce:
 *
 *   Graph 1  two five-hour windows a day, each with its own reset wall, and on
 *            Tuesday one of them still open with NOW inside it. Lunch shows as a
 *            plateau inside a window rather than a gap, because a pool that is
 *            not being spent still gets polled.
 *   Graph 2  the same two days, mirroring graph 1 step for step — the weekly
 *            line may only climb where the pool climbs — with the cycle reset a
 *            clear day and a half beyond NOW so the two captions do not collide.
 *
 * No dead-zone breaks anywhere. `applySample` breaks a line only when a value
 * moves after more than IDLE_GAP_MS unobserved, so frames stay 9 minutes apart
 * for as long as any window is open, including across lunch. The gap between
 * Monday's last window closing and Tuesday's opening is a real break, and it is
 * supposed to be: nothing was polled overnight because no window existed.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'screenshot-usage.json');

/** Matches IDLE_GAP_MS in `src/core/sampleRules.ts` (10 min) with margin. */
const STEP_MIN = 9;

/** The five-hour pool window, from first use. Matches `FIVE_HOUR_MS`. */
const SESSION_MIN = 300;

const DAY_MIN = 24 * 60;
const MON = 0;
const TUE = DAY_MIN;

/** Both must match the product: `WEEK_MS` and `CALENDAR_BUFFER_MS`. */
const WEEK_MIN = 7 * DAY_MIN;
const FRAME_BUFFER_MIN = 12 * 60;

/**
 * The working pattern, in minutes from Monday midnight.
 *
 * Deliberately a few minutes off every hour. Real usage starts when someone
 * opens their editor, not on a chime, and a session wall sitting exactly on
 * 09:00 is the same tell as a weekly reset at 09:22 — it reads as generated.
 * The weekly reset below is the one boundary that *is* a whole hour, because
 * that one is assigned by Anthropic rather than produced by working.
 */
const WORK = [
  { from: MON + 9 * 60 + 3, to: MON + 11 * 60 + 58 }, // Mon 09:03 – 11:58
  { from: MON + 13 * 60 + 2, to: MON + 17 * 60 + 54 }, // Mon 13:02 – 17:54, after lunch
  { from: TUE + 9 * 60 + 4, to: TUE + 11 * 60 + 52 }, // Tue 09:04 – 11:52
  { from: TUE + 12 * 60 + 58, to: TUE + 16 * 60 + 11 }, // Tue 12:58 – 16:11, still going
];

/** NOW: the instant the last block stops, which is where the live line ends. */
const NOW_MIN = WORK[WORK.length - 1].to;

/**
 * The weekly reset: Wednesday 18:00, a whole hour and a day and a half past NOW.
 *
 * Whole hour because that is what the endpoint really reports — an account's
 * weekly boundary is a fixed slot assigned to it, landing exactly on the hour,
 * unlike the five-hour windows above which start whenever work started.
 *
 * The distance from NOW is the constraint that matters. Both markers carry text
 * along the top of the plot, `Now` and `Reset <date>`, and inside a day of each
 * other those captions collide and stop being readable.
 */
const WEEK_RESET_MIN = 2 * DAY_MIN + 18 * 60;
const MIN_RESET_GAP_MIN = 24 * 60;

/**
 * How hard each window was worked, and what that cost the weekly allowance.
 *
 * `peak` is where the five-hour pool ends up. `weeklyCost` is how much of the
 * weekly allowance one point of pool consumption spends — varied a little per
 * window so the weekly line changes slope instead of tracking the pool at one
 * fixed ratio, which is what a single number would look like and is not how the
 * two meters actually relate.
 *
 * **The costs are sized so a worked-through window spends around 8% of the week**,
 * which is what the weekly meter is observed to do in practice. It is the ratio
 * that carries the meaning here: a five-hour pool is exhausted by one hard
 * session while a weekly allowance is meant to absorb a dozen of them, so a
 * fixture where two days of work ate half the week would quietly misrepresent
 * how much headroom the plan has. They stay near each other rather than being
 * tuned per window, because weekly and pool usage both meter the same work — a
 * window that burned more pool should cost more week, not be dialled back to hit
 * a number.
 *
 * There is one weekly line and no per-model ones. A Pro plan meters every model
 * against a single allowance and reports no per-model window at all, so a
 * screenshot separating them would advertise a breakdown no Pro reader can
 * reproduce — and the graph now draws only the windows a plan really reports.
 * Give a frame a `models` map if you ever need to shoot a plan that does.
 */
const SHAPES = [
  { peak: 78, weeklyCost: 0.13 },
  { peak: 64, weeklyCost: 0.125 },
  { peak: 71, weeklyCost: 0.12 },
  { peak: 38, weeklyCost: 0.135 },
];

/**
 * The most recent Monday whose whole composition is already in the past.
 *
 * "In the past" is the load-bearing half. The fixture is replayed into a ledger
 * and then drawn with the clock pinned to `NOW_MIN`; a week that has not
 * finished happening would put that pinned instant in the future, where the
 * frame roll-forward in `liveFrameEnd` treats it as a cycle that has not closed
 * and the picture stops matching what the script describes.
 */
function fixtureWeekStart(at) {
  const monday = new Date(at);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  if (monday.getTime() + NOW_MIN * 60_000 > at) {
    monday.setDate(monday.getDate() - 7);
  }
  return monday;
}

const weekStart = fixtureWeekStart(Date.now());
const base = weekStart.getTime();

/**
 * The five-hour windows the working pattern implies, rather than a list.
 *
 * A window opens on the first use with none already open and runs five hours
 * whatever happens inside it, so where the walls land is a consequence of when
 * work started — not something to be chosen separately and kept in step by hand.
 * Monday's afternoon block spans one boundary and therefore spends two windows,
 * which is exactly the case worth having in a screenshot.
 */
function sessionWindows(work) {
  const windows = [];
  for (const block of work) {
    let at = block.from;
    while (at < block.to) {
      const open = windows[windows.length - 1];
      if (open === undefined || at >= open.reset) {
        windows.push({ start: at, reset: at + SESSION_MIN });
      }
      // Advance to whichever comes first: the block ending, or this window
      // closing and the next use after it opening a new one.
      at = Math.min(block.to, windows[windows.length - 1].reset);
    }
  }
  return windows.map((window, index) => ({
    ...window,
    ...SHAPES[Math.min(index, SHAPES.length - 1)],
    live: window.reset > NOW_MIN,
  }));
}

const WINDOWS = sessionWindows(WORK);

/** Minutes of actual work inside `[from, to)`. */
function activeMinutes(from, to) {
  let total = 0;
  for (const block of WORK) {
    total += Math.max(0, Math.min(to, block.to) - Math.max(from, block.from));
  }
  return total;
}

/**
 * Deterministic bursts. A pool that climbs at a constant rate looks generated;
 * real usage arrives in runs of work separated by plateaus, and the plateaus are
 * also what make the stepped line read as steps.
 */
function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * One window's frames: when it was polled, and where the pool had got to.
 *
 * The pool may only move on minutes that were actually worked, which is what
 * makes lunch a plateau rather than a slower climb, and what makes a finished
 * window run flat into its own wall. Weights are shares of the window's total
 * climb, so it lands on `peak` exactly however the bursts fell.
 */
function windowFrames(window, seed) {
  const random = lcg(seed);
  const last = window.live ? NOW_MIN : window.reset - 2;

  const times = [];
  for (let t = window.start; t < last; t += STEP_MIN) {
    times.push(t);
  }
  times.push(last);

  const weights = times.map((t, index) => {
    if (index === 0) {
      return 0;
    }
    const worked = activeMinutes(times[index - 1], t);
    // A quarter of worked steps are near-idle: reading, thinking, a build.
    return worked === 0 ? 0 : worked * (random() < 0.25 ? 0.12 : 0.5 + random() * 1.3);
  });

  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  let pool = 0;
  return times.map((t, index) => {
    pool += (weights[index] / sum) * window.peak;
    return { atMin: t, pool };
  });
}

const frames = [];
let total = 0;

WINDOWS.forEach((window, index) => {
  let previous = 0;
  for (const { atMin, pool } of windowFrames(window, 0x5eed + index * 977)) {
    // The weekly meter mirrors the pool: it moves on exactly the frames the pool
    // moved on, and by a proportion of the same spend. Anything else would draw
    // a weekly line that climbs through lunch and overnight, which is the one
    // thing the reader can check against graph 1 directly.
    total += (pool - previous) * window.weeklyCost;
    previous = pool;

    frames.push({
      atMin,
      five: Math.round(pool),
      fiveResetMin: window.reset,
      seven: Math.round(total),
      sevenResetMin: WEEK_RESET_MIN,
    });
  }
});

const stamp = (min) => {
  const d = new Date(base + min * 60_000);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};
const days = (min) => `${(min / 1440).toFixed(1)}d`;

// Sanity, not housekeeping: both of these are invisible in the JSON and only
// show up as a spoiled screenshot. The first is the caption collision above; the
// second is the frame running out on the other side, since graph 2 draws
// `[reset - 7d - 12h, reset + 12h]` and data earlier than that start is simply
// off the scale — clipping is a viewport, not an error, so nothing reports it.
const gapMin = WEEK_RESET_MIN - NOW_MIN;
const frameStartMin = WEEK_RESET_MIN - WEEK_MIN - FRAME_BUFFER_MIN;
if (gapMin < MIN_RESET_GAP_MIN) {
  throw new Error(`NOW is only ${days(gapMin)} before the reset; the captions would collide`);
}
if (frameStartMin > frames[0].atMin) {
  throw new Error(`the weekly frame starts at ${stamp(frameStartMin)}, after the first frame`);
}

const fixture = {
  description:
    'Generated by scripts/make-screenshot-fixture.mjs for README screenshots. Pinned to a past ' +
    `week starting ${weekStart.toDateString()}: offsets are minutes from that Monday's local ` +
    'midnight, and the extension freezes its clock at nowMin rather than drawing NOW at the real ' +
    'time. Regenerating only moves it forward a week, so the picture does not go stale.',
  baseDate: `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(
    weekStart.getDate(),
  ).padStart(2, '0')}`,
  nowMin: NOW_MIN,
  frames,
};

writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

console.log(`Wrote ${frames.length} frames to ${OUT}`);
console.log(`  week starts         ${stamp(0)}`);
console.log(`  now (pinned)        ${stamp(NOW_MIN)}`);
for (const block of WORK) {
  console.log(`  worked              ${stamp(block.from)} -> ${stamp(block.to)}`);
}
for (const window of WINDOWS) {
  console.log(
    `  5h window           ${stamp(window.start)} -> reset ${stamp(window.reset)}` +
      `${window.live ? '  (live at NOW)' : ''}`,
  );
}
console.log(`  weekly reset        ${stamp(WEEK_RESET_MIN)}  (${days(gapMin)} past NOW)`);
console.log(`  weekly ends at      ${Math.round(total)}%`);
