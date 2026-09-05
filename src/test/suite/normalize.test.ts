// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { newModelCols, normalizeSnapshot, sessionValues, weekValues } from '../../core/normalize';
import { SESSION_COLS } from '../../core/types';

const AT = 1_770_400_800_000;

/** The payload shape observed from the live endpoint. */
const LIVE_PAYLOAD = {
  five_hour: { utilization: 35.0, resets_at: '2026-02-06T22:00:00+00:00' },
  seven_day: { utilization: 14.0, resets_at: '2026-02-12T20:00:00+00:00' },
  seven_day_sonnet: { utilization: 39.0, resets_at: '2026-02-09T14:00:00+00:00' },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, monthly_limit: 100000, used_credits: 0.0, utilization: null },
};

describe('normalizeSnapshot', () => {
  it('maps the documented payload field by field', () => {
    const snapshot = normalizeSnapshot(LIVE_PAYLOAD, AT);

    assert.strictEqual(snapshot.at, AT);
    assert.strictEqual(snapshot.fiveHour.utilization, 35);
    assert.strictEqual(snapshot.fiveHour.resetsAt, Date.parse('2026-02-06T22:00:00+00:00'));
    assert.strictEqual(snapshot.sevenDay.utilization, 14);
    assert.deepStrictEqual(snapshot.models, [
      { key: 'seven_day_sonnet', window: { utilization: 39, resetsAt: Date.parse('2026-02-09T14:00:00+00:00') } },
      { key: 'seven_day_opus', window: { utilization: null, resetsAt: null } },
    ]);
  });

  it('discovers a model tier it has never heard of', () => {
    const snapshot = normalizeSnapshot(
      { ...LIVE_PAYLOAD, seven_day_fable: { utilization: 7.0, resets_at: null } },
      AT,
    );

    assert.deepStrictEqual(
      snapshot.models.map((model) => model.key),
      ['seven_day_sonnet', 'seven_day_opus', 'seven_day_fable'],
    );
    assert.strictEqual(
      snapshot.models.find((model) => model.key === 'seven_day_fable')?.window.utilization,
      7,
    );
  });

  it('treats a null window as present-but-empty rather than throwing', () => {
    const snapshot = normalizeSnapshot(LIVE_PAYLOAD, AT);

    const opus = snapshot.models.find((model) => model.key === 'seven_day_opus');
    assert.deepStrictEqual(opus?.window, { utilization: null, resetsAt: null });
  });

  it('ignores the extra-usage block, which is credits rather than a window', () => {
    const snapshot = normalizeSnapshot(LIVE_PAYLOAD, AT);

    assert.deepStrictEqual(Object.keys(snapshot).sort(), ['at', 'fiveHour', 'models', 'sevenDay']);
    // `extra_usage` does not start with `seven_day_`, so discovery skips it.
    assert.strictEqual(
      snapshot.models.some((model) => model.key === 'extra_usage'),
      false,
    );
  });

  it('degrades an unparseable timestamp to null instead of NaN', () => {
    const snapshot = normalizeSnapshot({ five_hour: { utilization: 5, resets_at: 'tomorrow' } }, AT);

    assert.strictEqual(snapshot.fiveHour.resetsAt, null);
    assert.strictEqual(snapshot.fiveHour.utilization, 5);
  });

  it('rejects non-finite and non-numeric utilizations', () => {
    for (const bad of ['35', null, undefined, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const snapshot = normalizeSnapshot({ five_hour: { utilization: bad } }, AT);
      assert.strictEqual(snapshot.fiveHour.utilization, null, `accepted ${String(bad)}`);
    }
  });

  it('survives garbage at the root', () => {
    for (const junk of [null, undefined, 'nope', 42, []]) {
      const snapshot = normalizeSnapshot(junk, AT);
      assert.strictEqual(snapshot.fiveHour.utilization, null);
      assert.strictEqual(snapshot.at, AT);
    }
  });

  // Observed live: the endpoint returned resets_at values 755ms apart for the
  // same window on consecutive polls. Because that instant identifies the
  // window — naming its file and deciding when to roll onto a new one — jitter
  // across a minute boundary split one session into two files.
  it('quantizes reset boundaries so the same window keeps one identity', () => {
    const first = normalizeSnapshot(
      { five_hour: { utilization: 53, resets_at: '2026-09-01T14:59:59.717Z' } },
      AT,
    );
    const second = normalizeSnapshot(
      { five_hour: { utilization: 54, resets_at: '2026-09-01T15:00:00.472Z' } },
      AT,
    );

    assert.strictEqual(
      first.fiveHour.resetsAt,
      second.fiveHour.resetsAt,
      'sub-second jitter must not produce two different window identities',
    );
    assert.strictEqual(first.fiveHour.resetsAt as number, Date.parse('2026-09-01T15:00:00Z'));
  });

  it('quantizes the weekly boundary the same way', () => {
    const a = normalizeSnapshot({ seven_day: { utilization: 9, resets_at: '2026-09-07T22:59:59.900Z' } }, AT);
    const b = normalizeSnapshot({ seven_day: { utilization: 9, resets_at: '2026-09-07T23:00:00.100Z' } }, AT);
    assert.strictEqual(a.sevenDay.resetsAt, b.sevenDay.resetsAt);
  });

  it('leaves a boundary that is already on the minute untouched', () => {
    const exact = Date.parse('2026-02-06T22:00:00+00:00');
    const snapshot = normalizeSnapshot(
      { five_hour: { utilization: 1, resets_at: '2026-02-06T22:00:00+00:00' } },
      AT,
    );
    assert.strictEqual(snapshot.fiveHour.resetsAt, exact);
  });

  it('accepts a zero utilization as a real value, not a missing one', () => {
    const snapshot = normalizeSnapshot({ five_hour: { utilization: 0 } }, AT);
    assert.strictEqual(snapshot.fiveHour.utilization, 0);
  });
});

describe('column extraction', () => {
  it('produces one session value, matching SESSION_COLS', () => {
    const values = sessionValues(normalizeSnapshot(LIVE_PAYLOAD, AT));

    assert.strictEqual(values.length, SESSION_COLS.length);
    assert.deepStrictEqual(values, [35]);
  });

  it("produces week values in the file's own column order", () => {
    const snapshot = normalizeSnapshot(LIVE_PAYLOAD, AT);
    const values = weekValues(snapshot, ['seven_day', 'seven_day_sonnet', 'seven_day_opus']);

    assert.deepStrictEqual(values, [14, 39, null]);
  });

  it('follows the column order it is given rather than the payload order', () => {
    const snapshot = normalizeSnapshot(LIVE_PAYLOAD, AT);

    assert.deepStrictEqual(weekValues(snapshot, ['seven_day_sonnet', 'seven_day']), [39, 14]);
  });

  it('yields null for a column the payload has no window for', () => {
    const snapshot = normalizeSnapshot(LIVE_PAYLOAD, AT);
    // `extra_usage` is a column older builds wrote; a retired tier reads the
    // same way. Null holds the slot rather than shifting every later value left.
    assert.deepStrictEqual(weekValues(snapshot, ['seven_day', 'extra_usage', 'seven_day_sonnet']), [
      14,
      null,
      39,
    ]);
  });

  it('offers only the model columns that carry a number', () => {
    const snapshot = normalizeSnapshot(LIVE_PAYLOAD, AT);

    // Sonnet reports 39, so it earns a column; Opus is present-but-null on every
    // Pro poll and must never seed one, or it charts as a permanently empty line.
    assert.deepStrictEqual(newModelCols(snapshot, ['seven_day']), ['seven_day_sonnet']);
    assert.deepStrictEqual(newModelCols(snapshot, ['seven_day', 'seven_day_sonnet']), []);
  });
});
