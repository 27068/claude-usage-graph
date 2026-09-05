// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import {
  hourStepFor,
  localHourTicks,
  localMidnightTicks,
  localNoonTicks,
} from '../../core/ticks';

const HOUR = 3_600_000;

/** Mid-May: clear of DST transitions in any common timezone. */
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 4, day, hour, minute, 0, 0).getTime();

const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

describe('localHourTicks', () => {
  // The bug this exists to prevent: a Chart.js linear scale over epoch
  // milliseconds picks round *numbers*, e.g. a 5,000,000ms step, and draws
  // gridlines 83m20s apart at times like 22:16 and 23:40.
  it('puts every gridline on a whole hour', () => {
    const ticks = localHourTicks(at(20, 19, 43), at(21, 3, 17));

    assert.ok(ticks.length > 0);
    for (const tick of ticks) {
      const d = new Date(tick);
      assert.strictEqual(d.getMinutes(), 0, `${clock(tick)} is not on the hour`);
      assert.strictEqual(d.getSeconds(), 0);
      assert.strictEqual(d.getMilliseconds(), 0);
    }
  });

  it('spaces gridlines evenly', () => {
    const ticks = localHourTicks(at(20, 8), at(20, 16));
    const gaps = ticks.slice(1).map((tick, i) => tick - ticks[i]);

    assert.ok(gaps.length > 0);
    assert.strictEqual(new Set(gaps).size, 1, `uneven spacing: ${gaps.join(', ')}`);
  });

  it('stays inside the axis range', () => {
    const from = at(20, 19, 43);
    const to = at(21, 3, 17);

    for (const tick of localHourTicks(from, to)) {
      assert.ok(tick >= from && tick <= to, `${clock(tick)} is outside the frame`);
    }
  });

  it('aligns a multi-hour step to the day, not to where the axis begins', () => {
    // A 3-hour step must land on 00:00/03:00/06:00, never 01:00/04:00/07:00.
    const ticks = localHourTicks(at(20, 1, 30), at(21, 2));
    const step = hourStepFor(at(21, 2) - at(20, 1, 30));

    for (const tick of ticks) {
      assert.strictEqual(new Date(tick).getHours() % step, 0, `${clock(tick)} breaks alignment`);
    }
  });

  it('widens the step as the span grows, so a 31h axis stays readable', () => {
    assert.strictEqual(hourStepFor(6 * HOUR), 1);
    assert.strictEqual(hourStepFor(12 * HOUR), 2);
    assert.strictEqual(hourStepFor(24 * HOUR), 3);
    assert.strictEqual(hourStepFor(31 * HOUR), 4);
  });

  it('never returns an unreasonable number of gridlines', () => {
    const ticks = localHourTicks(at(20, 0), at(21, 5));
    assert.ok(ticks.length <= 12, `${ticks.length} gridlines is too many`);
  });

  it('crosses midnight without restarting', () => {
    const ticks = localHourTicks(at(20, 22), at(21, 4));
    const labels = ticks.map(clock);

    assert.ok(labels.includes('00:00'), `expected a midnight tick, got ${labels.join(' ')}`);
    assert.deepStrictEqual([...ticks].sort((a, b) => a - b), ticks, 'ticks must ascend');
  });

  it('handles a range too narrow to contain any whole hour', () => {
    const ticks = localHourTicks(at(20, 9, 10), at(20, 9, 50));
    assert.deepStrictEqual(ticks, [], 'no whole hour falls inside, so no gridlines');
  });
});

describe('localMidnightTicks', () => {
  it('returns one tick per local midnight in range', () => {
    const ticks = localMidnightTicks(at(18, 12), at(22, 12));

    assert.strictEqual(ticks.length, 4);
    for (const tick of ticks) {
      assert.strictEqual(clock(tick), '00:00');
    }
  });

  it('excludes a boundary that falls outside the frame', () => {
    const ticks = localMidnightTicks(at(20, 0), at(20, 23));
    assert.deepStrictEqual(ticks, [at(20, 0)], 'only the midnight actually inside');
  });
});

describe('localNoonTicks', () => {
  it('puts one label position in the middle of every whole day in range', () => {
    const ticks = localNoonTicks(at(18, 12), at(22, 12));

    assert.deepStrictEqual(ticks, [at(18, 12), at(19, 12), at(20, 12), at(21, 12), at(22, 12)]);
    for (const tick of ticks) {
      assert.strictEqual(clock(tick), '12:00');
    }
  });

  // The whole point of the second tick set: labels must not share a position
  // with the day boundary they would otherwise straddle.
  it('never collides with a midnight gridline', () => {
    const from = at(18, 6);
    const to = at(22, 6);
    const midnights = new Set(localMidnightTicks(from, to));

    for (const tick of localNoonTicks(from, to)) {
      assert.ok(!midnights.has(tick), `${clock(tick)} sits on a gridline`);
    }
  });

  it('leaves a clipped day at the frame edge unlabelled', () => {
    assert.deepStrictEqual(
      localNoonTicks(at(20, 13), at(21, 11)),
      [],
      'neither partial day contains its own noon',
    );
  });
});
