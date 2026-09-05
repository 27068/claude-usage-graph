// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import {
  CALENDAR_BUFFER_MS,
  POOL_BUFFER_MS,
  calendarFrameRange,
  maxDayOffset,
  maxWeekOffset,
  poolDayRange,
  selectCalendarWeek,
  selectPoolDay,
} from '../../core/selectors';
import { WEEK_MS } from '../../core/windows';
import { localDayKey, startOfLocalDay } from '../../core/sessions';
import { SESSION_COLS } from '../../core/types';
import { WEEK_FIXTURE_COLS } from './helpers';
import type { LedgerFile, Millis } from '../../core/types';

const HOUR = 3_600_000;

/** Mid-May: comfortably clear of DST transitions in any common timezone. */
const at = (day: number, hour: number, minute = 0): Millis =>
  new Date(2026, 4, day, hour, minute, 0, 0).getTime();

const NOW = at(20, 14);

function session(startAt: Millis, values: Array<[Millis, number | null]> = []): LedgerFile {
  return {
    v: 1,
    kind: 'five_hour',
    startAt,
    resetAt: startAt + 5 * HOUR,
    cols: [...SESSION_COLS],
    samples: values.length > 0 ? values.map(([t, v]) => [t, v] as [Millis, number | null]) : [[startAt, 0]],
  };
}

function week(startAt: Millis, resetAt: Millis, rows: Array<[Millis, ...(number | null)[]]> = []): LedgerFile {
  return {
    v: 1,
    kind: 'seven_day',
    startAt,
    resetAt,
    cols: [...WEEK_FIXTURE_COLS],
    samples: rows.length > 0 ? rows : [[startAt, 10, 20, null, null]],
  };
}

describe('selectPoolDay', () => {
  it('clips the axis to the sessions that exist, not to midnight', () => {
    // Asked at 11:00, inside the session — so the frame is decided by the data
    // alone and the Now rule below has nothing to add.
    const view = selectPoolDay([session(at(20, 7))], at(20, 11), 0);

    assert.strictEqual(view.empty, false);
    assert.strictEqual(view.domain[0], at(20, 7) - POOL_BUFFER_MS, 'a 07:00 start should frame from 06:00');
    assert.strictEqual(view.domain[1], at(20, 12) + POOL_BUFFER_MS);
  });

  // A frame ending an hour after the day's last reset would leave Now off the
  // scale, where charts.ts drops the marker and the chart stops looking live
  // without saying so.
  it('stretches the live frame to reach Now after the last session has reset', () => {
    // 07:00 session, reset 12:00, asked at 17:00.
    const view = selectPoolDay([session(at(20, 7))], at(20, 17), 0);

    assert.strictEqual(view.domain[0], at(20, 7) - POOL_BUFFER_MS, 'the left edge still follows the data');
    assert.strictEqual(view.domain[1], at(20, 17) + POOL_BUFFER_MS, 'the right edge must clear Now');
  });

  it('leaves the frame alone while a window is still open', () => {
    // 12:00 session resets at 17:00, which is already past Now at 14:00.
    const view = selectPoolDay([session(at(20, 12))], at(20, 14), 0);

    assert.strictEqual(view.domain[1], at(20, 17) + POOL_BUFFER_MS, 'the reset frames it, not Now');
  });

  it('reaches back to Now on a day whose only session starts later', () => {
    // Asked at 02:00; the day's session does not begin until 23:00.
    const view = selectPoolDay([session(at(20, 23))], at(20, 2), 0);

    assert.ok(view.domain[0] <= at(20, 2), 'Now must be inside the frame, not off the left edge');
  });

  it('puts Now inside the placeholder frame for an empty today', () => {
    // The placeholder is 09:00-18:00, so an early morning or late evening Now
    // falls outside it.
    const early = selectPoolDay([], at(20, 6), 0);
    assert.strictEqual(early.empty, true);
    assert.ok(early.domain[0] <= at(20, 6), 'a 06:00 Now must be on the axis');

    const late = selectPoolDay([], at(20, 22), 0);
    assert.ok(late.domain[1] >= at(20, 22), 'a 22:00 Now must be on the axis');
  });

  // Historical pages must stay perfectly still; only the live page tracks Now.
  it('never moves a historical frame to chase Now', () => {
    const view = selectPoolDay([session(at(19, 7))], at(20, 17), 1);

    assert.strictEqual(view.domain[0], at(19, 7) - POOL_BUFFER_MS);
    assert.strictEqual(view.domain[1], at(19, 12) + POOL_BUFFER_MS);
  });

  it('pads exactly one hour on each side', () => {
    const view = selectPoolDay([session(at(20, 9))], NOW, 0);
    const span = view.domain[1] - view.domain[0];
    assert.strictEqual(span, 5 * HOUR + 2 * POOL_BUFFER_MS);
  });

  it('spans from the earliest start to the latest reset across several sessions', () => {
    const view = selectPoolDay(
      [session(at(20, 8)), session(at(20, 13)), session(at(20, 18))],
      NOW,
      0,
    );

    assert.strictEqual(view.sessionCount, 3);
    assert.strictEqual(view.domain[0], at(20, 8) - POOL_BUFFER_MS);
    assert.strictEqual(view.domain[1], at(20, 23) + POOL_BUFFER_MS);
  });

  // A session belongs to the day it STARTED on, even when it runs past midnight.
  it('files a 23:00 session under the day it started, not the day it ends', () => {
    const late = session(at(20, 23)); // resets 04:00 on the 21st
    const view = selectPoolDay([late], NOW, 0);

    assert.strictEqual(view.sessionCount, 1, 'the late session belongs to the 20th');
    assert.strictEqual(view.domain[1], at(21, 4) + POOL_BUFFER_MS, 'the axis must follow it past midnight');
  });

  it('files a 01:00 session under the new day', () => {
    const early = session(at(21, 1));

    assert.strictEqual(selectPoolDay([early], NOW, 0).sessionCount, 0, 'not the 20th');
    assert.strictEqual(selectPoolDay([early], at(21, 12), 0).sessionCount, 1, 'the 21st');
  });

  it('reaches ~31 hours when a day runs from midnight through the overhang', () => {
    const view = selectPoolDay([session(at(20, 0)), session(at(20, 23, 59))], NOW, 0);
    const span = view.domain[1] - view.domain[0];

    assert.ok(span > 30 * HOUR, `expected a ~31h span, got ${span / HOUR}h`);
    assert.ok(span <= 31 * HOUR, `span must not exceed 29h of data plus two buffers`);
  });

  it('clamps the right edge to 05:00 the following morning', () => {
    const overrunning: LedgerFile = { ...session(at(20, 23)), resetAt: at(21, 9) };
    const view = selectPoolDay([overrunning], NOW, 0);

    assert.strictEqual(view.domain[1], at(21, 5) + POOL_BUFFER_MS, 'the overhang ceiling is 05:00');
  });

  // Symmetrical with Graph 2: a quiet day still has a frame, a label and Now, so
  // it draws blank rather than hiding behind a placeholder.
  it('does not call a quiet day empty when other days are on record', () => {
    const view = selectPoolDay([session(at(19, 9))], NOW, 0);

    assert.strictEqual(view.sessionCount, 0, 'nothing today');
    assert.strictEqual(view.empty, false, 'but the ledger is not empty');
  });

  it('reports empty only when no session has ever been recorded', () => {
    assert.strictEqual(selectPoolDay([], NOW, 0).empty, true);
    assert.strictEqual(selectPoolDay([session(at(1, 9))], NOW, 0).empty, false);
  });

  it('gives an empty day a usable frame rather than a degenerate axis', () => {
    const view = selectPoolDay([], NOW, 0);

    assert.strictEqual(view.empty, true);
    assert.strictEqual(view.sessionCount, 0);
    assert.ok(view.domain[1] > view.domain[0], 'the axis must still have width');
    assert.strictEqual(view.label, 'Wed, May 20');
  });

  it('walks back one day per offset', () => {
    assert.strictEqual(selectPoolDay([], NOW, 0).dayKey, localDayKey(at(20, 0)));
    assert.strictEqual(selectPoolDay([], NOW, 1).dayKey, localDayKey(at(19, 0)));
    assert.strictEqual(selectPoolDay([], NOW, 7).dayKey, localDayKey(at(13, 0)));
  });

  it('uses the same Reset wording on both graphs', () => {
    const pool = selectPoolDay([session(at(20, 8))], NOW, 0);
    const calendar = selectCalendarWeek(
      [week(at(14, 9), at(21, 9), [[at(15, 10), 14, 39, null, null]])],
      NOW,
      0,
    );

    assert.ok(pool.resets[0].label.startsWith('Reset '));
    assert.ok(calendar.resets.every((reset) => reset.label.startsWith('Reset ')));
  });

  it('exposes each session reset so Graph 1 can draw its walls', () => {
    const view = selectPoolDay([session(at(20, 8)), session(at(20, 14))], NOW, 0);

    assert.deepStrictEqual(view.resets, [
      { at: at(20, 13), label: 'Reset 13:00' },
      { at: at(20, 19), label: 'Reset 19:00' },
    ]);
  });

  it('omits a reset that the overhang ceiling clipped off the frame', () => {
    const overrunning: LedgerFile = { ...session(at(20, 23)), resetAt: at(21, 9) };
    const view = selectPoolDay([overrunning], NOW, 0);

    assert.deepStrictEqual(view.resets, [], 'a wall beyond 05:00 would sit off the edge');
  });

  it('renders a single sample as a plottable point', () => {
    // A brand-new ledger has exactly one row; the view must still be non-empty.
    const view = selectPoolDay([session(at(20, 9), [[at(20, 9), 53]])], NOW, 0);

    assert.strictEqual(view.empty, false);
    assert.deepStrictEqual(view.series[0].points, [{ x: at(20, 9), y: 53 }]);
  });

  it('breaks the line between sessions instead of connecting them', () => {
    const view = selectPoolDay([session(at(20, 8)), session(at(20, 14))], NOW, 0);
    const points = view.series[0].points;

    const nulls = points.filter((point) => point.y === null);
    assert.strictEqual(nulls.length, 1, 'exactly one separator between two sessions');
    assert.ok(
      points.findIndex((p) => p.y === null) > 0,
      'the separator must not be the first point',
    );
  });

  it('carries a within-session gap row through as a break', () => {
    const withGap = session(at(20, 8), [
      [at(20, 8), 4],
      [at(20, 8, 30) + 1, null],
      [at(20, 9), 40],
    ]);
    const view = selectPoolDay([withGap], NOW, 0);

    assert.deepStrictEqual(
      view.series[0].points.map((point) => point.y),
      [4, null, 40],
    );
  });

  // The no-jump guarantee: a historical page must be byte-identical across
  // refreshes, so assigning the domain on an update is a no-op.
  it('returns an identical domain for a historical page as new data arrives', () => {
    const history = [session(at(18, 9))];
    const before = selectPoolDay(history, NOW, 2);

    // A background tick adds today's session and extends an existing one.
    const after = selectPoolDay([...history, session(at(20, 15))], at(20, 16), 2);

    assert.deepStrictEqual(after.domain, before.domain);
    assert.deepStrictEqual(after.dayKey, before.dayKey);
    assert.deepStrictEqual(after.series, before.series);
  });
});

describe('selectCalendarWeek', () => {
  const RESET = at(21, 9);
  const weeks = [week(at(14, 9), RESET, [[at(15, 10), 14, 39, null, null]])];

  // `startAt` is derived by subtracting WEEK_MS; `resetAt` is what the API said.
  // Ordering by the derived value would mean a cycle of some other length sorted
  // by an assumption about itself, so the newest file must be found by boundary.
  it('finds the newest cycle by its observed reset, not by its derived start', () => {
    const scrambled = [
      { ...week(0, RESET), startAt: at(30, 9) },
      { ...week(0, RESET - WEEK_MS), startAt: at(1, 9) },
    ];

    const view = selectCalendarWeek(scrambled, NOW, 0);

    assert.strictEqual(view.resetAt, RESET, 'the later boundary wins despite the earlier start');
  });

  it('frames the cycle with 12-hour buffers on both sides', () => {
    const view = selectCalendarWeek(weeks, NOW, 0);

    assert.strictEqual(view.domain[0], RESET - WEEK_MS - CALENDAR_BUFFER_MS);
    assert.strictEqual(view.domain[1], RESET + CALENDAR_BUFFER_MS);
  });

  it('places the reset wall on the reported boundary and labels it', () => {
    const view = selectCalendarWeek(weeks, NOW, 0);

    assert.strictEqual(view.resetAt, RESET);
    assert.deepStrictEqual(view.resets, [{ at: RESET, label: 'Reset May 21, 09:00' }]);
  });

  // A wall is a measurement. The frame's own edges are arithmetic, and drawing
  // them would let that arithmetic read as evidence of a boundary nobody saw.
  it('draws a wall only where a file actually recorded one', () => {
    const opening = week(at(7, 9), RESET - WEEK_MS);
    const view = selectCalendarWeek([opening, ...weeks], NOW, 0);

    assert.deepStrictEqual(
      view.resets.map((reset) => reset.at),
      [RESET - WEEK_MS, RESET],
      'now that both boundaries are on record, both are drawn',
    );
    // The 12-hour buffers are exactly what makes room for them.
    for (const reset of view.resets) {
      assert.ok(reset.at >= view.domain[0] && reset.at <= view.domain[1]);
    }
  });

  it('leaves the opening edge unmarked when nothing recorded that boundary', () => {
    const view = selectCalendarWeek(weeks, NOW, 0);

    assert.strictEqual(view.resets.length, 1, 'only the boundary the ledger holds');
    assert.ok(view.resets.every((reset) => reset.at !== RESET - WEEK_MS));
  });

  it('pages back exactly one week per offset', () => {
    const view = selectCalendarWeek(weeks, NOW, 2);

    assert.strictEqual(view.resetAt, RESET - 2 * WEEK_MS);
    assert.strictEqual(view.domain[1], RESET - 2 * WEEK_MS + CALENDAR_BUFFER_MS);
  });

  it('exposes only the columns that carry a reading', () => {
    // The fixture rows are [seven_day, sonnet, opus, extra_usage] = [10, 20,
    // null, null]. Opus is charted nowhere because it never reports a number —
    // the Pro case — and `extra_usage` is barred by name whatever it holds,
    // being a credit balance rather than a percentage of a window.
    const view = selectCalendarWeek(weeks, NOW, 0);
    assert.deepStrictEqual(
      view.series.map((series) => series.key),
      ['seven_day', 'seven_day_sonnet'],
    );
  });

  it('splits each column into its own series', () => {
    // The trailing 2 is a fourth value written before `extra_usage` was dropped.
    // Columns are read positionally, so an old row still maps onto the current
    // series without a migration — the surplus slot is simply never read.
    const view = selectCalendarWeek(
      [week(at(14, 9), RESET, [[at(15, 10), 14, 39, 7, 2]])],
      NOW,
      0,
    );

    assert.deepStrictEqual(view.series.map((s) => s.points[0].y), [14, 39, 7]);
  });

  // A cycle we hold no samples for is still a cycle we can describe, because the
  // period is fixed. Reporting it as "no data" would hide the frame behind a
  // placeholder for the ordinary case of paging back past what is on disk.
  it('frames and labels a cycle it holds no samples for, without calling it empty', () => {
    const view = selectCalendarWeek(weeks, NOW, 5);

    assert.strictEqual(view.empty, false);
    assert.ok(view.domain[1] > view.domain[0]);
    assert.strictEqual(view.resetAt, RESET - 5 * WEEK_MS);
    assert.deepStrictEqual(view.resets, [], 'a historical week with no data gets no guessed walls');
    assert.ok(view.series.every((entry) => entry.points.length === 0));
  });

  // The one exception, and the reason it is one: the cycle being spent right now
  // is the one whose end is worth knowing even when nothing has been recorded.
  it('projects a wall for the live page alone, and says it is expected', () => {
    const away = at(21 + 17, 12);

    const live = selectCalendarWeek(weeks, away, 0);
    assert.strictEqual(live.resets.length, 1);
    assert.strictEqual(live.resets[0].at, live.resetAt);
    assert.ok(live.resets[0].label.startsWith('Expected reset'), live.resets[0].label);

    const historical = selectCalendarWeek(weeks, away, 1);
    assert.deepStrictEqual(historical.resets, [], 'no fallback once you page back');
  });

  it('prefers the recorded wall over the projection when the frame holds one', () => {
    const view = selectCalendarWeek(weeks, NOW, 0);

    assert.strictEqual(view.resets.length, 1);
    assert.ok(view.resets[0].label.startsWith('Reset '), view.resets[0].label);
    assert.ok(!view.resets[0].label.includes('Expected'), 'this one was measured');
  });

  // The recorded boundary goes stale the moment it passes. Anchoring there put
  // Now off the right-hand edge, where charts.ts drops the marker.
  it('rolls the anchor forward to the cycle running now', () => {
    // RESET is May 21 09:00, so the third cycle after it closes on Jun 11 09:00.
    // Jun 7 sits inside that cycle.
    const away = at(21 + 17, 12);
    const view = selectCalendarWeek(weeks, away, 0);

    assert.strictEqual(view.resetAt, RESET + 3 * WEEK_MS);
    assert.ok(view.domain[0] <= away && away <= view.domain[1], 'Now must be inside the live frame');
    assert.strictEqual(view.empty, false, 'a projected cycle is framed, not blanked');
  });

  it('leaves the anchor alone while the recorded cycle is still running', () => {
    const view = selectCalendarWeek(weeks, NOW, 0);

    assert.strictEqual(view.resetAt, RESET);
  });

  // A boundary landing exactly on now has just closed a cycle; the live one runs
  // for a further week.
  it('steps past a boundary that falls exactly on now', () => {
    const view = selectCalendarWeek(weeks, RESET, 0);

    assert.strictEqual(view.resetAt, RESET + WEEK_MS);
  });

  it('pages back from the live cycle, not from the newest file', () => {
    // May 31 falls in the cycle closing on Jun 4 09:00, which is RESET + 2 weeks.
    const away = at(21 + 10, 12);
    const view = selectCalendarWeek(weeks, away, 1);

    assert.strictEqual(view.resetAt, RESET + WEEK_MS, 'one cycle back from the live one');
  });

  it('survives having no weekly data at all', () => {
    const view = selectCalendarWeek([], NOW, 0);

    assert.strictEqual(view.empty, true);
    assert.strictEqual(view.resetAt, null);
    // Nothing has reported a column yet, so there is no series to name.
    assert.deepStrictEqual(view.series, []);
  });

  it('holds a historical page steady as new data arrives', () => {
    const before = selectCalendarWeek(weeks, NOW, 1);
    const grown = [...weeks, week(RESET, RESET + WEEK_MS, [[at(22, 10), 3, 1, null, null]])];
    const after = selectCalendarWeek(grown, at(22, 11), 2);

    assert.deepStrictEqual(after.domain, before.domain, 'paging back must track the same cycle');
  });
});

describe('local day arithmetic', () => {
  it('normalises any instant in a day to the same key', () => {
    assert.strictEqual(localDayKey(at(20, 0)), localDayKey(at(20, 23, 59)));
    assert.notStrictEqual(localDayKey(at(20, 23, 59)), localDayKey(at(21, 0)));
  });

  it('starts a day at local midnight', () => {
    assert.strictEqual(startOfLocalDay(at(20, 17, 42)), at(20, 0));
  });
});

/**
 * The clamps the back buttons disable on.
 *
 * Checked against the range functions rather than against arithmetic written out
 * a second time: the property that matters is that the last page the clamp
 * allows is the last page that has anything in it, and the only way to state
 * that without restating the formula is to fetch the frame and look.
 */
describe('paging limits', () => {
  describe('maxDayOffset', () => {
    it('is zero when the oldest session is today', () => {
      assert.strictEqual(maxDayOffset(NOW, at(20, 2)), 0);
    });

    it('counts whole local days back to the day the oldest session began', () => {
      assert.strictEqual(maxDayOffset(NOW, at(13, 23, 30)), 7);
    });

    it('lands on the day holding the oldest session, and one past it does not', () => {
      const oldest = at(4, 8);
      const limit = maxDayOffset(NOW, oldest);

      assert.ok(poolDayRange(NOW, limit)[0] <= oldest, 'the limit page contains it');
      assert.ok(poolDayRange(NOW, limit)[1] > oldest);
      assert.ok(poolDayRange(NOW, limit + 1)[1] <= oldest, 'one further back is empty');
    });

    // Ahead of `now` only through a clock that moved, or a fixture written into
    // the future. Never negative: the forward clamp is offset 0 and this must
    // not undercut it.
    it('never goes below zero', () => {
      assert.strictEqual(maxDayOffset(NOW, at(25, 9)), 0);
    });
  });

  describe('maxWeekOffset', () => {
    const phase = at(23, 9); // the live boundary, still ahead of NOW

    it('is zero when the only cycle on record is the live one', () => {
      assert.strictEqual(maxWeekOffset(phase, NOW, phase - WEEK_MS), 0);
    });

    it('counts one page per whole cycle behind the live frame', () => {
      assert.strictEqual(maxWeekOffset(phase, NOW, phase - 4 * WEEK_MS), 3);
    });

    it('stops on the frame that still overlaps the oldest cycle', () => {
      const oldest = phase - 5 * WEEK_MS;
      const limit = maxWeekOffset(phase, NOW, oldest);
      const cycleEnd = oldest + WEEK_MS;

      assert.ok(calendarFrameRange(phase, NOW, limit)[0] < cycleEnd, 'the limit frame shows it');
      assert.ok(
        calendarFrameRange(phase, NOW, limit + 1)[1] <= oldest + CALENDAR_BUFFER_MS,
        'one further back has run out of cycles',
      );
    });

    // A cycle that began off-phase — the boundary shifted mid-history — still
    // gets a frame rather than being rounded off the end of the ledger.
    it('keeps a frame for an oldest cycle that does not sit on the phase', () => {
      const oldest = phase - 3 * WEEK_MS - 2 * 24 * HOUR;
      assert.strictEqual(maxWeekOffset(phase, NOW, oldest), 3);
    });

    // The frame is anchored to the *current* cycle, which a recorded boundary
    // that has already passed is not — `liveFrameEnd` projects forward to it. So
    // a ledger that stopped a fortnight ago still pages back through its cycles,
    // and offset 0 is the empty cycle in progress rather than the last one held.
    it('projects forward from a boundary that has already passed', () => {
      const stale = at(6, 9);
      assert.strictEqual(maxWeekOffset(stale, NOW, stale - WEEK_MS), 3);
    });

    it('never goes below zero', () => {
      assert.strictEqual(maxWeekOffset(phase, NOW, phase + WEEK_MS), 0);
    });
  });
});
