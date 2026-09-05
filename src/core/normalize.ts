// SPDX-License-Identifier: AGPL-3.0-only

import type { Millis, UsageSnapshot, UsageWindow } from './types';

/**
 * The single place that knows the shape of `GET /api/oauth/usage`.
 *
 * That endpoint is undocumented and its beta header is dated, so the contract
 * can change without notice. Confining the wire format to one pure function
 * means a change costs one file and one fixture, not the architecture — and
 * everything upstream of here is exercised by the mock poller regardless.
 *
 * Observed payload:
 *
 *   { "five_hour":        { "utilization": 35.0, "resets_at": "2026-02-06T22:00:00+00:00" },
 *     "seven_day":        { "utilization": 14.0, "resets_at": "2026-02-12T20:00:00+00:00" },
 *     "seven_day_sonnet": { "utilization": 39.0, "resets_at": "2026-02-09T14:00:00+00:00" },
 *     "seven_day_opus":   null,
 *     "extra_usage":      { "is_enabled": true, "monthly_limit": 100000,
 *                           "used_credits": 0.0, "utilization": null } }
 *
 * `extra_usage` is deliberately dropped here: it is a monthly credit balance,
 * not a utilization window — its `utilization` is null in every payload observed
 * — so it has no place on an axis that reads as percent-of-window.
 *
 * Every field is treated as optional. A plan that lacks a window reports it as
 * `null` rather than omitting it, but we tolerate both, and an unparseable
 * window degrades to nulls instead of throwing away the whole poll.
 *
 * **The per-model windows are discovered, not enumerated.** Any `seven_day_*`
 * key is taken as a model window, whatever it is named, and nothing here knows
 * that Sonnet or Opus ever existed. Which tiers a payload carries is a property
 * of the plan and of whatever Anthropic is metering this month. An enumerated
 * list gets this wrong in both directions — it drops a tier it has not heard of
 * before the ledger ever sees it, and keeps charting empty series for tiers that
 * are no longer metered.
 *
 * `five_hour` goes null once its window lapses with nothing new run inside it —
 * null, not a zeroed window. The engine's `resets_at !== null` guard therefore
 * stops writing the session ledger at the last poll before the boundary, while
 * the week file keeps extending, so the two graphs legitimately end at different
 * times: graph 1 stops up to one poll interval short of its own reset wall and
 * graph 2 runs on to the last successful poll. Different right edges are that,
 * not a dropped sample.
 *
 * `utilization` is **not monotonic within a window**. Anthropic resets these
 * counters mid-cycle, unannounced, without moving `resets_at` — observed live as
 * a drop from 15% to 2% inside one weekly window. So a value that falls with no
 * matching change of boundary is upstream behaviour, not a ledger bug, and
 * nothing downstream may assume a series only climbs until it resets.
 */
export function normalizeSnapshot(raw: unknown, at: Millis): UsageSnapshot {
  const root = asRecord(raw);

  return {
    at,
    fiveHour: readWindow(root.five_hour),
    sevenDay: readWindow(root.seven_day),
    models: readModels(root),
  };
}

/** The `seven_day_*` keys, in payload order, excluding `seven_day` itself. */
const MODEL_PREFIX = 'seven_day_';

function readModels(root: Record<string, unknown>): UsageSnapshot['models'] {
  return Object.keys(root)
    .filter((key) => key.startsWith(MODEL_PREFIX) && key.length > MODEL_PREFIX.length)
    .map((key) => ({ key, window: readWindow(root[key]) }));
}

function readWindow(value: unknown): UsageWindow {
  const record = asRecord(value);
  return {
    utilization: readNumber(record.utilization),
    resetsAt: readTimestamp(record.resets_at),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Reset boundaries are quantized to this, see `readTimestamp`. */
const RESET_QUANTUM_MS = 60_000;

/**
 * ISO 8601 with an offset, e.g. `2026-02-06T22:00:00+00:00`.
 *
 * The value is rounded to the nearest minute, which is not cosmetic. Observed
 * live, `resets_at` jitters by several hundred milliseconds between consecutive
 * polls of the *same* window. Since a window's reset instant is what identifies
 * it — it names its file and decides when to roll onto a new one — raw jitter
 * straddling a minute boundary splits one session across two files. A five-hour
 * or seven-day boundary is not meaningful below minute precision anyway, so
 * rounding here makes the identity stable at the only place it is derived.
 *
 * This assumes the true boundary sits at or near a whole minute, which every
 * value observed so far does — the server appears to floor it. Were a boundary
 * ever to land within a second of a half-minute, rounding could still split a
 * window across two files. The symptom would be two ledger files whose resetAt
 * values differ by exactly 60000ms; the fix would be to treat a new boundary
 * within a few minutes of the open file's as the same window.
 */
function readTimestamp(value: unknown): Millis | null {
  if (typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return Math.round(parsed / RESET_QUANTUM_MS) * RESET_QUANTUM_MS;
}

/**
 * Column values for a session file, in `SESSION_COLS` order.
 * Kept beside the normalizer so column order is defined in exactly one place.
 */
export function sessionValues(snapshot: UsageSnapshot): Array<number | null> {
  return [snapshot.fiveHour.utilization];
}

/**
 * Column values for a week file, in **that file's** column order.
 *
 * Takes the columns rather than returning a fixed tuple because there is no
 * longer a fixed tuple to return: each file records the tiers that existed while
 * it was open. Reading the order off the file is what keeps a row aligned with
 * the header it is stored under, whoever wrote it — a file seeded by an older
 * build, or one that grew a column halfway through when a plan changed.
 *
 * A column the snapshot has no window for yields null rather than being skipped.
 * Skipping would shift every later value one slot left, which is the corruption
 * the append-only rule on `LedgerFile.cols` exists to prevent; null just says
 * "not metered at this poll", which is exactly what a retired tier — or the
 * legacy `extra_usage` column — means.
 */
export function weekValues(
  snapshot: UsageSnapshot,
  cols: readonly string[],
): Array<number | null> {
  return cols.map((col) => {
    if (col === 'seven_day') {
      return snapshot.sevenDay.utilization;
    }
    return snapshot.models.find((model) => model.key === col)?.window.utilization ?? null;
  });
}

/**
 * The model columns worth adding to a file: reported, and reported with a value.
 *
 * Waiting for a non-null reading is the whole reason Sonnet and Opus stop
 * appearing on a Pro plan. Both keys are present in every payload, so keying off
 * presence alone would seed both columns on day one and chart two permanently
 * empty series — the exact thing being removed. A column that never carries a
 * number never earns a place in the file.
 */
export function newModelCols(
  snapshot: UsageSnapshot,
  cols: readonly string[],
): string[] {
  return snapshot.models
    .filter((model) => model.window.utilization !== null && !cols.includes(model.key))
    .map((model) => model.key);
}
