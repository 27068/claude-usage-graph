// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { clearLedger } from '../../core/eviction';
import { LedgerCache } from '../../core/ledgerCache';
import { FileLedgerStorage } from '../../core/ledgerStorage';
import { PollSchedule } from '../../core/pollSchedule';
import { UsageEngine } from '../../core/usageEngine';
import type {
  LedgerFile,
  LedgerKind,
  LedgerPatch,
  LedgerSnapshot,
  LedgerUpdatedEvent,
} from '../../core/types';
import type { StatusEvent } from '../../core/types';
import {
  FakeClock,
  RecordingLogger,
  SimpleEventBus,
  StubPoller,
  makeTempDir,
  readLedger,
  removeTempDir,
  snapshotAt,
} from './helpers';

const NOW = Date.UTC(2026, 4, 20, 12, 0);
const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * The client half of the patch protocol, in the smallest form that still tests
 * it: a page of history, a live file, and the rules `main.ts` applies to each.
 *
 * Deliberately a re-implementation rather than an import. `main.ts` cannot be
 * loaded by the terminal suite — it reaches for `acquireVsCodeApi` and a canvas
 * — so what is checked here is the *contract*: that the sequence of patches the
 * host emits is enough to keep a client that already holds a page in agreement
 * with the directory. A dropped or over-eager patch breaks that.
 *
 * The two halves have different lifetimes, and the rules follow from it. History
 * is immutable once a window has closed, so the page is replaced wholesale and
 * only ever *updated* for files it already holds — that is what keeps the
 * session that just closed at its final samples instead of frozen at whatever
 * the last patch before the rollover said. The live slot takes the newest file
 * of a kind, which is the only one a poll can write.
 */
class FakeClient {
  private page = {
    five_hour: new Map<number, LedgerFile>(),
    seven_day: new Map<number, LedgerFile>(),
  };
  private live: Record<LedgerKind, LedgerFile | undefined> = {
    five_hour: undefined,
    seven_day: undefined,
  };

  /** What `hydrate` carries: the live window of each kind, and nothing else. */
  hydrate(live: Record<LedgerKind, LedgerFile | undefined>): void {
    this.live = { ...live };
  }

  /** What a `ledger/page` answer carries. */
  setPage(snapshot: LedgerSnapshot): void {
    this.page = {
      five_hour: new Map(snapshot.sessions.map((file) => [file.startAt, file])),
      seven_day: new Map(snapshot.weeks.map((file) => [file.startAt, file])),
    };
  }

  apply(patch: LedgerPatch): void {
    for (const ref of patch.removed) {
      this.page[ref.kind].delete(ref.startAt);
      if (this.live[ref.kind]?.startAt === ref.startAt) {
        this.live[ref.kind] = undefined;
      }
    }
    for (const file of patch.changed) {
      if (this.page[file.kind].has(file.startAt)) {
        this.page[file.kind].set(file.startAt, file);
      }
      const current = this.live[file.kind];
      if (current === undefined || file.startAt >= current.startAt) {
        this.live[file.kind] = file;
      }
    }
  }

  ledger(): LedgerSnapshot {
    const order = (kind: LedgerKind): LedgerFile[] => {
      const merged = new Map(this.page[kind]);
      const current = this.live[kind];
      if (current !== undefined) {
        merged.set(current.startAt, current);
      }
      return [...merged.values()].sort((a, b) => a.resetAt - b.resetAt);
    };
    return { sessions: order('five_hour'), weeks: order('seven_day') };
  }
}

describe('ledger patches', () => {
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

  // A one-minute cadence, matching the spacing of the snapshots these tests
  // script. The schedule and the engine have to agree on it: a tick that lands
  // inside the interval defers to the shared deadline instead of polling, so an
  // engine paced slower than its fixture would simply skip most of it.
  function build(poller: StubPoller, owner = 'window-a'): UsageEngine {
    const schedule = new PollSchedule(root, owner, clock, logger, MINUTE);
    engine = new UsageEngine(poller, storage, cache, updates, statuses, schedule, clock, logger, {
      intervalMs: MINUTE,
    });
    return engine;
  }

  /** What `DashboardPanel.hydrate` builds out of the cache. */
  function liveOf(): Record<LedgerKind, LedgerFile | undefined> {
    return { five_hour: cache.newest('five_hour'), seven_day: cache.newest('seven_day') };
  }

  it('sends only the files a tick actually wrote', async () => {
    const poller = new StubPoller(snapshotAt(NOW, { five: 10, fiveReset: NOW + 2 * HOUR }));
    await build(poller).start();

    const patch = updates.received[updates.received.length - 1].patch;
    // One session file and one week file — not the ledger.
    assert.strictEqual(patch.changed.length, 2);
    assert.deepStrictEqual(
      patch.changed.map((file) => file.kind).sort(),
      ['five_hour', 'seven_day'],
    );
    assert.deepStrictEqual(patch.removed, []);
  });

  it('stops resending a session once a later one has opened', async () => {
    // The property that makes a patch a patch: it names the files this tick
    // wrote, so the ledger can grow without the per-tick payload growing with
    // it. A steady value is *not* the case to test — a bookend slides the last
    // row's timestamp, so a file under an unchanged value has still changed on
    // disk and the client does need it. Closed files are the case: nothing can
    // touch them again.
    const sevenReset = NOW + 5 * 24 * HOUR;
    const poller = new StubPoller().push(
      snapshotAt(NOW, { five: 10, seven: 20, fiveReset: NOW + HOUR, sevenReset }),
      // A new boundary rolls onto a second file; the first is now closed.
      snapshotAt(NOW + MINUTE, { five: 4, seven: 21, fiveReset: NOW + 6 * HOUR, sevenReset }),
      snapshotAt(NOW + 2 * MINUTE, { five: 6, seven: 22, fiveReset: NOW + 6 * HOUR, sevenReset }),
    );
    const built = build(poller);
    await built.start();

    const first = (await readLedger(storage)).sessions[0].startAt;

    clock.advance(MINUTE);
    await built.tick();
    clock.advance(MINUTE);
    await built.tick();

    const onRecord = await readLedger(storage);
    assert.strictEqual(onRecord.sessions.length, 2, 'precondition: two sessions on record');

    const third = updates.received[updates.received.length - 1].patch;
    assert.strictEqual(third.changed.length, 2, 'still one file per kind, not the ledger');
    assert.ok(
      !third.changed.some((file) => file.startAt === first),
      'a closed session must not keep riding along in every patch',
    );
  });

  it('replays to exactly what is on disk', async () => {
    // The invariant the whole protocol rests on: take a page, hydrate on the live
    // window, apply every patch after that, and the client agrees with the
    // directory. A patch that omitted a real change, or a change nothing
    // announced, shows up right here.
    //
    // Against disk rather than against the cache: the cache holds the live
    // window, which is one of the two things being checked.
    const sevenReset = NOW + 5 * 24 * HOUR;
    const poller = new StubPoller().push(
      snapshotAt(NOW, { five: 10, seven: 20, fiveReset: NOW + 2 * HOUR, sevenReset }),
      // A bookend: identical values, so only the last row's timestamp slides.
      snapshotAt(NOW + MINUTE, { five: 10, seven: 20, fiveReset: NOW + 2 * HOUR, sevenReset }),
      snapshotAt(NOW + 2 * MINUTE, { five: 10, seven: 20, fiveReset: NOW + 2 * HOUR, sevenReset }),
      // A new session: the reset boundary moves, so a second file is opened.
      snapshotAt(NOW + 3 * MINUTE, { five: 4, seven: 21, fiveReset: NOW + 7 * HOUR, sevenReset }),
      // A dead-zone break, from a gap longer than IDLE_GAP_MS with a new value.
      snapshotAt(NOW + 40 * MINUTE, { five: 30, seven: 22, fiveReset: NOW + 7 * HOUR, sevenReset }),
    );
    const built = build(poller);

    const client = new FakeClient();
    await built.start();
    // Open a panel mid-flight: it is handed the live window, asks for a page,
    // and follows the patch stream from there.
    client.hydrate(liveOf());
    client.setPage(await readLedger(storage));

    for (const step of [MINUTE, MINUTE, MINUTE, 37 * MINUTE]) {
      const before = updates.received.length;
      clock.advance(step);
      await built.tick();
      for (const event of updates.received.slice(before)) {
        client.apply(event.patch);
      }
    }

    const onDisk = await readLedger(storage);
    assert.deepStrictEqual(client.ledger(), onDisk);
    assert.strictEqual(onDisk.sessions.length, 2, 'the run should have opened two sessions');
  });

  it('reports removals, so a wiped ledger does not linger on the client', async () => {
    // The scenario runner's path: clear the files, reload, and let the next
    // publish carry it. Without removals in the patch the client would keep
    // drawing the previous scenario underneath the new one.
    const poller = new StubPoller(snapshotAt(NOW, { five: 10, fiveReset: NOW + 2 * HOUR }));
    const built = build(poller);
    await built.start();

    const client = new FakeClient();
    client.hydrate(liveOf());
    client.setPage(await readLedger(storage));
    assert.ok(client.ledger().sessions.length > 0, 'precondition: the client holds something');

    await clearLedger(storage, cache, logger);
    await cache.reload();

    client.apply(cache.drainPatch());
    assert.deepStrictEqual(client.ledger(), { sessions: [], weeks: [] });
  });

  it('a follower that re-reads the directory reports only what moved', async () => {
    // A window that does not take the turn reloads the ledger from disk. Re-reading
    // is not changing: the second reload must announce nothing, or every follower
    // tick would republish the entire ledger.
    const poller = new StubPoller(snapshotAt(NOW, { five: 10, fiveReset: NOW + 2 * HOUR }));
    await build(poller).start();

    const follower = new LedgerCache(storage);
    await follower.reload();
    assert.strictEqual(follower.drainPatch().changed.length, 2, 'first read is all new');

    await follower.reload();
    const second = follower.drainPatch();
    assert.deepStrictEqual(second.changed, [], 'an unchanged re-read announces nothing');
    assert.deepStrictEqual(second.removed, []);
  });

  it('notices a bookend, where only the final timestamp moved', async () => {
    // The case a coarse change check would miss. A bookend rewrites no rows and
    // adds none; it slides the last row's instant, so the file keeps exactly its
    // old size and only mtime moves. Missing it would freeze a follower's chart.
    const poller = new StubPoller().push(
      snapshotAt(NOW, { five: 10, fiveReset: NOW + 2 * HOUR }),
      snapshotAt(NOW + MINUTE, { five: 10, fiveReset: NOW + 2 * HOUR }),
      snapshotAt(NOW + 2 * MINUTE, { five: 10, fiveReset: NOW + 2 * HOUR }),
    );
    const built = build(poller);
    await built.start();

    const follower = new LedgerCache(storage);
    await follower.reload();
    follower.drainPatch();

    clock.advance(MINUTE);
    await built.tick();
    clock.advance(MINUTE);
    await built.tick();

    await follower.reload();
    const patch = follower.drainPatch();
    assert.ok(
      patch.changed.some((file) => file.kind === 'five_hour'),
      'a slid bookend has to register as a change',
    );
  });

  it('empties the patch once drained', async () => {
    const poller = new StubPoller(snapshotAt(NOW, { five: 10, fiveReset: NOW + 2 * HOUR }));
    await build(poller).start();

    // The engine already drained it when it published.
    assert.deepStrictEqual(cache.drainPatch(), { changed: [], removed: [] });
  });

  it('newest is the window still open, not the last one to be written', async () => {
    const poller = new StubPoller().push(
      snapshotAt(NOW, { five: 10, fiveReset: NOW + 2 * HOUR }),
      snapshotAt(NOW + MINUTE, { five: 4, fiveReset: NOW + 9 * HOUR }),
    );
    const built = build(poller);
    await built.start();
    clock.advance(MINUTE);
    await built.tick();

    const onDisk = await readLedger(storage);
    assert.strictEqual(onDisk.sessions.length, 2, 'precondition: the second session opened');
    assert.deepStrictEqual(
      cache.newest('five_hour'),
      onDisk.sessions[onDisk.sessions.length - 1],
    );
    assert.deepStrictEqual(cache.newest('seven_day'), onDisk.weeks[onDisk.weeks.length - 1]);
  });
});
