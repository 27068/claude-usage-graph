// SPDX-License-Identifier: AGPL-3.0-only

import { HOUR_MS, addLocalDays, startOfLocalDay } from './sessions';
import type { Millis } from './types';

/**
 * Gridline positions for the time axis.
 *
 * These must be supplied explicitly. A Chart.js linear scale places ticks at
 * round *numbers*, and the values here are epoch milliseconds — so it happily
 * picks a step of 5,000,000ms and draws gridlines 83 minutes and 20 seconds
 * apart, landing on times like 22:16 and 23:40. Numerically tidy, temporally
 * meaningless.
 *
 * Both helpers step with `Date` accessors rather than adding fixed
 * milliseconds, so ticks stay pinned to the wall clock across a DST change
 * instead of drifting by an hour partway along the axis.
 */

const MAX_TICKS = 40;

/** Local midnights in range — the human day markers Graph 2 uses. */
export function localMidnightTicks(from: Millis, to: Millis): Millis[] {
  const ticks: Millis[] = [];
  let cursor = startOfLocalDay(from);
  if (cursor < from) {
    cursor = startOfLocalDay(addLocalDays(cursor, 1));
  }
  while (cursor <= to && ticks.length < MAX_TICKS) {
    ticks.push(cursor);
    cursor = startOfLocalDay(addLocalDays(cursor, 1));
  }
  return ticks;
}

/**
 * Local noons in range — where Graph 2 hangs its weekday labels.
 *
 * The gridlines mark midnight because that is where the day actually turns, but
 * a label sitting on that line names neither of the two days it separates. The
 * labels therefore ride on a second set of ticks, one per day, at the middle of
 * the day they name. A day the frame only clips — the partial one at either end
 * of the week — has no noon inside the range and so goes unlabelled, which is
 * the right answer for a sliver too narrow to hold the text anyway.
 */
export function localNoonTicks(from: Millis, to: Millis): Millis[] {
  const ticks: Millis[] = [];
  let day = startOfLocalDay(from);
  while (ticks.length < MAX_TICKS) {
    const noon = localNoon(day);
    if (noon > to) break;
    if (noon >= from) ticks.push(noon);
    day = startOfLocalDay(addLocalDays(day, 1));
  }
  return ticks;
}

/** Noon on the local day that `at` falls in. */
function localNoon(at: Millis): Millis {
  const noon = new Date(at);
  noon.setHours(12, 0, 0, 0);
  return noon.getTime();
}

/** Hour spacing that keeps a day's axis readable without crowding it. */
export function hourStepFor(spanMs: number): number {
  if (spanMs <= 8 * HOUR_MS) return 1;
  if (spanMs <= 16 * HOUR_MS) return 2;
  if (spanMs <= 26 * HOUR_MS) return 3;
  return 4;
}

/**
 * Whole-hour gridlines for Graph 1, aligned to the local clock and to a step
 * that divides the day evenly — so a 3-hour step lands on 00:00, 03:00, 06:00
 * rather than wherever the axis happens to begin.
 */
export function localHourTicks(from: Millis, to: Millis): Millis[] {
  const step = hourStepFor(to - from);
  const cursor = new Date(from);
  cursor.setMinutes(0, 0, 0);
  cursor.setHours(Math.floor(cursor.getHours() / step) * step);

  while (cursor.getTime() < from) {
    cursor.setHours(cursor.getHours() + step);
  }

  const ticks: Millis[] = [];
  while (cursor.getTime() <= to && ticks.length < MAX_TICKS) {
    ticks.push(cursor.getTime());
    cursor.setHours(cursor.getHours() + step);
  }
  return ticks;
}
