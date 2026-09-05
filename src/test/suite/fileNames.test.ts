// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import {
  namesAtOrBefore,
  namesForOverlap,
  namesForStartRange,
  toFileName,
} from '../../core/fileNames';

// `toFileName` itself — encoding, truncation, and the sort order every bound
// below rests on — is covered in `storage.test.ts` alongside `list`.
const MINUTE = 60_000;
const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 2, 1, 0, 0);

/** Names on the hour, every hour, from `BASE`. */
const HOURLY = Array.from({ length: 24 }, (_, i) => toFileName(BASE + i * HOUR));

describe('namesForStartRange', () => {
  it('returns exactly the names that can hold a start in the range', () => {
    const names = namesForStartRange(HOURLY, BASE + 3 * HOUR, BASE + 6 * HOUR);
    assert.deepStrictEqual(names, HOURLY.slice(3, 6));
  });

  // The range is half-open, so a file named on the closing instant begins at
  // that instant or later and can never be inside it. Opening it would be a
  // wasted read on every page, since every range this codebase asks for ends on
  // a whole minute — local midnights, and reset boundaries quantized to the
  // minute by `normalize`.
  it('leaves out the name on the closing instant', () => {
    const names = namesForStartRange(HOURLY, BASE + 3 * HOUR, BASE + 6 * HOUR);
    assert.ok(!names.includes(HOURLY[6]), '06:00 starts at 06:00, which is outside [03:00, 06:00)');
  });

  /**
   * The slack that cannot be removed, and the reason the caller still filters.
   *
   * A name fixes the minute a window began in, not the second, so the name at
   * `floor(from)` has to be opened even when the range starts partway through
   * that minute — the file might have started before `from`, and it might not.
   * Only the header knows.
   */
  it('opens the name the range starts inside, whichever way it turns out', () => {
    const names = namesForStartRange(HOURLY, BASE + 3 * HOUR + 30_000, BASE + 4 * HOUR);
    assert.deepStrictEqual(names, [HOURLY[3]], 'its start could be either side of 03:00:30');
  });

  it('is empty for a range with no files in it', () => {
    assert.deepStrictEqual(namesForStartRange(HOURLY, BASE - 5 * HOUR, BASE - HOUR), []);
    assert.deepStrictEqual(namesForStartRange(HOURLY, BASE + 99 * HOUR, BASE + 100 * HOUR), []);
  });

  it('is empty for an empty listing, and for an inverted range', () => {
    assert.deepStrictEqual(namesForStartRange([], BASE, BASE + HOUR), []);
    assert.deepStrictEqual(namesForStartRange(HOURLY, BASE + 6 * HOUR, BASE + 3 * HOUR), []);
  });

  /**
   * The property the whole design rests on, asserted as the property rather
   * than as an example: every file that *started* in the range must be among
   * the candidates, whatever second of whatever minute it started on. Miss one
   * and a session vanishes from its own day, which is exactly the class of bug
   * that had `fromFileName` deleted.
   */
  it('never misses a file whose start is inside the range', () => {
    const starts = [0, 1, 59_999, 60_000, 30 * 60_000 + 17, HOUR - 1, HOUR + 500].map(
      (offset) => BASE + offset,
    );
    const names = starts.map(toFileName).sort();

    for (const from of starts) {
      for (const to of starts.map((s) => s + 1)) {
        const page = namesForStartRange(names, from, to);
        for (const start of starts) {
          if (start >= from && start < to) {
            assert.ok(page.includes(toFileName(start)), `${start} missing from [${from}, ${to})`);
          }
        }
      }
    }
  });

  // Monotone in the range, which is the sanity check on the two floors: a wider
  // range can gain names and must never lose one.
  it('never drops a name when the range is widened', () => {
    const page = namesForStartRange(HOURLY, BASE + 3 * HOUR, BASE + 6 * HOUR);
    const wider = namesForStartRange(HOURLY, BASE + 3 * HOUR - 1, BASE + 6 * HOUR + 1);
    for (const name of page) {
      assert.ok(wider.includes(name), name);
    }
    assert.ok(wider.length >= page.length);
  });

  it('takes everything when the range covers the ledger', () => {
    assert.deepStrictEqual(namesForStartRange(HOURLY, BASE - HOUR, BASE + 24 * HOUR), HOURLY);
  });
});

describe('namesAtOrBefore', () => {
  it('returns the prefix at or below the instant', () => {
    assert.deepStrictEqual(namesAtOrBefore(HOURLY, BASE + 5 * HOUR), HOURLY.slice(0, 6));
  });

  it('is empty when every file is named after the instant', () => {
    assert.deepStrictEqual(namesAtOrBefore(HOURLY, BASE - MINUTE), []);
  });

  it('takes the whole listing when every file is named before it', () => {
    assert.deepStrictEqual(namesAtOrBefore(HOURLY, BASE + 99 * HOUR), HOURLY);
  });

  /**
   * The bound is on the name, and the name is `startAt` floored to the minute,
   * so a file named in the same minute as the cutoff has to be a candidate —
   * its window may have opened *before* the cutoff. It is read, and its header
   * decides. Excluding it here would be the one mistake that loses data.
   */
  it('includes a file named in the same minute as the instant', () => {
    const onTheMinute = toFileName(BASE + 5 * HOUR);
    assert.ok(namesAtOrBefore(HOURLY, BASE + 5 * HOUR + 30_000).includes(onTheMinute));
    assert.ok(namesAtOrBefore(HOURLY, BASE + 5 * HOUR).includes(onTheMinute));
  });

  it('never includes a file named after the instant, which is provably alive', () => {
    for (const name of namesAtOrBefore(HOURLY, BASE + 5 * HOUR)) {
      assert.ok(name <= toFileName(BASE + 5 * HOUR), name);
    }
  });

  it('is empty for an empty listing', () => {
    assert.deepStrictEqual(namesAtOrBefore([], BASE), []);
  });
});

describe('namesForOverlap', () => {
  it('reaches back exactly one name past the range', () => {
    const inRange = namesForStartRange(HOURLY, BASE + 5 * HOUR, BASE + 7 * HOUR);
    const overlapping = namesForOverlap(HOURLY, BASE + 5 * HOUR, BASE + 7 * HOUR);

    assert.deepStrictEqual(overlapping, [HOURLY[4], ...inRange], 'one, and only one');
  });

  /**
   * One is enough because windows of a kind do not overlap: of everything that
   * began before the range, only the last can still have been running when it
   * started. Two would be a claim about window length, which this must not make
   * — a weekly cycle that ran short or long would break it.
   */
  it('is the only candidate that can straddle the start', () => {
    const overlapping = namesForOverlap(HOURLY, BASE + 5 * HOUR, BASE + 7 * HOUR);
    assert.ok(!overlapping.includes(HOURLY[3]), 'that window had already closed');
  });

  it('does not walk off the front of the listing', () => {
    assert.deepStrictEqual(namesForOverlap(HOURLY, BASE, BASE + HOUR)[0], HOURLY[0]);
    assert.deepStrictEqual(namesForOverlap(HOURLY, BASE - 5 * HOUR, BASE - HOUR), []);
    assert.deepStrictEqual(namesForOverlap([], BASE, BASE + HOUR), []);
  });

  it('is never narrower than the start-range bound', () => {
    for (const offset of [0, 3, 11, 23]) {
      const from = BASE + offset * HOUR;
      const to = from + 2 * HOUR;
      for (const name of namesForStartRange(HOURLY, from, to)) {
        assert.ok(namesForOverlap(HOURLY, from, to).includes(name), name);
      }
    }
  });
});
