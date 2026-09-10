// SPDX-License-Identifier: AGPL-3.0-only

import type {
  IClock,
  ICredentialRefresher,
  ICredentialStore,
  ILogger,
  ITokenRenewer,
} from './interfaces';
import type { PollSchedule } from './pollSchedule';
import { mayRedeemAt, nextAttemptAt } from './tokenTiming';
import type { Millis } from './types';

/**
 * Keeps Claude Code's access token alive, on a clock of its own.
 *
 * It sleeps for most of a token's eight hours, wakes nine minutes before it
 * expires, redeems, and sleeps again. When a redemption fails it climbs a short
 * ladder — fifteen seconds, then thirty, then a minute at a time — until the
 * cutoff. `tokenTiming.ts` holds the whole model.
 *
 * **This is not the engine's job, and the separation is the design.** The two
 * schedules answer unrelated questions: one paces requests to a usage endpoint,
 * the other counts down to a token expiry. Sharing one deadline between them
 * would make every retry also make a usage request, seven of them in five
 * minutes, against an endpoint that answers bursts with a 429. It would also
 * make the retries grow further apart as the poll backed off, because a failing
 * network fails both, and backing off is the opposite of what a retry ladder
 * needs.
 *
 * So nothing here touches the poll deadline. The only shared state is a hold on
 * `poll.lease` saying a redemption is in flight, and it exists only to stop two
 * windows redeeming the same refresh token at once.
 *
 * It publishes no status either. The engine asks `isFailing()` when it needs to
 * colour an expired token, and two publishers on one bus would leave the status
 * bar showing whichever fired last.
 */

/**
 * How long to leave renewal alone after an attempt that would fail again if it
 * were repeated.
 *
 * Long enough that a credential nobody can renew costs two token requests an
 * hour rather than one every fifteen seconds, short enough that coming back
 * online is noticed without the user doing anything. It is also the cadence once a token has
 * expired outright, where there is no ladder left to climb.
 */
export const RENEWAL_COOLDOWN_MS = 30 * 60_000;

/**
 * Floor on how soon a wake-up may be scheduled.
 *
 * Only reachable when a deadline computed from the credential is already in the
 * past — a clock moved backwards, or a machine resuming late. Without it the
 * timer would re-arm for zero and spin.
 */
const MIN_WAKE_MS = 5_000;

/**
 * How long to wait before looking again when there is no expiry to plan around.
 *
 * Nobody is signed in, or the store cannot be read. Neither resolves on its own,
 * and a token minted by a sign-in has eight hours on it, so there is nothing to
 * be gained by looking often.
 */
const IDLE_RECHECK_MS = 5 * 60_000;

export class TokenRenewer implements ITokenRenewer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the armed timer is set to fire, for spotting one that never did. */
  private armedFor: Millis | undefined;
  private stopped = false;
  private inFlight = false;
  /** The wake-up in flight, kept only so a test can wait for it. */
  private pass: Promise<void> | undefined;
  private onRenewed: (() => void) | undefined;

  /** The access token's expiry, as last read. Every deadline derives from it. */
  private expiresAt: Millis | undefined;
  /** When this window last redeemed, which is what puts it on a rung. */
  private lastAttemptAt: Millis | undefined;
  /** When renewal may be tried again after an attempt that will not clear. */
  private blockedUntil: Millis = 0;
  private failing = false;

  constructor(
    private readonly credentials: ICredentialStore,
    private readonly refresher: ICredentialRefresher,
    private readonly schedule: PollSchedule,
    private readonly clock: IClock,
    private readonly logger: ILogger,
  ) {}

  start(onRenewed: () => void): void {
    this.onRenewed = onRenewed;
    // Run rather than arm: a window opening onto an already-expired token should
    // not wait out an interval to discover it.
    this.launch();
  }

  dispose(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  isFailing(): boolean {
    return this.failing;
  }

  nudge(): void {
    if (this.stopped || this.inFlight) {
      return;
    }
    // Armed and not yet due: nothing to do. Anything else means the timer was
    // never set or should already have fired, and renewal stopping silently
    // while polling carries on is the failure this exists to catch.
    if (this.armedFor !== undefined && this.armedFor > this.clock.now()) {
      return;
    }
    this.launch();
  }

  /**
   * Settle once the wake-up in flight, if any, has finished.
   *
   * For tests, and for nothing else, the same way `UsageEngine.whenEvicted`
   * exists. Nothing in production waits on a renewal: the engine's tick and this
   * timer are deliberately independent.
   */
  async whenSettled(): Promise<void> {
    await this.pass;
  }

  private launch(): void {
    this.pass = this.run();
  }

  /**
   * One wake-up: read where we stand, act if something is due, arm the next.
   *
   * The re-arm is in a `finally` because losing it is the one failure that does
   * not recover. Without it, a throw anywhere in the body would leave no timer
   * armed, and this class is invisible from outside: the status bar would carry
   * on updating while the token ran out unnoticed.
   */
  private async run(): Promise<void> {
    if (this.stopped || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      this.expiresAt = await this.readExpiry();
      if (this.due(this.clock.now())) {
        await this.claimAndAttempt();
      }
    } catch (error) {
      this.logger.error(`Token renewal check failed: ${String(error)}`);
    } finally {
      this.inFlight = false;
      this.arm();
    }
  }

  /** Whether a redemption should be issued at this instant. */
  private due(now: Millis): boolean {
    const expiresAt = this.expiresAt;
    if (expiresAt === undefined || now < this.blockedUntil || !mayRedeemAt(expiresAt, now)) {
      return false;
    }
    // Past expiry there is no ladder left. The cooldown above is what paces
    // those attempts, so reaching here at all means one is due.
    if (now >= expiresAt) {
      return true;
    }
    const rung = nextAttemptAt(expiresAt, now, this.lastAttemptAt);
    return rung !== undefined && now >= rung;
  }

  /**
   * Take the renewal hold, confirm the token still needs renewing, redeem.
   *
   * **The expiry is re-read after the claim, never before.** A window that waited
   * on the guard read its expiry before the window ahead of it finished, so
   * acting on that figure would redeem a token renewed a moment earlier. Read it
   * late and the window that waited sees eight hours left and does nothing.
   */
  private async claimAndAttempt(): Promise<void> {
    if (!(await this.schedule.claimRenewal())) {
      // Another window is redeeming right now. Treat the rung as spent and come
      // back on the next one: retrying immediately would undercut the fifteen
      // second floor that keeps a single claim to a single request.
      this.lastAttemptAt = this.clock.now();
      return;
    }

    let renewed = false;
    try {
      this.expiresAt = await this.readExpiry();
      const now = this.clock.now();
      if (this.expiresAt === undefined || !this.due(now)) {
        return;
      }
      renewed = await this.attempt(this.expiresAt, now);
    } finally {
      await this.schedule.releaseRenewal();
    }

    // After the hold is released, never inside it. The callback starts a poll,
    // and keeping the renewal mark set for the length of that request would
    // stall the next redemption behind work that has nothing to do with one.
    if (renewed) {
      this.onRenewed?.();
    }
  }

  private async attempt(expiresAt: Millis, now: Millis): Promise<boolean> {
    this.lastAttemptAt = now;
    const outcome = await this.refresher.refresh();

    switch (outcome.state) {
      case 'renewed':
        this.expiresAt = outcome.expiresAt;
        this.blockedUntil = 0;
        this.failing = false;
        return true;

      case 'retry':
        this.failing = true;
        this.logger.info(`Renewal will be retried: ${outcome.reason}`);
        // Nothing left to climb means nothing left to schedule, so this falls
        // back to the cadence that paces attempts once a token has expired.
        if (nextAttemptAt(expiresAt, now, this.lastAttemptAt) === undefined) {
          this.blockedUntil = now + RENEWAL_COOLDOWN_MS;
        }
        return false;

      case 'cooldown':
        this.failing = true;
        this.blockedUntil = now + Math.max(RENEWAL_COOLDOWN_MS, outcome.retryAfterMs ?? 0);
        this.logger.warn(
          `Renewal is on hold until ${new Date(this.blockedUntil).toISOString()}: ${outcome.reason}`,
        );
        return false;
    }
  }

  /**
   * The access token's expiry, or undefined when there is nothing to renew.
   *
   * `signed-out` counts as nothing: the refresh token has gone too, so a
   * redemption would fail and start a half-hour cooldown, to be told what the
   * file already says.
   */
  private async readExpiry(): Promise<Millis | undefined> {
    const result = await this.credentials.read();
    if (result.state !== 'ok' && result.state !== 'stale') {
      return undefined;
    }
    return result.expiresAt > 0 ? result.expiresAt : undefined;
  }

  private arm(): void {
    if (this.stopped) {
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    const now = this.clock.now();
    const at = this.nextTurnAt(now);
    const wait = at === undefined ? IDLE_RECHECK_MS : Math.max(MIN_WAKE_MS, at - now);
    this.armedFor = now + wait;
    this.timer = setTimeout(() => this.launch(), wait);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /** When renewal is next due, or undefined when there is no expiry to plan
   * around. */
  private nextTurnAt(now: Millis): Millis | undefined {
    const expiresAt = this.expiresAt;
    if (expiresAt === undefined) {
      return undefined;
    }
    if (now < this.blockedUntil) {
      return this.blockedUntil;
    }
    if (now >= expiresAt) {
      return now + RENEWAL_COOLDOWN_MS;
    }
    // No rung left before the cutoff, so the next chance is expiry itself: the
    // dead zone ends there, and a redemption is allowed again.
    return nextAttemptAt(expiresAt, now, this.lastAttemptAt) ?? expiresAt;
  }
}
