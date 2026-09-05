// SPDX-License-Identifier: AGPL-3.0-only

import type { Millis } from './types';

/**
 * Which vertical markers fall inside the frame.
 *
 * The markers are the lines standing across the plot: a red wall at every reset
 * boundary, and a dashed one at Now. A marker outside the axis range has no
 * position to be drawn at, so it is dropped rather than clamped to an edge —
 * clamping would put a "Now" line somewhere Now is not.
 *
 * Extracted from `charts.ts` because dropping is silent, and silence is the
 * whole hazard: the Now line vanishing looks exactly like a chart that is simply
 * up to date, so the one case worth catching is the one that shows no symptom.
 * `charts.ts` cannot be loaded by the terminal suite — it imports Chart.js and
 * reads CSS variables off a document — but this rule can, and it is the rule
 * that had the bug.
 *
 * Bounds are inclusive: a marker exactly on the edge is on the axis, and a reset
 * wall landing precisely at the frame's end is the ordinary case for graph 2,
 * whose right buffer is measured from that very boundary.
 */
export function markersInFrame<T extends { x: Millis }>(
  markers: readonly T[],
  [from, to]: readonly [Millis, Millis],
): T[] {
  return markers.filter((marker) => marker.x >= from && marker.x <= to);
}

/**
 * Does the live page's frame still contain Now?
 *
 * Stated separately from the filter above because it is the property the
 * selectors owe the chart: a frame ending an hour after a reset that is hours
 * behind us excludes Now, and the marker is then dropped by the rule above with
 * nothing on screen to say so.
 */
export function frameContains([from, to]: readonly [Millis, Millis], at: Millis): boolean {
  return at >= from && at <= to;
}
