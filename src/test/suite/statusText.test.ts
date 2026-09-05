// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { formatRemaining, lastValue, statusBarModel } from '../../core/statusText';
import { SESSION_COLS } from '../../core/types';
import type { StatusBarInputs } from '../../core/statusText';
import type { LedgerFile, Millis, StatusEvent } from '../../core/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const NOW: Millis = new Date(2026, 4, 20, 14, 0, 0, 0).getTime();

function inputs(overrides: Partial<StatusBarInputs> = {}): StatusBarInputs {
  return {
    status: { state: 'ok' } as StatusEvent,
    now: NOW,
    five: 42,
    seven: 19,
    fiveResetAt: NOW + 2 * HOUR,
    sevenResetAt: NOW + 3 * 24 * HOUR,
    ...overrides,
  };
}

describe('statusBarModel', () => {
  it('shows both windows with their countdowns while a session is open', () => {
    const model = statusBarModel(inputs());

    assert.strictEqual(model.icon, 'graph-line');
    assert.strictEqual(model.label, '42% 2h 0m · 19% 3d 0h');
    assert.strictEqual(model.severity, 'none');
  });

  // The newest session file's last sample outlives the window it describes, so
  // after a reset the bar would report a pool that has gone. A null boundary is
  // the signal that it has closed.
  it('reports an expired pool as idle rather than repeating its last percentage', () => {
    const model = statusBarModel(inputs({ five: 3, fiveResetAt: null }));

    assert.ok(!model.label.includes('3%'), `a closed pool must not report a value: ${model.label}`);
    assert.strictEqual(model.label, 'idle · 19% 3d 0h');
  });

  it('says what idle means, and what to do about it, in the tooltip', () => {
    const model = statusBarModel(inputs({ five: 3, fiveResetAt: null }));

    assert.ok(model.tooltip.includes('no active session'), model.tooltip);
    assert.ok(!model.tooltip.includes('Session Usage: 3%'), 'the stale figure must not survive here either');
  });

  it('leaves the weekly window alone when only the pool has closed', () => {
    const model = statusBarModel(inputs({ fiveResetAt: null }));

    assert.ok(model.label.endsWith('19% 3d 0h'), model.label);
    assert.ok(model.tooltip.includes('Weekly Usage: 19%'), model.tooltip);
  });

  it('distinguishes a missing reading from a closed window', () => {
    // No value recorded, but a window IS open — that is a dash, not idle.
    const model = statusBarModel(inputs({ five: null }));

    assert.ok(model.label.startsWith('—'), model.label);
    assert.ok(!model.label.includes('idle'), model.label);
  });

  it('marks mock data without pretending it is a real reading', () => {
    const model = statusBarModel(inputs({ status: { state: 'mock' } }));

    assert.strictEqual(model.tooltip, 'Synthetic development data');
    assert.strictEqual(model.severity, 'none');
  });

  it('escalates a failed poll over whatever the numbers said', () => {
    const expired = statusBarModel(inputs({ status: { state: 'auth-error' } }));
    assert.strictEqual(expired.severity, 'error');
    assert.ok(!expired.label.includes('42%'), 'a failure state replaces the readings');

    const missing = statusBarModel(inputs({ status: { state: 'no-credentials' } }));
    assert.strictEqual(missing.severity, 'warning');

    const throttled = statusBarModel(inputs({ status: { state: 'rate-limited' } }));
    assert.strictEqual(throttled.severity, 'warning');
    assert.ok(throttled.tooltip.includes('Backing off'), throttled.tooltip);
  });

  // Reloading the window does not force a poll — it restarts the extension host
  // and the first tick happens on the same cadence it would have anyway. Telling
  // people to reload therefore bought them nothing and implied that waiting
  // would not work. Both auth states must instead name the bound they resume
  // within, which is one poll interval.
  it('tells both auth states how long a resume takes, and never to reload', () => {
    for (const state of ['no-credentials', 'auth-error'] as const) {
      const { tooltip } = statusBarModel(inputs({ status: { state } }));

      assert.ok(/resumes on its own within \d+ minutes/.test(tooltip), tooltip);
      assert.ok(!/reload/i.test(tooltip) || /no reload needed/.test(tooltip), tooltip);
    }
  });

  it('carries a poller message through on a network failure', () => {
    const model = statusBarModel(
      inputs({ status: { state: 'network-error', message: 'ENOTFOUND api.anthropic.com' } }),
    );

    assert.strictEqual(model.icon, 'cloud-offline');
    assert.strictEqual(model.tooltip, 'ENOTFOUND api.anthropic.com');
  });
});

describe('formatRemaining', () => {
  it('drops the minute once the wait is measured in days', () => {
    assert.strictEqual(formatRemaining(3 * 24 * HOUR + 16 * HOUR + 41 * MINUTE), '3d 16h');
  });

  it('keeps hours and minutes below a day', () => {
    assert.strictEqual(formatRemaining(2 * HOUR + 41 * MINUTE), '2h 41m');
    assert.strictEqual(formatRemaining(41 * MINUTE), '41m');
  });

  // Truncating rather than rounding: the figure must never claim more time than
  // is actually left.
  it('never rounds a countdown upward', () => {
    assert.strictEqual(formatRemaining(59 * MINUTE + 59_000), '59m');
  });

  it('floors a passed boundary at zero instead of going negative', () => {
    assert.strictEqual(formatRemaining(-5 * HOUR), '0m');
  });
});

describe('lastValue', () => {
  const file = (samples: Array<Array<number | null>>): LedgerFile => ({
    v: 1,
    kind: 'five_hour',
    startAt: NOW,
    resetAt: NOW + 5 * HOUR,
    cols: [...SESSION_COLS],
    samples: samples as LedgerFile['samples'],
  });

  it('reads the newest reading in the column', () => {
    assert.strictEqual(lastValue(file([[NOW, 2], [NOW + MINUTE, 7]]), 0), 7);
  });

  // A dead-zone break is a null row. It marks the end of what we saw, not a
  // reading of zero, so the search has to walk back past it.
  it('skips a dead-zone break to find the last real reading', () => {
    assert.strictEqual(lastValue(file([[NOW, 5], [NOW + MINUTE, null]]), 0), 5);
  });

  it('returns null for an absent file and for one holding nothing but nulls', () => {
    assert.strictEqual(lastValue(undefined, 0), null);
    assert.strictEqual(lastValue(file([[NOW, null]]), 0), null);
  });

  it('reads the requested column, not the first one', () => {
    const weekFile: LedgerFile = {
      v: 1,
      kind: 'seven_day',
      startAt: NOW,
      resetAt: NOW + 7 * 24 * HOUR,
      cols: ['seven_day', 'seven_day_sonnet', 'seven_day_opus'],
      samples: [[NOW, 11, 30, null]] as LedgerFile['samples'],
    };

    assert.strictEqual(lastValue(weekFile, 0), 11);
    assert.strictEqual(lastValue(weekFile, 1), 30);
    assert.strictEqual(lastValue(weekFile, 2), null);
  });
});
