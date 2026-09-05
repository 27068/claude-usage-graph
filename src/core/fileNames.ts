// SPDX-License-Identifier: AGPL-3.0-only

import type { Millis } from './types';

/**
 * Ledger files are named for the instant they start, in UTC basic format:
 * `2026-02-06T1700Z.json`.
 *
 * UTC, not local time, so names sort lexicographically into chronological order
 * and survive DST shifts and travel — which is the whole job. `list` returns a
 * sorted directory listing and everything downstream inherits that order.
 *
 * Minute precision is safe here because the windows themselves are far apart: a
 * five-hour pool cannot start twice in one minute, nor can a weekly cycle.
 *
 * The name is for identity and ordering only, and is deliberately not a source
 * of data. Anything that needs an instant reads it from inside the file, where
 * it is untruncated and, for `resetAt`, exactly what the API reported.
 */

const NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{4}Z\.json$/;

export function toFileName(at: Millis): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}Z.json`
  );
}

export function isLedgerFileName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * The sorted listing is a complete interval index over the ledger, and these
 * turn it into one.
 *
 * There is no persisted index and there should not be one. `toFileName` floors
 * to the minute and windows of a kind do not overlap, so for file *i* in the
 * listing:
 *
 *     name_i     <= startAt_i     <  name_i + 60s        (truncation)
 *     resetAt_i  <= startAt_{i+1} <  name_{i+1} + 60s    (non-overlap)
 *
 * which places file *i*'s data inside `[ name_i, name_{i+1} + 60s ]` — an
 * interval index that cannot desync from the directory, because it is not a
 * record of the directory, it *is* the directory. A separate index file was
 * built and measured and is slower: it has to be reconciled against the listing
 * anyway, so its own read is pure addition (8.75 ms against 5.68 ms to resolve
 * one day page at a decade).
 *
 * **These choose which files to open. The header still decides.** That is the
 * whole difference between this and the deleted `fromFileName`, which returned
 * the minute-truncated name *as the answer* and could bucket a session starting
 * at 00:00:30 into the wrong day. A loose bound here costs one extra read; a
 * wrong result is impossible, so long as the bound is provably conservative.
 * Every bound below therefore carries its proof, and each errs outwards.
 *
 * Two different bounds with two different proofs, and neither may borrow the
 * other's — see the callers.
 */

/** First index whose name is `>= key`; `names.length` if there is none. */
function lowerBound(names: readonly string[], key: string): number {
  let lo = 0;
  let hi = names.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (names[mid] < key) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** First index whose name is `> key`; `names.length` if there is none. */
function upperBound(names: readonly string[], key: string): number {
  let lo = 0;
  let hi = names.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (names[mid] <= key) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Every file that can hold a window starting in `[from, to)`.
 *
 * From truncation alone — no assumption about window length, ordering or
 * overlap — and the proof is just that flooring is monotone. A file starting at
 * `s` is named `floor(s)`, so:
 *
 *     s >= from      =>  floor(s) >= floor(from)
 *     s <= to - 1    =>  floor(s) <= floor(to - 1)
 *
 * Those two are the bounds below, and nothing that started inside the range can
 * fall outside them. `to - 1` rather than `to` because the range is half-open
 * and these are integer milliseconds: a file named on the instant the range ends
 * begins at that instant or later, so it is never in the range and never worth
 * opening.
 *
 * Slack remains at an unaligned end, and it is irreducible: a name fixes the
 * minute a window began in but not the second, so `floor(from)` can name a file
 * that started just *before* `from`. **The caller must still filter on the
 * `startAt` it reads out of each file** — the name says which files to open and
 * the header says which of them count, here as everywhere.
 */
export function namesForStartRange(
  names: readonly string[],
  from: Millis,
  to: Millis,
): string[] {
  const lo = lowerBound(names, toFileName(from));
  const hi = upperBound(names, toFileName(to - 1));
  return names.slice(lo, hi);
}

/**
 * Every file that can have stopped collecting before `instant` — the eviction
 * candidates, and the one bound whose mistakes would be destructive.
 *
 * It takes the weakest premise of the three consumers, `resetAt > startAt >=
 * name`, which holds because a window has positive length and a name is its
 * start floored to the minute. So a file named after `instant` is *provably*
 * still current: `resetAt > startAt >= name > instant`. Names sort
 * chronologically, so the candidates are simply the prefix below that point.
 *
 * Comparing against `toFileName(instant)` rather than the instant makes the
 * break conservative by up to a minute, costing one extra read. Nothing here
 * decides a deletion: the caller re-reads the header and `resetAt` decides.
 */
export function namesAtOrBefore(names: readonly string[], instant: Millis): string[] {
  return names.slice(0, upperBound(names, toFileName(instant)));
}

/**
 * Every file whose window can *intersect* `[from, to)`, rather than begin in it.
 *
 * This is the one bound that needs the non-overlap property as well as
 * truncation, and it needs it for exactly one file. Windows of a kind do not
 * overlap, so of all the windows that began before `from` at most one can still
 * have been running at `from` — the last of them. Everything earlier had already
 * closed, because otherwise two windows would have been open at once.
 *
 * So the candidates are `namesForStartRange` plus a single name in front of it,
 * with no assumption about how long a window is. A rule of the form "look back
 * one week, because cycles are a week" would be the same thing said in a way
 * that breaks the day a cycle is not.
 *
 * One name is enough even though the straddling window can be named either side
 * of `floor(from)`. If it is named before that, it is the entry immediately in
 * front of the range and this takes it; if it is named at or after it, the range
 * slice already holds it.
 *
 * As everywhere else, the caller re-reads the headers and decides.
 */
export function namesForOverlap(
  names: readonly string[],
  from: Millis,
  to: Millis,
): string[] {
  const start = lowerBound(names, toFileName(from));
  const end = upperBound(names, toFileName(to - 1));
  return names.slice(Math.max(0, start - 1), end);
}
