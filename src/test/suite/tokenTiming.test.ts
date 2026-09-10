// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { REQUEST_TIMEOUT_MS } from '../../auth/credentialRefresher';
import {
  ATTEMPT_CUTOFF_MS,
  CLAUDE_CODE_REFRESH_BAND_MS,
  DEAD_ZONE_MS,
  EXPIRY_SKEW_MS,
  RETRY_BASE_MS,
  TOKEN_UNUSABLE_MS,
  mayRedeemAt,
  nextAttemptAt,
} from '../../core/tokenTiming';

/** Expiry. Every instant here is expressed as an offset back from it. */
const T = Date.UTC(2026, 1, 6, 17, 0);

const SECOND = 1000;

/** The window opening, which is where the ladder is measured from. */
const OPENS = T - EXPIRY_SKEW_MS;

/** Attempt instants, as seconds after the window opens. */
function ladder(): number[] {
  const offsets: number[] = [];
  let last: number | undefined;
  for (;;) {
    const at = nextAttemptAt(T, OPENS, last);
    if (at === undefined) {
      return offsets;
    }
    offsets.push((at - OPENS) / SECOND);
    last = at;
  }
}

describe('token timing', () => {
  /**
   * These four are the whole safety argument, and none of them is visible from
   * any one constant. Moving any of these numbers without moving its neighbours
   * reintroduces a failure that only shows up as a sign-out, minutes later,
   * somewhere else — which is why they are asserted rather than described in a
   * comment beside each constant.
   */
  describe('the relationships between the constants', () => {
    it('stops starting attempts early enough that none can run into the dead zone', () => {
      // An attempt beginning at the cutoff and running the full request timeout
      // must still finish before the dead zone opens. Otherwise a redemption is
      // in flight while Claude Code may be redeeming the same refresh token.
      assert.ok(
        ATTEMPT_CUTOFF_MS - DEAD_ZONE_MS > REQUEST_TIMEOUT_MS,
        `an attempt starting at the cutoff has ${ATTEMPT_CUTOFF_MS - DEAD_ZONE_MS}ms before the ` +
          `dead zone, which does not cover a ${REQUEST_TIMEOUT_MS}ms request`,
      );
    });

    it('keeps the dead zone wider than the band Claude Code renews in', () => {
      assert.ok(
        DEAD_ZONE_MS > CLAUDE_CODE_REFRESH_BAND_MS,
        `the dead zone is ${DEAD_ZONE_MS}ms and does not cover Claude Code's ` +
          `${CLAUDE_CODE_REFRESH_BAND_MS}ms band`,
      );
    });

    it('stops using the token before the dead zone ends', () => {
      // The reader hands the token out until this point, so it has to sit inside
      // the stretch where nothing of ours is redeeming. A token handed out after
      // the dead zone closed would be one we had already decided was gone.
      assert.ok(TOKEN_UNUSABLE_MS < DEAD_ZONE_MS);
    });

    it('opens the window far enough ahead for the ladder to exist at all', () => {
      assert.ok(
        EXPIRY_SKEW_MS - ATTEMPT_CUTOFF_MS >= RETRY_BASE_MS,
        'the window closes before a single retry could be made',
      );
    });
  });

  describe('the ladder', () => {
    it('doubles the delay up to a minute and stops at the cutoff', () => {
      assert.deepStrictEqual(ladder(), [0, 15, 45, 105, 165, 225, 285]);
    });

    it('gives up rather than attempting past the cutoff', () => {
      const last = OPENS + 285 * SECOND;

      assert.strictEqual(nextAttemptAt(T, last, last), undefined);
    });

    it('answers nothing to a window that arrives after the cutoff', () => {
      // The rung instants are all in the past by now. Answering with one would
      // be read as "due", and the attempt would land inside the dead zone.
      assert.strictEqual(nextAttemptAt(T, T - DEAD_ZONE_MS, undefined), undefined);
    });

    it('puts a window that arrives mid-ladder on the next rung, not the first', () => {
      // Nothing is shared between windows but the credential, so a window opened
      // half way through joins by arithmetic or not at all.
      assert.strictEqual(nextAttemptAt(T, OPENS + 100 * SECOND, undefined), OPENS);
      assert.strictEqual(
        nextAttemptAt(T, OPENS + 100 * SECOND, OPENS + 45 * SECOND),
        OPENS + 105 * SECOND,
      );
    });

    it('skips the rungs a late wake-up slept through', () => {
      // Woken at 20s having last attempted at the window opening. The rung at
      // 15s has gone; the answer is the one after it, never a fresh 15s wait.
      assert.strictEqual(nextAttemptAt(T, OPENS + 20 * SECOND, OPENS), OPENS + 15 * SECOND);
      assert.strictEqual(
        nextAttemptAt(T, OPENS + 20 * SECOND, OPENS + 15 * SECOND),
        OPENS + 45 * SECOND,
      );
    });

    it('starts again from the top once the expiry moves', () => {
      // A renewal puts the expiry eight hours out, which leaves the previous
      // cycle's attempts behind the new window. This is what keeps the ladder
      // from needing to be reset by hand.
      const renewed = T + 8 * 3_600_000;
      const attemptedLastCycle = OPENS + 285 * SECOND;

      assert.strictEqual(
        nextAttemptAt(renewed, renewed - EXPIRY_SKEW_MS, attemptedLastCycle),
        renewed - EXPIRY_SKEW_MS,
      );
    });
  });

  describe('when a redemption may be issued', () => {
    it('allows the ladder and refuses everything between the cutoff and expiry', () => {
      assert.strictEqual(mayRedeemAt(T, OPENS), true);
      assert.strictEqual(mayRedeemAt(T, T - ATTEMPT_CUTOFF_MS), true);
      assert.strictEqual(mayRedeemAt(T, T - ATTEMPT_CUTOFF_MS + 1), false);
      assert.strictEqual(mayRedeemAt(T, T - DEAD_ZONE_MS), false);
      assert.strictEqual(mayRedeemAt(T, T - 1), false);
    });

    it('allows it again once the token has expired', () => {
      // The dead zone is the run-up to expiry and ends with it. Past that the
      // token is already dead and Claude Code is no longer renewing it ahead of
      // time, so the ordinary retry applies — that is the path that keeps an
      // overnight lapse recoverable.
      assert.strictEqual(mayRedeemAt(T, T), true);
      assert.strictEqual(mayRedeemAt(T, T + 60_000), true);
    });
  });
});
