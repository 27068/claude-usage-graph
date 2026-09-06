// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { frameContains, markersInFrame } from '../../core/markers';
import { selectCalendarWeek, selectPoolDay } from '../../core/selectors';
import { SESSION_COLS } from '../../core/types';
import { WEEK_FIXTURE_COLS } from './helpers';
import type { LedgerFile, Millis } from '../../core/types';

const HOUR = 3_600_000;

/** Mid-May: comfortably clear of DST transitions in any common timezone. */
const at = (day: number, hour: number, minute = 0): Millis =>
  new Date(2026, 4, day, hour, minute, 0, 0).getTime();

function session(startAt: Millis): LedgerFile {
  return {
    v: 1,
    kind: 'five_hour',
    startAt,
    resetAt: startAt + 5 * HOUR,
    cols: [...SESSION_COLS],
    samples: [[startAt, 0]],
  };
}

function week(startAt: Millis, resetAt: Millis): LedgerFile {
  return {
    v: 1,
    kind: 'seven_day',
    startAt,
    resetAt,
    cols: [...WEEK_FIXTURE_COLS],
    samples: [[startAt, 10, 20, null, null]],
  };
}

/** Stands in for `nowMarker(now)`, which needs a document to read its colour. */
const marker = (x: Millis) => ({ x });

describe('markersInFrame', () => {
  const frame: readonly [Millis, Millis] = [at(20, 8), at(20, 18)];

  it('keeps a marker inside the frame and drops one outside it', () => {
    const kept = markersInFrame([marker(at(20, 12)), marker(at(20, 20))], frame);

    assert.deepStrictEqual(kept, [marker(at(20, 12))]);
  });

  // Graph 2's right buffer is measured from the closing reset, so a wall landing
  // exactly on a bound is the ordinary case, not an edge case.
  it('treats both bounds as inclusive', () => {
    const kept = markersInFrame([marker(frame[0]), marker(frame[1])], frame);

    assert.strictEqual(kept.length, 2);
  });

  it('drops a marker one millisecond outside either bound', () => {
    const kept = markersInFrame([marker(frame[0] - 1), marker(frame[1] + 1)], frame);

    assert.deepStrictEqual(kept, []);
  });

  it('preserves order and passes the whole marker through, not just its x', () => {
    const lines = [
      { x: at(20, 16), label: 'Reset 16:00' },
      { x: at(20, 10), label: 'Now' },
    ];

    assert.deepStrictEqual(markersInFrame(lines, frame), lines);
  });
});

/**
 * The claim the selectors owe the chart.
 *
 * Everything below composes the real selector with the real filter, because that
 * is the join that was broken and neither half showed it: the selector returned
 * a perfectly sensible frame, the filter correctly dropped a marker outside it,
 * and the result was a live chart with no Now line and nothing to say why.
 *
 * These do not prove Chart.js paints anything. They prove the marker survives as
 * far as the paint call, which is where the defect was.
 */
describe('Now survives the frame the selectors build', () => {
  describe('graph 1', () => {
    it('after the day\'s last session has reset', () => {
      // 07:00 session, reset 12:00, asked at 17:00. A frame ending at 13:00 would
      // put Now five hours off the right edge and the marker would be dropped.
      const now = at(20, 17);
      const view = selectPoolDay([session(at(20, 7))], now, now, 0);

      assert.ok(frameContains(view.domain, now));
      assert.strictEqual(markersInFrame([marker(now)], view.domain).length, 1);
    });

    it('while a session is open', () => {
      const now = at(20, 14);
      const view = selectPoolDay([session(at(20, 12))], now, now, 0);

      assert.strictEqual(markersInFrame([marker(now)], view.domain).length, 1);
    });

    it('on a quiet day with other days on record', () => {
      const now = at(20, 11);
      const view = selectPoolDay([session(at(19, 9))], now, now, 0);

      assert.strictEqual(view.sessionCount, 0, 'nothing ran today');
      assert.strictEqual(markersInFrame([marker(now)], view.domain).length, 1);
    });

    // The placeholder frame is 09:00-18:00, so both ends of the day fall outside
    // it before the frame is widened.
    it('on an empty ledger, early morning and late evening alike', () => {
      for (const now of [at(20, 6), at(20, 22)]) {
        const view = selectPoolDay([], now, now, 0);
        assert.strictEqual(
          markersInFrame([marker(now)], view.domain).length,
          1,
          `Now at ${new Date(now).toISOString()} fell outside the placeholder frame`,
        );
      }
    });

    it('when the day\'s only session has not started yet', () => {
      const now = at(20, 2);
      const view = selectPoolDay([session(at(20, 23))], now, now, 0);

      assert.strictEqual(markersInFrame([marker(now)], view.domain).length, 1);
    });

    it('still draws every reset wall the view reports', () => {
      const view = selectPoolDay([session(at(20, 7)), session(at(20, 13))], at(20, 17), at(20, 17), 0);
      const walls = view.resets.map((reset) => marker(reset.at));

      assert.ok(walls.length > 0);
      assert.strictEqual(markersInFrame(walls, view.domain).length, walls.length);
    });
  });

  describe('graph 2', () => {
    const RESET = at(21, 9);
    const weeks = [week(at(14, 9), RESET)];

    it('inside the recorded cycle', () => {
      const now = at(20, 14);
      const view = selectCalendarWeek(weeks, now, 0);

      assert.strictEqual(markersInFrame([marker(now)], view.domain).length, 1);
    });

    // Before the roll-forward the frame stayed anchored on the newest file, so a
    // fortnight away put Now well past the right buffer and the marker vanished.
    it('three cycles past the newest file on record', () => {
      const now = at(21 + 17, 12);
      const view = selectCalendarWeek(weeks, now, 0);

      assert.ok(frameContains(view.domain, now));
      assert.strictEqual(markersInFrame([marker(now)], view.domain).length, 1);
    });

    // Whatever walls a page reports must be drawable on it. The count varies now
    // that walls are read off the ledger — what must not vary is that none is
    // reported outside the frame that is meant to contain it.
    it('never reports a wall its own frame would drop', () => {
      const now = at(21 + 17, 12);

      for (let offset = 0; offset <= 4; offset += 1) {
        const view = selectCalendarWeek(weeks, now, offset);
        const walls = view.resets.map((reset) => marker(reset.at));

        assert.strictEqual(
          markersInFrame(walls, view.domain).length,
          walls.length,
          `offset ${offset} reported a wall outside its own domain`,
        );
        // Only the live page carries Now, and only it should contain it.
        assert.strictEqual(
          frameContains(view.domain, now),
          offset === 0,
          `offset ${offset} disagrees about whether it is the live page`,
        );
      }
    });

    it('draws the projected wall on the live page and nothing on a stale one', () => {
      const now = at(21 + 17, 12);

      const live = selectCalendarWeek(weeks, now, 0);
      const liveWalls = live.resets.map((reset) => marker(reset.at));
      assert.strictEqual(markersInFrame(liveWalls, live.domain).length, 1);

      const historical = selectCalendarWeek(weeks, now, 1);
      assert.deepStrictEqual(historical.resets, []);
    });

    it('draws the recorded wall on the page that recorded it', () => {
      const view = selectCalendarWeek(weeks, at(20, 14), 0);
      const walls = view.resets.map((reset) => marker(reset.at));

      assert.strictEqual(markersInFrame(walls, view.domain).length, 1);
      assert.strictEqual(walls[0].x, RESET, 'the wall sits on the boundary the file reported');
    });
  });
});
