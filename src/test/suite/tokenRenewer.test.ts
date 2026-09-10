// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import type { ICredentialRefresher, ICredentialStore } from '../../core/interfaces';
import { PollSchedule } from '../../core/pollSchedule';
import { TokenRenewer } from '../../core/tokenRenewer';
import { ATTEMPT_CUTOFF_MS, EXPIRY_SKEW_MS } from '../../core/tokenTiming';
import type { CredentialResult, RefreshOutcome } from '../../core/types';
import { FakeClock, RecordingLogger, makeTempDir, removeTempDir } from './helpers';

/**
 * Nothing here is on a real timer.
 *
 * The class arms `setTimeout` against a clock it does not control, so a test
 * that waited for one would be a test about Node's scheduler. `nudge()` is the
 * seam instead: it runs the same wake-up the timer would have, which is exactly
 * what the engine's heartbeat does in production.
 */

const NOW = Date.UTC(2026, 1, 6, 9, 0);
const HOUR = 3_600_000;
const SECOND = 1000;
const INTERVAL = 180_000;

/** A token expiring in eight hours: nothing due, nothing to do. */
const FRESH = NOW + 8 * HOUR;

describe('TokenRenewer', () => {
  let root: string;
  let clock: FakeClock;
  let logger: RecordingLogger;

  beforeEach(async () => {
    root = await makeTempDir();
    clock = new FakeClock(NOW);
    logger = new RecordingLogger();
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  /** A store whose expiry the test moves, the way a renewal on disk would. */
  function storeAt(expiresAt: () => number, state: 'ok' | 'stale' = 'ok'): ICredentialStore {
    return {
      read: async (): Promise<CredentialResult> =>
        state === 'ok'
          ? { state: 'ok', token: 'access', expiresAt: expiresAt() }
          : { state: 'stale', expiresAt: expiresAt() },
    };
  }

  /** Records every redemption and answers with a scripted outcome. */
  function stubRefresher(...script: RefreshOutcome[]) {
    const at: number[] = [];
    const refresher: ICredentialRefresher = {
      refresh: async () => {
        at.push(clock.now());
        return script[Math.min(at.length - 1, script.length - 1)];
      },
    };
    return { refresher, at };
  }

  function renewed(expiresAt: number): RefreshOutcome {
    return { state: 'renewed', expiresAt };
  }

  const RETRY: RefreshOutcome = { state: 'retry', reason: 'offline' };
  const COOLDOWN: RefreshOutcome = { state: 'cooldown', reason: 'invalid_grant' };

  function build(
    credentials: ICredentialStore,
    refresher: ICredentialRefresher,
    owner = 'window-a',
  ): TokenRenewer {
    return new TokenRenewer(
      credentials,
      refresher,
      new PollSchedule(root, owner, clock, logger, INTERVAL),
      clock,
      logger,
    );
  }

  /** One wake-up, driven the way the engine's heartbeat drives it. */
  async function wake(renewer: TokenRenewer): Promise<void> {
    renewer.nudge();
    await renewer.whenSettled();
  }

  it('leaves a healthy token alone', async () => {
    const { refresher, at } = stubRefresher(renewed(FRESH));
    const renewer = build(storeAt(() => FRESH), refresher);

    renewer.start(() => undefined);
    await renewer.whenSettled();

    assert.deepStrictEqual(at, [], 'eight hours of runway is not a reason to spend a grant');
    renewer.dispose();
  });

  it('redeems once the window opens', async () => {
    let expiresAt = NOW + 10 * 60 * SECOND;
    const { refresher, at } = stubRefresher(renewed(NOW + 8 * HOUR));
    const renewer = build(
      storeAt(() => expiresAt),
      refresher,
    );

    renewer.start(() => {
      expiresAt = NOW + 8 * HOUR;
    });
    await wake(renewer);
    assert.deepStrictEqual(at, [], 'ten minutes out is still outside the window');

    clock.advance(2 * 60 * SECOND);
    await wake(renewer);

    assert.strictEqual(at.length, 1);
    assert.strictEqual(renewer.isFailing(), false);
    renewer.dispose();
  });

  it('announces a renewal so a blocked poll can resume', async () => {
    let announced = 0;
    const { refresher } = stubRefresher(renewed(NOW + 8 * HOUR));
    const renewer = build(storeAt(() => NOW - SECOND, 'stale'), refresher);

    renewer.start(() => {
      announced += 1;
    });
    await renewer.whenSettled();

    assert.strictEqual(announced, 1);
    renewer.dispose();
  });

  it('climbs the ladder rather than waiting out the cooldown', async () => {
    // The whole point of the exercise. A network that comes back forty seconds
    // later must not cost half an hour of expired token.
    const expiresAt = NOW + EXPIRY_SKEW_MS;
    const { refresher, at } = stubRefresher(RETRY, RETRY, renewed(NOW + 8 * HOUR));
    const renewer = build(
      storeAt(() => expiresAt),
      refresher,
    );

    renewer.start(() => undefined);
    await renewer.whenSettled();
    assert.strictEqual(at.length, 1, 'the window opens, so the first attempt is now');

    // Too soon: the fifteen second floor is what keeps one claim to one request.
    clock.advance(10 * SECOND);
    await wake(renewer);
    assert.strictEqual(at.length, 1);

    clock.advance(5 * SECOND);
    await wake(renewer);
    clock.advance(30 * SECOND);
    await wake(renewer);

    assert.deepStrictEqual(
      at.map((instant) => (instant - NOW) / SECOND),
      [0, 15, 45],
    );
    renewer.dispose();
  });

  it('stops at the cutoff instead of redeeming into the dead zone', async () => {
    const expiresAt = NOW + EXPIRY_SKEW_MS;
    const { refresher, at } = stubRefresher(RETRY);
    const renewer = build(
      storeAt(() => expiresAt),
      refresher,
    );

    renewer.start(() => undefined);
    for (let elapsed = 0; elapsed <= EXPIRY_SKEW_MS; elapsed += 5 * SECOND) {
      await wake(renewer);
      clock.advance(5 * SECOND);
    }

    assert.deepStrictEqual(
      at.map((instant) => (instant - NOW) / SECOND),
      [0, 15, 45, 105, 165, 225, 285],
    );
    assert.ok(
      at.every((instant) => instant <= expiresAt - ATTEMPT_CUTOFF_MS),
      'no attempt may start after the cutoff',
    );
    renewer.dispose();
  });

  it('waits half an hour on a refusal instead of spending six more', async () => {
    // A refused grant refuses again fifteen seconds later. Without this the
    // ladder turns one refusal into seven requests.
    const expiresAt = NOW + EXPIRY_SKEW_MS;
    const { refresher, at } = stubRefresher(COOLDOWN);
    const renewer = build(
      storeAt(() => expiresAt),
      refresher,
    );

    renewer.start(() => undefined);
    await renewer.whenSettled();
    clock.advance(60 * SECOND);
    await wake(renewer);

    assert.strictEqual(at.length, 1);
    assert.strictEqual(renewer.isFailing(), true);
    renewer.dispose();
  });

  it('honours a Retry-After longer than the cooldown', async () => {
    const { refresher, at } = stubRefresher({
      state: 'cooldown',
      reason: 'rate limited',
      retryAfterMs: 45 * 60_000,
    });
    const renewer = build(storeAt(() => NOW - SECOND, 'stale'), refresher);

    renewer.start(() => undefined);
    await renewer.whenSettled();

    clock.advance(31 * 60_000);
    await wake(renewer);
    assert.strictEqual(at.length, 1, 'the cooldown is a floor, not the answer');

    clock.advance(15 * 60_000);
    await wake(renewer);
    assert.strictEqual(at.length, 2);
    renewer.dispose();
  });

  it('keeps trying every half hour once the token has expired', async () => {
    // The ladder is spent by now, and this is the path that recovers a token
    // that lapsed overnight.
    const { refresher, at } = stubRefresher(RETRY);
    const renewer = build(storeAt(() => NOW - HOUR, 'stale'), refresher);

    renewer.start(() => undefined);
    await renewer.whenSettled();
    clock.advance(29 * 60_000);
    await wake(renewer);
    assert.strictEqual(at.length, 1);

    clock.advance(2 * 60_000);
    await wake(renewer);
    assert.strictEqual(at.length, 2);
    renewer.dispose();
  });

  it('spends nothing when there is nothing left to renew from', async () => {
    // A signed-out store has no refresh token either, so redeeming would buy a
    // half-hour cooldown to learn what the file already says.
    const { refresher, at } = stubRefresher(COOLDOWN);
    const renewer = build(
      { read: async () => ({ state: 'signed-out', expiresAt: NOW - HOUR }) },
      refresher,
    );

    renewer.start(() => undefined);
    await renewer.whenSettled();

    assert.deepStrictEqual(at, []);
    renewer.dispose();
  });

  it('keeps a second window off a redemption the first is making', async () => {
    // Two windows agree on the rung instants without coordinating, so they wake
    // together. Only one may redeem, or both present the same refresh token.
    const expiresAt = NOW + EXPIRY_SKEW_MS;
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const redeeming = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const first: ICredentialRefresher = {
      refresh: async () => {
        entered?.();
        await held;
        return renewed(NOW + 8 * HOUR);
      },
    };
    const { refresher: second, at: secondAttempts } = stubRefresher(renewed(NOW + 8 * HOUR));

    const a = build(storeAt(() => expiresAt), first, 'window-a');
    const b = build(storeAt(() => expiresAt), second, 'window-b');

    a.start(() => undefined);
    await redeeming;

    b.start(() => undefined);
    await b.whenSettled();
    assert.deepStrictEqual(secondAttempts, [], 'the second window stood down');

    release?.();
    await a.whenSettled();

    a.dispose();
    b.dispose();
  });

  it('stands down when the credential was renewed while it queued', async () => {
    // The expiry is read *after* the claim for exactly this: a window that
    // waited on the guard is holding a figure from before whoever it waited for.
    let expiresAt = NOW + EXPIRY_SKEW_MS;
    const { refresher, at } = stubRefresher(renewed(NOW + 8 * HOUR));

    const moving: ICredentialStore = {
      read: async () => {
        const answer: CredentialResult = { state: 'ok', token: 'access', expiresAt };
        // Somebody else renews between this window deciding to act and the read
        // it makes once it holds the claim.
        expiresAt = NOW + 8 * HOUR;
        return answer;
      },
    };
    const late = build(moving, refresher, 'window-c');

    late.start(() => undefined);
    await late.whenSettled();

    assert.deepStrictEqual(at, [], 'eight hours of runway means somebody got there first');
    late.dispose();
  });
});
