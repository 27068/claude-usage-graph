// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { IDLE_GAP_MS, applySample } from '../../core/sampleRules';
import { SESSION_COLS } from '../../core/types';
import { WEEK_FIXTURE_COLS } from './helpers';
import type { LedgerFile } from '../../core/types';

const MINUTE = 60 * 1000;
const T0 = 1_770_400_800_000;

function sessionFile(): LedgerFile {
  return {
    v: 1,
    kind: 'five_hour',
    startAt: T0,
    resetAt: T0 + 5 * 60 * MINUTE,
    cols: [...SESSION_COLS],
    samples: [],
  };
}

function weekFile(): LedgerFile {
  return {
    v: 1,
    kind: 'seven_day',
    startAt: T0,
    resetAt: T0 + 7 * 24 * 60 * MINUTE,
    cols: [...WEEK_FIXTURE_COLS],
    samples: [],
  };
}

describe('applySample', () => {
  it('records the first sample as an anchor', () => {
    const file = sessionFile();
    const outcome = applySample(file, T0, [4]);

    assert.deepStrictEqual(outcome, { kind: 'anchor' });
    assert.deepStrictEqual(file.samples, [[T0, 4]]);
  });

  it('collapses a steady run to exactly two rows and slides the bookend', () => {
    const file = sessionFile();

    // Five ticks at the same value, three minutes apart.
    for (let tick = 0; tick < 5; tick += 1) {
      applySample(file, T0 + tick * 3 * MINUTE, [4]);
    }

    assert.strictEqual(file.samples.length, 2, 'a steady run must not grow the file');
    assert.deepStrictEqual(file.samples[0], [T0, 4], 'the anchor must not move');
    assert.deepStrictEqual(
      file.samples[1],
      [T0 + 12 * MINUTE, 4],
      'the bookend must sit at the latest observation',
    );
  });

  it('reports anchor, then append, then bookend for a steady run', () => {
    const file = sessionFile();

    assert.deepStrictEqual(applySample(file, T0, [4]), { kind: 'anchor' });
    assert.deepStrictEqual(applySample(file, T0 + MINUTE, [4]), { kind: 'append' });
    assert.deepStrictEqual(applySample(file, T0 + 2 * MINUTE, [4]), { kind: 'bookend' });
    assert.deepStrictEqual(applySample(file, T0 + 3 * MINUTE, [4]), { kind: 'bookend' });
  });

  it('appends without a break when the value changes while we are watching', () => {
    const file = sessionFile();
    applySample(file, T0, [4]);
    const outcome = applySample(file, T0 + 3 * MINUTE, [12]);

    assert.deepStrictEqual(outcome, { kind: 'append' });
    assert.deepStrictEqual(file.samples, [
      [T0, 4],
      [T0 + 3 * MINUTE, 12],
    ]);
  });

  it('breaks the line when the value changed AND we were away past the threshold', () => {
    const file = sessionFile();
    applySample(file, T0, [4]);
    const outcome = applySample(file, T0 + 30 * MINUTE, [40]);

    assert.deepStrictEqual(outcome, { kind: 'gap+append' });
    assert.deepStrictEqual(file.samples, [
      [T0, 4],
      [T0 + 1, null],
      [T0 + 30 * MINUTE, 40],
    ]);
  });

  it('anchors the break to the last observation, not to the new sample', () => {
    const file = sessionFile();
    applySample(file, T0, [4]);
    applySample(file, T0 + 5 * MINUTE, [4]); // bookend pair; last observation moves
    applySample(file, T0 + 60 * MINUTE, [40]);

    const breakRow = file.samples[2];
    assert.deepStrictEqual(
      breakRow,
      [T0 + 5 * MINUTE + 1, null],
      'the flat line must end where observation ended',
    );
  });

  // The discriminating test for "Time AND Value Change": elapsed time alone,
  // however long, is ordinary idleness and must never break the line.
  it('does NOT break the line when only time passed and the value held', () => {
    const file = sessionFile();
    applySample(file, T0, [4]);
    const outcome = applySample(file, T0 + 30 * MINUTE, [4]);

    assert.deepStrictEqual(outcome, { kind: 'append' });
    assert.strictEqual(file.samples.length, 2);
    assert.ok(
      !file.samples.some((sample) => sample[1] === null),
      'a steady value must never produce a break row',
    );
  });

  it('keeps a whole night of idleness at two rows with no break', () => {
    const file = sessionFile();
    applySample(file, T0, [4]);
    for (let hour = 1; hour <= 8; hour += 1) {
      applySample(file, T0 + hour * 60 * MINUTE, [4]);
    }

    assert.strictEqual(file.samples.length, 2);
    assert.deepStrictEqual(file.samples[1], [T0 + 8 * 60 * MINUTE, 4]);
  });

  it('treats exactly the threshold as not-yet-a-gap', () => {
    const file = sessionFile();
    applySample(file, T0, [4]);
    const outcome = applySample(file, T0 + IDLE_GAP_MS, [40]);

    assert.deepStrictEqual(outcome, { kind: 'append' }, 'the boundary is exclusive');
  });

  it('starts a fresh anchor/bookend pair when a value returns to a prior level', () => {
    const file = sessionFile();
    applySample(file, T0, [5]);
    applySample(file, T0 + MINUTE, [7]);
    applySample(file, T0 + 2 * MINUTE, [5]);
    applySample(file, T0 + 3 * MINUTE, [5]); // creates the bookend for the new run
    applySample(file, T0 + 4 * MINUTE, [5]); // slides it

    assert.deepStrictEqual(file.samples, [
      [T0, 5],
      [T0 + MINUTE, 7],
      [T0 + 2 * MINUTE, 5],
      [T0 + 4 * MINUTE, 5],
    ]);
  });

  it('compares every column of a multi-series week file', () => {
    const file = weekFile();
    applySample(file, T0, [14, 39, null, null]);
    // Only the Sonnet column moves: still a change, so still an append.
    const outcome = applySample(file, T0 + MINUTE, [14, 41, null, null]);

    assert.deepStrictEqual(outcome, { kind: 'append' });
    assert.strictEqual(file.samples.length, 2);
  });

  it('bookends a week file only when every column holds', () => {
    const file = weekFile();
    applySample(file, T0, [14, 39, null, null]);
    applySample(file, T0 + MINUTE, [14, 39, null, null]);
    applySample(file, T0 + 2 * MINUTE, [14, 39, null, null]);

    assert.strictEqual(file.samples.length, 2);
    assert.deepStrictEqual(file.samples[1], [T0 + 2 * MINUTE, 14, 39, null, null]);
  });

  it('nulls every column when it writes a break row', () => {
    const file = weekFile();
    applySample(file, T0, [14, 39, null, null]);
    applySample(file, T0 + 30 * MINUTE, [20, 45, null, null]);

    assert.deepStrictEqual(file.samples[1], [T0 + 1, null, null, null, null]);
  });

  it('skips an all-null sample rather than forging a break row', () => {
    const file = weekFile();
    applySample(file, T0, [14, 39, null, null]);
    const outcome = applySample(file, T0 + MINUTE, [null, null, null, null]);

    assert.deepStrictEqual(outcome, { kind: 'skipped' });
    assert.strictEqual(file.samples.length, 1, 'nothing should have been recorded');
  });

  it('never writes three consecutive identical rows over a long steady run', () => {
    const file = sessionFile();
    for (let tick = 0; tick < 200; tick += 1) {
      applySample(file, T0 + tick * 3 * MINUTE, [7]);
    }

    assert.strictEqual(file.samples.length, 2, '200 identical ticks must cost two rows');
  });
});
