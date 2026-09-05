// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { DUE_TOLERANCE_MS, POLL_GUARD_MS, PollSchedule } from '../../core/pollSchedule';
import { FakeClock, RecordingLogger, makeTempDir, removeTempDir } from './helpers';

const INTERVAL = 180_000;
const T0 = Date.UTC(2026, 1, 6, 17, 0);

const statePath = (root: string) => path.join(root, 'poll.lease');

describe('PollSchedule', () => {
  let root: string;
  let clock: FakeClock;
  let logger: RecordingLogger;

  const windowNamed = (owner: string) => new PollSchedule(root, owner, clock, logger, INTERVAL);

  /** Take a turn and finish it the way the engine does after a clean poll. */
  async function poll(schedule: PollSchedule): Promise<boolean> {
    const claim = await schedule.claim();
    if (claim.granted) {
      await schedule.settle(clock.now() + INTERVAL, 0);
    }
    return claim.granted;
  }

  beforeEach(async () => {
    root = await makeTempDir();
    clock = new FakeClock(T0);
    logger = new RecordingLogger();
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it('grants a turn to the first window that asks', async () => {
    const claim = await windowNamed('window-a').claim();

    assert.strictEqual(claim.granted, true);
    assert.strictEqual(claim.dueAt, T0 + INTERVAL, 'a turn sets the next deadline');
  });

  it('refuses a second window until the deadline comes round', async () => {
    const a = windowNamed('window-a');
    const b = windowNamed('window-b');

    assert.strictEqual(await poll(a), true);
    assert.strictEqual(await poll(b), false);

    clock.advance(INTERVAL);
    assert.strictEqual(await poll(b), true, 'the deadline is shared, not owned');
  });

  // The failure this design exists for. Window B wakes a second before the
  // deadline and window A a second after it. Under a held lease B claims,
  // declines to poll because it is not due, and locks A out of the turn it was
  // entitled to — so the poll slips a whole interval, every interval.
  it('lets a due window in when an early one has just looked', async () => {
    const early = windowNamed('early');
    const onTime = windowNamed('on-time');

    assert.strictEqual(await poll(early), true, 'somebody has to start the clock');

    clock.advance(INTERVAL - 2 * DUE_TOLERANCE_MS);
    assert.strictEqual(await poll(early), false, 'not due yet, and it takes nothing');

    clock.advance(2 * DUE_TOLERANCE_MS);
    assert.strictEqual(await poll(onTime), true, 'the early look must not have cost this turn');
  });

  // The single-window version of the same bug: a timer that fires a hair early
  // fails a strict deadline test, and a strict test would push the next attempt
  // out by a further interval — halving the polling rate from a 4ms miss.
  it('counts a wake-up that lands fractionally early as due', async () => {
    const a = windowNamed('window-a');
    await poll(a);

    clock.advance(INTERVAL - 4);
    assert.strictEqual(await poll(a), true, 'four milliseconds early is still due');
  });

  it('holds the cadence flat across many turns and several windows', async () => {
    const windows = ['a', 'b', 'c'].map(windowNamed);
    const polledAt: number[] = [];

    // Each window wakes on its own phase, spread across the interval, the way
    // three windows opened at different times actually behave.
    for (let step = 0; step < 30; step += 1) {
      const schedule = windows[step % windows.length];
      if (await poll(schedule)) {
        polledAt.push(clock.now());
      }
      clock.advance(INTERVAL / 3);
    }

    const gaps = polledAt.slice(1).map((at, index) => at - polledAt[index]);
    assert.ok(gaps.length > 5, `expected a run of polls, got ${polledAt.length}`);
    assert.ok(
      gaps.every((gap) => gap <= INTERVAL + DUE_TOLERANCE_MS),
      `the cadence must not decay: ${gaps.join(', ')}`,
    );
  });

  it('keeps a second window out while the first is still polling', async () => {
    const a = windowNamed('window-a');
    const b = windowNamed('window-b');

    await a.claim(); // claimed, not settled: a poll is in flight
    clock.advance(POLL_GUARD_MS - 1);

    assert.strictEqual(
      (await b.claim({ force: true })).granted,
      false,
      'the ledger must never have two writers, however the second window asks',
    );
  });

  it('takes over from a window that died mid-poll once the guard expires', async () => {
    const a = windowNamed('window-a');
    const b = windowNamed('window-b');

    await a.claim();
    clock.advance(INTERVAL + POLL_GUARD_MS);

    assert.strictEqual((await b.claim()).granted, true);
  });

  it('outlasts the slowest poll the HTTP client will allow before aborting', () => {
    // `httpUsagePoller` aborts a request at 30s. A guard shorter than that would
    // stop counting a live request as in flight, which is the one way two hosts
    // could end up writing one session file.
    assert.ok(POLL_GUARD_MS > 30_000, `guard is ${POLL_GUARD_MS}ms`);
  });

  // No staleness timeout and no liveness probe: a window that dies holding a
  // turn costs one sample, because the deadline it wrote on the way in is what
  // everyone else is waiting on.
  it('loses only one turn when the polling window never comes back', async () => {
    const dead = windowNamed('crashed');
    const live = windowNamed('survivor');

    await dead.claim();
    clock.advance(INTERVAL + POLL_GUARD_MS);

    assert.strictEqual((await live.claim()).granted, true, 'the next deadline is honoured as normal');
  });

  it('shares the failure count so a backoff outlives the window that started it', async () => {
    const a = windowNamed('window-a');
    const b = windowNamed('window-b');

    await a.claim();
    await a.settle(clock.now() + 4 * INTERVAL, 3);

    clock.advance(4 * INTERVAL);
    const claim = await b.claim();

    assert.strictEqual(claim.granted, true);
    assert.strictEqual(claim.failures, 3, 'a fresh window must not restart the ladder');
  });

  it('reports the deadline to a window that was refused, so it can wake on it', async () => {
    const a = windowNamed('window-a');
    await poll(a);

    clock.advance(INTERVAL / 2);
    const refused = await windowNamed('window-b').claim();

    assert.strictEqual(refused.granted, false);
    assert.strictEqual(refused.dueAt, T0 + INTERVAL, 'the shared deadline, not a private one');
  });

  it('lets a forced refresh preempt a deadline it did not set', async () => {
    const a = windowNamed('window-a');
    const b = windowNamed('window-b');

    await poll(a);
    clock.advance(1000);

    assert.strictEqual((await b.claim()).granted, false, 'not due');
    assert.strictEqual(
      (await b.claim({ force: true })).granted,
      true,
      'a refresh the user asked for should not defer to another window',
    );
  });

  it('refuses even a forced refresh while somebody is mid-poll', async () => {
    const a = windowNamed('window-a');
    await a.claim();

    assert.strictEqual((await windowNamed('window-b').claim({ force: true })).granted, false);
  });

  it('does not let a settle from a preempted window move the deadline back', async () => {
    const a = windowNamed('window-a');
    const b = windowNamed('window-b');

    await a.claim();
    clock.advance(POLL_GUARD_MS + 1);
    await b.claim({ force: true });

    // `a` finally finishes and tries to record a deadline of its own.
    await a.settle(clock.now() + 10, 0);

    const state = JSON.parse(await fs.readFile(statePath(root), 'utf8')) as Record<string, unknown>;
    assert.strictEqual(state.owner, 'window-b', 'the newer claim owns the schedule');
  });

  it('clears its in-flight mark on release without touching the deadline', async () => {
    const a = windowNamed('window-a');
    const b = windowNamed('window-b');

    const claim = await a.claim();
    await a.release();

    const after = await b.claim();
    assert.strictEqual(after.granted, false, 'the deadline survives a window closing');
    assert.strictEqual(after.dueAt, claim.dueAt);
    assert.strictEqual(
      (await b.claim({ force: true })).granted,
      true,
      'but nobody is polling, so a forced refresh is free to take a turn',
    );
  });

  it('treats a corrupt file as no schedule at all rather than jamming forever', async () => {
    await fs.writeFile(statePath(root), 'not json', 'utf8');
    assert.strictEqual((await windowNamed('window-a').claim()).granted, true);
  });

  it('treats a file left by the old lease format as no schedule', async () => {
    await fs.writeFile(
      statePath(root),
      JSON.stringify({ owner: 'previous-format', pid: 1234, renewedAt: T0 }),
      'utf8',
    );

    assert.strictEqual(
      (await windowNamed('window-a').claim()).granted,
      true,
      'an upgrade should cost one early poll, not a stuck schedule',
    );
  });

  it('settles a simultaneous race on exactly one winner', async () => {
    const windows = ['a', 'b', 'c'].map(windowNamed);

    // A tie is possible on the first pass — two windows can read the same free
    // deadline before either writes — and costs one extra request, once.
    const first = await Promise.all(windows.map((schedule) => schedule.claim()));
    assert.ok(first.some((claim) => claim.granted), 'somebody has to poll');

    // Whoever won is mid-poll as far as the file is concerned, and the deadline
    // they wrote is an interval out, so the second pass grants nothing at all.
    const second = await Promise.all(windows.map((schedule) => schedule.claim()));
    assert.deepStrictEqual(
      second.filter((claim) => claim.granted),
      [],
      'no window may join a poll already in flight',
    );
  });

  it('leaves no temp files behind', async () => {
    await windowNamed('window-a').claim();
    assert.deepStrictEqual(await fs.readdir(root), ['poll.lease']);
  });
});
