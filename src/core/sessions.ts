// SPDX-License-Identifier: AGPL-3.0-only

import type { LedgerFile, Millis } from './types';

/**
 * Day bucketing for the 5-hour pool graph.
 *
 * A session belongs to the calendar day it *started* on, even when it runs past
 * midnight: a session opened at 23:00 Oct 31 and resetting at 04:00 Nov 1 is Oct
 * 31's session. That is why a day can span up to 29 hours, midnight through
 * 05:00 the next morning.
 *
 * All arithmetic goes through local `Date` accessors rather than fixed
 * millisecond offsets, so days stay 23 or 25 hours long across DST changes.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const HOUR_MS = 3_600_000;

export function startOfLocalDay(at: Millis): Millis {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function addLocalDays(at: Millis, days: number): Millis {
  const date = new Date(at);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** Stable `YYYY-MM-DD` key in local time — the identity of a day bucket. */
export function localDayKey(at: Millis): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** e.g. `Sat, Nov 1`. Fixed English so output does not vary by host locale. */
export function formatDayLabel(at: Millis): string {
  const date = new Date(at);
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** e.g. `Nov 1`. */
export function formatShortDate(at: Millis): string {
  const date = new Date(at);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/**
 * e.g. `Sep 3, 09:00`, for the weekly reset walls.
 *
 * Dated rather than named by weekday, because Graph 2 draws both ends of the
 * cycle and they are exactly seven days apart — a weekday alone labels them
 * identically. The weekday is on the axis underneath either way.
 *
 * The clock half is `formatClock24`, so a weekly wall reads in the same
 * 24-hour form as Graph 1's `Reset 14:00` and the axis ticks under both charts.
 */
export function formatResetWall(at: Millis): string {
  return `${formatShortDate(at)}, ${formatClock24(at)}`;
}

/**
 * e.g. `14:00`. Twenty-four hour, matching Graph 1's axis ticks — a 12-hour
 * label there would read oddly against gridlines marked 20:00 and 22:00.
 */
export function formatClock24(at: Millis): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Sessions that started on the given local day, in chronological order.
 *
 * Bucketing is a numeric range test, not a comparison of `localDayKey` strings.
 * The two decide identically — a local day is exactly the half-open interval
 * between its own midnight and the next — but the string form allocated a `Date`
 * and built a formatted key for *every* file in the ledger, and this runs across
 * the whole retention window on every render. The bounds are still derived by
 * local-day arithmetic rather than by adding 24 hours, so a DST day stays 23 or
 * 25 hours wide and nothing falls out of its bucket.
 */
export function sessionsForDay(files: readonly LedgerFile[], dayStart: Millis): LedgerFile[] {
  const from = startOfLocalDay(dayStart);
  const to = startOfLocalDay(addLocalDays(from, 1));
  return files
    .filter((file) => file.startAt >= from && file.startAt < to)
    .sort((a, b) => a.startAt - b.startAt);
}
