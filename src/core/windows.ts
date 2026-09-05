// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two window lengths the product is built around, and the only place either
 * is stated.
 *
 * These are not tunables. They are facts about Anthropic's plans that this
 * extension has no say in, and the reason they live together in one file is that
 * "what would it cost if one of them changed?" should be answerable by reading
 * one screen rather than by grepping for the number five.
 *
 * Neither length is ever observed. The API reports only `resets_at`, so a
 * window's *start* is always derived by subtracting one of these — see
 * `usageEngine.record`. That derivation then reaches disk twice: as `startAt` in
 * every ledger header, and through `toFileName(startAt)` as the file's name. So
 * changing a value here does not merely recompile: files written under the old
 * length keep headers and names computed from it. That is the right outcome
 * rather than a wart — a session really did start when we thought it did, and
 * recomputing on read would slide every historical session under a plan change.
 * Retention is unaffected either way: `eviction` ages a file by the `resetAt`
 * the API reported, never by anything derived from these.
 */

const HOUR = 3_600_000;

/** A five-hour pool. Exists only while a session is open. */
export const FIVE_HOUR_MS = 5 * HOUR;

/**
 * A weekly allowance. Runs whether or not anyone is working, which is what makes
 * it safe to project forward across a gap — see `selectors.currentCycleReset`.
 */
export const WEEK_MS = 7 * 24 * HOUR;

/**
 * How far past midnight a day's sessions can still run.
 *
 * Derived, not restated. A session belongs to the day it started on, so the last
 * one a day can hold begins at 23:59 and closes one pool-length later — which
 * makes this the same fact as `FIVE_HOUR_MS`. Two literals for one fact is
 * exactly the shape of thing that survives a change to one of them.
 */
export const DAY_OVERHANG_MS = FIVE_HOUR_MS;
