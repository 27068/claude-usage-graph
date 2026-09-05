// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { toFileName } from '../../core/fileNames';
import { FileLedgerStorage } from '../../core/ledgerStorage';
import { LedgerCache } from '../../core/ledgerCache';
import { PollSchedule } from '../../core/pollSchedule';
import { UsageEngine } from '../../core/usageEngine';
import { PollError } from '../../core/types';
import type { LedgerUpdatedEvent, StatusEvent } from '../../core/types';
import {
  FakeClock,
  RecordingLogger,
  SimpleEventBus,
  StubPoller,
  makeTempDir,
  removeTempDir,
  snapshotAt,
} from './helpers';

const NOW = Date.UTC(2026, 4, 20, 12, 0);
const HOUR = 3_600_000;
const INTERVAL = 180_000;

describe('UsageEngine', () => {
  let root: string;
  let clock: FakeClock;
  let logger: RecordingLogger;
  let storage: FileLedgerStorage;
  let cache: LedgerCache;
  let updates: SimpleEventBus<LedgerUpdatedEvent>;
  let statuses: SimpleEventBus<StatusEvent>;
  let engine: UsageEngine | undefined;

  beforeEach(async () => {
    root = await makeTempDir();
    clock = new FakeClock(NOW);
    logger = new RecordingLogger();
    storage = new FileLedgerStorage(root, logger);
    cache = new LedgerCache(storage);
    updates = new SimpleEventBus();
    statuses = new SimpleEventBus();
  });

  afterEach(async () => {
    engine?.dispose();
    engine = undefined;
    await removeTempDir(root);
  });

  function build(poller: StubPoller, owner = 'window-a', retentionMs?: number): UsageEngine {
    const schedule = new PollSchedule(root, owner, clock, logger, INTERVAL);
    engine = new UsageEngine(poller, storage, cache, updates, statuses, schedule, clock, logger, {
      intervalMs: INTERVAL,
      ...(retentionMs === undefined ? {} : { retentionMs }),
    });
    return engine;
  }

  /**
   * The next scheduled tick, which is time passing and *then* the timer firing.
   *
   * The schedule is a shared deadline, so a tick arriving early defers to it and
   * does not poll. A test that means "the following poll" has to let the interval
   * elapse like everything else.
   */
  async function nextTick(built: UsageEngine): Promise<void> {
    clock.advance(INTERVAL);
    await built.tick();
  }

  it('writes a session file and a week file from one poll', async () => {
    const poller = new StubPoller(snapshotAt(NOW, { five: 35, fiveReset: NOW + 2 * HOUR }));
    await build(poller).start();

    assert.strictEqual((await storage.list('five_hour')).length, 1);
    assert.strictEqual((await storage.list('seven_day')).length, 1);
  });

  it('names the session file for the session start, not the reset', async () => {
    const reset = NOW + 2 * HOUR;
    await build(new StubPoller(snapshotAt(NOW, { fiveReset: reset }))).start();

    const [name] = await storage.list('five_hour');
    const file = await storage.read('five_hour', name);
    assert.strictEqual(file?.startAt, reset - 5 * HOUR, 'startAt is resets_at minus five hours');
    assert.strictEqual(file?.resetAt, reset);
  });

  it('stores resetAt once in the header rather than on every row', async () => {
    const poller = new StubPoller().push(
      snapshotAt(NOW, { five: 10, fiveReset: NOW + 2 * HOUR }),
      snapshotAt(NOW + 60_000, { five: 20, fiveReset: NOW + 2 * HOUR }),
    );
    const built = build(poller);
    await built.start();
    await nextTick(built);

    const [name] = await storage.list('five_hour');
    const file = await storage.read('five_hour', name);
    assert.strictEqual(file?.samples.length, 2);
    for (const sample of file.samples) {
      assert.strictEqual(sample.length, 2, 'a row is [t, five_hour] and nothing more');
    }
  });

  it('rolls onto a new file when the reset boundary moves', async () => {
    const first = NOW + 2 * HOUR;
    const second = NOW + 8 * HOUR;
    const poller = new StubPoller().push(
      snapshotAt(NOW, { five: 90, fiveReset: first }),
      snapshotAt(NOW + 3 * HOUR, { five: 4, fiveReset: second }),
    );

    const built = build(poller);
    await built.start();
    clock.advance(3 * HOUR);
    await built.tick();

    const names = await storage.list('five_hour');
    assert.strictEqual(names.length, 2, 'a new session must land in its own file');
  });

  it('compresses a steady run instead of growing the file', async () => {
    const reset = NOW + 4 * HOUR;
    const poller = new StubPoller(snapshotAt(NOW, { five: 12, fiveReset: reset }));
    const built = build(poller);

    await built.start();
    for (let tick = 0; tick < 5; tick += 1) {
      clock.advance(INTERVAL);
      await built.tick();
    }

    const [name] = await storage.list('five_hour');
    const file = await storage.read('five_hour', name);
    assert.strictEqual(file?.samples.length, 2, 'anchor plus bookend, however many ticks');
  });

  it('publishes an update with a monotonically increasing revision', async () => {
    const poller = new StubPoller(snapshotAt(NOW, { fiveReset: NOW + HOUR }));
    const built = build(poller);

    await built.start();
    await nextTick(built);
    await nextTick(built);

    const revisions = updates.received.map((event) => event.revision);
    assert.deepStrictEqual(revisions, [1, 2, 3]);
  });

  it('publishes even when nobody is listening', async () => {
    const poller = new StubPoller(snapshotAt(NOW, { fiveReset: NOW + HOUR }));
    await build(poller).start();

    assert.strictEqual(updates.listenerCount, 0, 'no panel is open');
    assert.strictEqual(updates.received.length, 1, 'the engine still records and fires');
  });

  /**
   * Plan changes, which the endpoint reports simply by starting or stopping to
   * send a `seven_day_*` window. Nothing signals the switch, so the ledger has to
   * absorb it mid-cycle without a migration and without disturbing what it has
   * already written — see the append-only rule on `LedgerFile.cols`.
   */
  describe('per-model columns', () => {
    const sevenReset = NOW + 3 * 86_400_000;
    const week = async () => (await storage.read('seven_day', (await storage.list('seven_day'))[0]))!;

    it('never opens a column for a tier reported as present-but-null', async () => {
      // The Pro case exactly: the keys are in the payload on every poll, always
      // carrying null. A column here would chart as a permanently empty series.
      const poller = new StubPoller().push(
        snapshotAt(NOW, { fiveReset: NOW + HOUR, sevenReset, seven: 10, models: { seven_day_opus: null } }),
      );
      await build(poller).start();

      assert.deepStrictEqual((await week()).cols, ['seven_day']);
    });

    it('appends a column mid-cycle when a tier starts reporting', async () => {
      const poller = new StubPoller().push(
        snapshotAt(NOW, { fiveReset: NOW + HOUR, sevenReset, seven: 10 }),
        snapshotAt(NOW + 60_000, {
          fiveReset: NOW + HOUR,
          sevenReset,
          seven: 12,
          models: { seven_day_fable: 4 },
        }),
      );
      const built = build(poller);
      await built.start();
      await built.tick({ force: true });

      const file = await week();
      assert.deepStrictEqual(file.cols, ['seven_day', 'seven_day_fable']);
      // The row written before the tier existed is short rather than rewritten,
      // which is what makes this safe without a migration: it reads as null.
      assert.deepStrictEqual(file.samples[0], [NOW, 10]);
      assert.deepStrictEqual(file.samples[1], [NOW + 60_000, 12, 4]);
    });

    it('keeps the column, and its history, when a tier stops reporting', async () => {
      const poller = new StubPoller().push(
        snapshotAt(NOW, { fiveReset: NOW + HOUR, sevenReset, seven: 10, models: { seven_day_fable: 4 } }),
        snapshotAt(NOW + 60_000, { fiveReset: NOW + HOUR, sevenReset, seven: 12 }),
      );
      const built = build(poller);
      await built.start();
      await built.tick({ force: true });

      const file = await week();
      assert.deepStrictEqual(file.cols, ['seven_day', 'seven_day_fable']);
      assert.deepStrictEqual(file.samples[0], [NOW, 10, 4]);
      // Null holds the slot. Dropping the column would re-read row 0's 4 as a
      // seven_day value on the next load.
      assert.deepStrictEqual(file.samples[1], [NOW + 60_000, 12, null]);
    });

    it('starts each cycle from a bare header instead of inheriting dead columns', async () => {
      // The bound on column growth, and the reason a decade of model churn
      // cannot silt a file up with nulls: append-only is scoped to one file, and
      // a week file lives exactly one cycle. Every roll re-seeds from
      // `WEEK_BASE_COLS`, so a file only ever carries the tiers that reported a
      // number during its own seven days — not the union of everything that has
      // ever existed.
      const secondReset = sevenReset + 7 * 24 * HOUR;
      const poller = new StubPoller().push(
        snapshotAt(NOW, {
          fiveReset: NOW + HOUR,
          sevenReset,
          seven: 10,
          models: { seven_day_fable: 4 },
        }),
        snapshotAt(NOW + 4 * 24 * HOUR, {
          fiveReset: NOW + 4 * 24 * HOUR + HOUR,
          sevenReset: secondReset,
          seven: 3,
        }),
      );
      const built = build(poller);
      await built.start();
      clock.advance(4 * 24 * HOUR);
      await built.tick();

      const names = await storage.list('seven_day');
      assert.strictEqual(names.length, 2, 'a new cycle lands in its own file');

      const [older, newer] = await Promise.all(names.map((name) => storage.read('seven_day', name)));
      assert.deepStrictEqual(older?.cols, ['seven_day', 'seven_day_fable'], 'the week that had it');
      assert.deepStrictEqual(newer?.cols, ['seven_day'], 'the week that did not');
    });

    it("fills an older build's columns by name rather than by position", async () => {
      // A file seeded before this code existed, carrying two tiers that never
      // report and the retired `extra_usage` column.
      await storage.ensureLayout();
      await storage.commit(
        'seven_day',
        toFileName(sevenReset - 7 * 24 * HOUR),
        () => ({
          v: 1 as const,
          kind: 'seven_day' as const,
          startAt: sevenReset - 7 * 24 * HOUR,
          resetAt: sevenReset,
          cols: ['seven_day', 'seven_day_sonnet', 'seven_day_opus', 'extra_usage'],
          samples: [],
        }),
        () => {},
      );

      const poller = new StubPoller().push(
        snapshotAt(NOW, { fiveReset: NOW + HOUR, sevenReset, seven: 10, models: { seven_day_opus: 6 } }),
      );
      await build(poller).start();

      const file = await week();
      assert.deepStrictEqual(file.cols, ['seven_day', 'seven_day_sonnet', 'seven_day_opus', 'extra_usage']);
      // Opus lands in slot 3 because that is where *this file* keeps it, and the
      // columns it has no window for hold their places as null.
      assert.deepStrictEqual(file.samples[0], [NOW, 10, null, 6, null]);
    });
  });

  it('carries the reset boundaries through in meta', async () => {
    const fiveReset = NOW + 2 * HOUR;
    const sevenReset = NOW + 3 * 86_400_000;
    await build(new StubPoller(snapshotAt(NOW, { fiveReset, sevenReset }))).start();

    const { meta } = updates.received[0];
    assert.strictEqual(meta.fiveResetAt, fiveReset);
    assert.strictEqual(meta.sevenResetAt, sevenReset);
  });

  it('reports ok after a successful poll', async () => {
    await build(new StubPoller(snapshotAt(NOW, { fiveReset: NOW + HOUR }))).start();
    assert.deepStrictEqual(statuses.received.at(-1), { state: 'ok' });
  });

  it('surfaces a credential failure without writing anything', async () => {
    const poller = new StubPoller(new PollError('no-credentials', 'not signed in'));
    await build(poller).start();

    assert.strictEqual(statuses.received.at(-1)?.state, 'no-credentials');
    assert.strictEqual((await storage.list('five_hour')).length, 0);
  });

  it('does not back off for an auth failure, since retrying costs nothing', async () => {
    const poller = new StubPoller(new PollError('auth-error', 'expired'));
    const built = build(poller);

    await built.start();
    await nextTick(built);
    await nextTick(built);

    assert.strictEqual(poller.calls, 3, 'it should keep checking on the normal cadence');
    assert.ok(
      statuses.received.every((event) => event.retryAt === undefined),
      'no backoff window should be advertised',
    );
  });

  it('advertises a retry time when rate limited', async () => {
    const poller = new StubPoller(new PollError('rate-limited', 'slow down'));
    await build(poller).start();

    const status = statuses.received.at(-1);
    assert.strictEqual(status?.state, 'rate-limited');
    assert.ok((status?.retryAt ?? 0) > NOW, 'a backoff deadline should be published');
  });

  it('recovers to the normal cadence after a rate limit clears', async () => {
    const poller = new StubPoller()
      .push(new PollError('rate-limited', 'slow down'))
      .push(snapshotAt(NOW, { fiveReset: NOW + HOUR }));
    const built = build(poller);

    await built.start();
    // A backoff pushes the shared deadline out, so the retry is not due for
    // longer than an ordinary interval — which is the point of recording it.
    clock.advance(4 * INTERVAL);
    await built.tick();

    assert.strictEqual(statuses.received.at(-1)?.state, 'ok');
  });

  it('treats an unexpected error as a network failure rather than crashing', async () => {
    const poller = new StubPoller(new Error('socket hang up'));
    await build(poller).start();

    assert.strictEqual(statuses.received.at(-1)?.state, 'network-error');
  });

  it('does not poll when the turn is not due, but still refreshes from disk', async () => {
    // Another window took a turn a moment ago and set the deadline.
    const other = new PollSchedule(root, 'window-b', clock, logger, INTERVAL);
    await other.claim();
    await other.settle(clock.now() + INTERVAL, 0);

    const poller = new StubPoller(snapshotAt(NOW, { fiveReset: NOW + HOUR }));
    await build(poller, 'window-a').start();

    assert.strictEqual(poller.calls, 0, 'one request per machine per turn');
    assert.strictEqual(updates.received.length, 1, 'it should still publish from disk');
  });

  // "Refresh Now" exists so a user who does not want to wait out the interval
  // does not have to — from whichever window they happen to be looking at.
  it('polls on a forced tick even when another window set the deadline', async () => {
    const other = new PollSchedule(root, 'window-b', clock, logger, INTERVAL);
    await other.claim();
    await other.settle(clock.now() + INTERVAL, 0);

    const poller = new StubPoller(snapshotAt(NOW, { fiveReset: NOW + HOUR }));
    const built = build(poller, 'window-a');
    await built.start();
    assert.strictEqual(poller.calls, 0, 'the scheduled tick defers');

    await built.tick({ force: true });
    assert.strictEqual(poller.calls, 1, 'a hand-forced refresh does not');
  });

  it('reports reset boundaries from the ledger when another window is polling', async () => {
    // The leader records the windows and sets the deadline; the follower behind
    // it never polls, so its only source for a boundary is the file headers.
    const fiveReset = NOW + 2 * HOUR;
    const sevenReset = NOW + 3 * 86_400_000;
    await build(new StubPoller(snapshotAt(NOW, { fiveReset, sevenReset })), 'leader').start();
    updates.received.length = 0;

    const follower = new StubPoller(snapshotAt(NOW, { fiveReset, sevenReset }));
    await build(follower, 'follower').start();

    assert.strictEqual(follower.calls, 0, 'the follower must not poll');
    const { meta } = updates.received[0];
    assert.strictEqual(meta.fiveResetAt, fiveReset, 'read from the session file header');
    assert.strictEqual(meta.sevenResetAt, sevenReset, 'read from the week file header');
  });

  it('does not report a reset boundary that has already passed', async () => {
    await build(new StubPoller(snapshotAt(NOW, { fiveReset: NOW + HOUR })), 'leader').start();
    updates.received.length = 0;

    // Long enough that both recorded windows have closed, whichever source the
    // boundary would have come from.
    clock.set(NOW + 8 * 86_400_000);
    await build(new StubPoller(snapshotAt(NOW, { fiveReset: NOW + HOUR })), 'follower').start();

    const { meta } = updates.received[0];
    assert.strictEqual(meta.fiveResetAt, null);
    assert.strictEqual(meta.sevenResetAt, null);
  });

  // Eviction is budgeted and fire-and-forget — `start()` deliberately does not
  // wait for it, so the test does what production does not and awaits the pass.
  // The wiring, not the policy: a retention is passed in rather than left to the
  // default, so this keeps testing that `start` builds an evictor and the sweep
  // runs whatever the shipped window happens to be.
  it('evicts stale files on startup', async () => {
    const old = Date.UTC(2026, 2, 1, 9, 0); // well over 30 days before NOW
    await storage.ensureLayout();
    await storage.commit(
      'five_hour',
      '2026-03-01T0900Z.json',
      () => ({
        v: 1,
        kind: 'five_hour',
        startAt: old,
        resetAt: old + 5 * HOUR,
        cols: ['five_hour'],
        samples: [[old, 1]],
      }),
      () => undefined,
    );

    const built = build(
      new StubPoller(snapshotAt(NOW, { fiveReset: NOW + HOUR })),
      'window-a',
      30 * 24 * HOUR,
    );
    await built.start();
    await built.whenEvicted();

    const names = await storage.list('five_hour');
    assert.ok(!names.includes('2026-03-01T0900Z.json'), 'the stale file should be gone');
  });

  it('stops polling once disposed', async () => {
    const poller = new StubPoller(snapshotAt(NOW, { fiveReset: NOW + HOUR }));
    const built = build(poller);
    await built.start();

    const callsBefore = poller.calls;
    built.dispose();
    await built.tick();

    assert.strictEqual(poller.calls, callsBefore, 'a disposed engine must not poll');
  });
});
