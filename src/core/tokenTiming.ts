// SPDX-License-Identifier: AGPL-3.0-only

import type { Millis } from './types';

/**
 * When the access token may be renewed, and when it may still be used.
 *
 * Every value here is an offset back from the token's expiry, and the whole
 * model is a countdown to that one instant:
 *
 * ```
 *   −540s  window opens, first attempt
 *   −240s  cutoff: no new attempt starts
 *   −180s  dead zone: nothing redeems
 *   −120s  Claude Code's own band opens
 *    −60s  the token stops being used
 *      0   expiry, and the dead zone ends with it
 * ```
 *
 * The two ends answer different questions and used to share one constant. When
 * to *start renewing* is a scheduling choice and can be as early as we like.
 * When to *stop spending* the token is a correctness bound. Joining them meant
 * that opening the renewal window wider also refused a credential the server
 * would still accept, for as long as renewal kept failing.
 *
 * `tokenRenewer.ts` owns the clock this drives; `credentialReader.ts` owns the
 * other end. Nothing here does I/O, so the arithmetic is asserted directly.
 */

/**
 * How early the renewal window opens.
 *
 * The cutoff plus how long we are willing to spend retrying, and nothing else.
 * There is no allowance for waking late, because the renewer aims its own timer
 * at this instant rather than waiting for a poll to come round.
 *
 * Five minutes of retrying is a choice. Shortening it would not change when we
 * give up — the cutoff decides that, and the delays cap out — it would only
 * start later, giving up the part of the range where a short network outage is
 * most likely.
 */
export const EXPIRY_SKEW_MS = 540_000;

/**
 * The last moment a new redemption may start.
 *
 * Far enough inside `DEAD_ZONE_MS` that an attempt beginning here has finished
 * long before it, even if it runs the full request timeout.
 */
export const ATTEMPT_CUTOFF_MS = 240_000;

/**
 * The run-up to expiry, in which nothing of ours redeems.
 *
 * It exists to keep us clear of `CLAUDE_CODE_REFRESH_BAND_MS`, where an active
 * Claude Code may redeem the same refresh token, and a server that invalidates a
 * refresh token redeemed twice takes the whole chain with it.
 *
 * **It has no runtime check, deliberately.** Nothing tests against it, because
 * the cutoff above is placed to make entering it impossible. That placement is
 * what `tokenTiming.test.ts` asserts.
 *
 * The zone ends at expiry. Past that the token is already dead, Claude Code is
 * no longer renewing it pre-emptively, and the ordinary retry applies.
 */
export const DEAD_ZONE_MS = 180_000;

/**
 * Claude Code's own pre-emptive refresh band, read from the shipped binary.
 *
 * Its token provider renews in the background once a token has under two
 * minutes left, and synchronously under thirty seconds — but only when
 * something asks it for a token, never on a timer. So this is the window in
 * which an active Claude Code may rotate the credential out from under a
 * redemption we have already started.
 */
export const CLAUDE_CODE_REFRESH_BAND_MS = 120_000;

/**
 * How long before expiry the token stops being handed to the usage endpoint.
 *
 * A request started here could still be in flight when the token dies, so this
 * is a request's worth of margin and nothing more. It is the correctness half
 * of what `EXPIRY_SKEW_MS` used to mean on its own.
 */
export const TOKEN_UNUSABLE_MS = 60_000;

/** The first retry delay, and the floor under every later one. */
export const RETRY_BASE_MS = 15_000;

/** Where the doubling stops. */
export const RETRY_CAP_MS = 60_000;

/**
 * When the next redemption attempt is due, or `undefined` once the ladder for
 * this token is spent.
 *
 * Delays double from `RETRY_BASE_MS` up to `RETRY_CAP_MS`, which puts attempts
 * at 0, 15, 45, 105, 165, 225 and 285 seconds after the window opens. Seven of
 * them, and the count is not written down anywhere: the cutoff is the only
 * bound, so moving either constant moves the ladder with it.
 *
 * The answer comes from the expiry and the last attempt rather than a counter,
 * so two windows agree on the rung instants without sharing anything, and a
 * window that opens mid-ladder joins it at the right place.
 *
 * A last attempt from *before* the window is treated as no attempt at all,
 * which is what makes this self-correcting across a renewal: the moment the
 * expiry moves eight hours out, every attempt from the previous cycle is
 * earlier than the new window, and the ladder starts again from the top.
 */
export function nextAttemptAt(
  expiresAt: Millis,
  now: Millis,
  lastAttemptAt: Millis | undefined,
): Millis | undefined {
  const opensAt = expiresAt - EXPIRY_SKEW_MS;
  const cutoffAt = expiresAt - ATTEMPT_CUTOFF_MS;

  // Arriving after the cutoff is the same as running out of rungs. Answering
  // with an instant already past would be read as "due now", and the caller
  // would attempt inside the dead zone.
  if (now > cutoffAt) {
    return undefined;
  }

  let at = opensAt;
  if (lastAttemptAt !== undefined && lastAttemptAt >= opensAt) {
    let delay = RETRY_BASE_MS;
    while (at <= lastAttemptAt && at <= cutoffAt) {
      at += delay;
      delay = Math.min(RETRY_CAP_MS, delay * 2);
    }
  }

  return at <= cutoffAt ? at : undefined;
}

/**
 * Whether a redemption may be issued at this instant.
 *
 * True inside the ladder, and true again once the token has expired. False in
 * between, which is the cutoff and the dead zone behind it — the one stretch
 * where a redemption we started could still be running when Claude Code begins
 * one of its own.
 */
export function mayRedeemAt(expiresAt: Millis, now: Millis): boolean {
  return now <= expiresAt - ATTEMPT_CUTOFF_MS || now >= expiresAt;
}
