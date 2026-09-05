// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { LedgerCache } from '../../core/ledgerCache';
import { FileLedgerStorage } from '../../core/ledgerStorage';
import type { LedgerKind } from '../../core/types';
import { RecordingLogger, makeLedgerFile, makeTempDir, removeTempDir } from './helpers';

const NOW = Date.UTC(2026, 4, 20, 12, 0);
const HOUR = 3_600_000;

/**
 * `FileLedgerStorage`, plus a note of every file it was asked to open.
 *
 * The whole point of the reload is the reads it *does not* do, and a negative
 * like that cannot be observed from the outside — the cache ends up holding the
 * same live file either way. So the count is the assertion.
 */
class CountingStorage extends FileLedgerStorage {
  readonly reads: string[] = [];

  override async read(kind: LedgerKind, name: string) {
    this.reads.push(`${kind}/${name}`);
    return super.read(kind, name);
  }

  taken(): string[] {
    const seen = [...this.reads];
    this.reads.length = 0;
    return seen;
  }
}

describe('ledger reload', () => {
  let root: string;
  let logger: RecordingLogger;

  beforeEach(async () => {
    root = await makeTempDir();
    logger = new RecordingLogger();
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  /** Names sort chronologically, so index 0 is oldest and the last one is live. */
  const sessionName = (index: number): string =>
    `2026-05-${String(10 + index).padStart(2, '0')}T0900Z.json`;

  /** Write a session file directly, bypassing the cache. */
  async function writeSession(index: number, rows: number): Promise<void> {
    const startAt = NOW + index * HOUR;
    const file = makeLedgerFile('five_hour', startAt, startAt + 5 * HOUR);
    for (let row = 0; row < rows; row += 1) {
      file.samples.push([startAt + row * 180_000, row % 100]);
    }
    await fs.writeFile(
      path.join(root, 'sessions', sessionName(index)),
      JSON.stringify(file),
      'utf8',
    );
  }

  async function seeded(storage: CountingStorage, count: number): Promise<LedgerCache> {
    await storage.ensureLayout();
    for (let index = 0; index < count; index += 1) {
      await writeSession(index, 4);
    }
    const cache = new LedgerCache(storage);
    await cache.reload();
    storage.taken();
    cache.drainPatch();
    return cache;
  }

  /** The live file's `startAt`, which is how a removal identifies itself. */
  const liveStart = (index: number): number => NOW + index * HOUR;

  // The cost this design exists to avoid: opening every file in the retention
  // window before anything can paint is per-file overhead — 0.1 ms here, tens of
  // milliseconds each on a redirected storage root — times however much history
  // the user keeps.
  it('opens one file per kind on a cold cache, whatever the ledger holds', async () => {
    const storage = new CountingStorage(root, logger);
    await storage.ensureLayout();
    for (let index = 0; index < 6; index += 1) {
      await writeSession(index, 4);
    }

    const cache = new LedgerCache(storage);
    await cache.reload();

    assert.deepStrictEqual(
      storage.taken(),
      [`five_hour/${sessionName(5)}`],
      'the first load costs the same as every load after it',
    );
    assert.strictEqual(cache.newest('five_hour')?.startAt, liveStart(5));
    assert.strictEqual(
      cache.drainPatch().changed.length,
      1,
      'and it announces the live file, not the ledger',
    );
  });

  it('opens only the live file on a quiet tick, and announces nothing', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 5);

    await cache.reload();

    assert.deepStrictEqual(
      storage.taken(),
      [`five_hour/${sessionName(4)}`],
      'one read, regardless of how many closed windows are on record',
    );
    assert.deepStrictEqual(
      cache.drainPatch(),
      { changed: [], removed: [] },
      'an unchanged live file announces nothing',
    );
  });

  it('publishes the live file when it actually moved', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 5);

    await writeSession(4, 9);
    await cache.reload();

    assert.deepStrictEqual(storage.taken(), [`five_hour/${sessionName(4)}`]);
    const patch = cache.drainPatch();
    assert.strictEqual(patch.changed.length, 1);
    assert.strictEqual(patch.changed[0].samples.length, 9);
  });

  it('picks up a file that appeared since the last reload', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 2);

    await writeSession(2, 6);
    await cache.reload();

    assert.deepStrictEqual(
      storage.taken(),
      [`five_hour/${sessionName(2)}`],
      'the new file is also the live one, so it is read once and not twice',
    );
    assert.strictEqual(cache.drainPatch().changed.length, 1);
    assert.strictEqual(cache.newest('five_hour')?.startAt, liveStart(2));
  });

  // A rollover is not a deletion, and the difference is the whole reason the
  // check below is against the *listing* rather than against "is it still live".
  // Reporting it would have a panel drop the session that just closed.
  it('does not call a rollover a removal', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 3);

    await writeSession(3, 5);
    await cache.reload();

    const patch = cache.drainPatch();
    assert.deepStrictEqual(patch.removed, [], 'the file it held is still on disk');
    assert.strictEqual(patch.changed.length, 1, 'and the new window is what moved');
    assert.strictEqual(cache.newest('five_hour')?.startAt, liveStart(3));
  });

  // The cache holds one file per kind, so a deletion below that is invisible to
  // it — and has to be, or a partial view would be diffed as if it were a whole
  // one. `Evictor` and `clearLedger` announce their own; see `LedgerCache`.
  it('says nothing about a closed file that vanished', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 3);

    await fs.unlink(path.join(root, 'sessions', sessionName(1)));
    await cache.reload();

    assert.deepStrictEqual(
      storage.taken(),
      [`five_hour/${sessionName(2)}`],
      'the live file, and nothing on account of the deletion',
    );
    assert.deepStrictEqual(cache.drainPatch(), { changed: [], removed: [] });
  });

  // The one removal it can still speak for, because it is about a file the cache
  // actually holds rather than a diff over the directory.
  it('announces the live file when that is the one that vanished', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 3);

    await fs.unlink(path.join(root, 'sessions', sessionName(2)));
    await cache.reload();

    const patch = cache.drainPatch();
    assert.deepStrictEqual(patch.removed, [{ kind: 'five_hour', startAt: liveStart(2) }]);
    assert.strictEqual(patch.changed.length, 1, 'and the file behind it becomes live');
    assert.strictEqual(cache.newest('five_hour')?.startAt, liveStart(1));
  });

  it('drops the whole ledger when every file goes, then reloads a replacement', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 3);

    for (let index = 0; index < 3; index += 1) {
      await fs.unlink(path.join(root, 'sessions', sessionName(index)));
    }
    await cache.reload();
    assert.strictEqual(cache.newest('five_hour'), undefined);
    assert.deepStrictEqual(
      cache.drainPatch().removed,
      [{ kind: 'five_hour', startAt: liveStart(2) }],
      'the one it held; the rest were announced by whoever deleted them',
    );

    await writeSession(0, 17);
    await cache.reload();

    assert.strictEqual(cache.newest('five_hour')?.samples.length, 17, 'read fresh');
  });

  /**
   * The assumption, pinned so it is discoverable rather than surprising.
   *
   * A closed window's file is never re-read. Nothing in the engine rewrites one
   * — `commit` only ever names the window currently open — so this records the
   * boundary of the design rather than a defect. It is also what lets a page
   * pulled from storage need no invalidation: if a closed file could change, a
   * page held by a panel could go stale with nothing to say so.
   */
  it('does not notice a closed file rewritten behind its back', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 4);

    await writeSession(0, 17);
    await cache.reload();

    assert.deepStrictEqual(
      storage.taken(),
      [`five_hour/${sessionName(3)}`],
      'only the live file is opened; the rewritten one is never looked at',
    );
    assert.deepStrictEqual(cache.drainPatch(), { changed: [], removed: [] });
  });

  it('re-reads the live file it wrote itself, and stays quiet about it', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 3);

    // What `UsageEngine.commit` does: hand the cache the file it just wrote.
    const startAt = liveStart(2);
    const file = makeLedgerFile('five_hour', startAt, startAt + 5 * HOUR);
    for (let row = 0; row < 4; row += 1) {
      file.samples.push([startAt + row * 180_000, row % 100]);
    }
    cache.put('five_hour', sessionName(2), file);
    cache.drainPatch();

    await cache.reload();

    assert.deepStrictEqual(storage.taken(), [`five_hour/${sessionName(2)}`]);
    assert.deepStrictEqual(
      cache.drainPatch(),
      { changed: [], removed: [] },
      'the fingerprint is what stops a window republishing its own writes',
    );
  });

  // A `resetAt` that moved backwards past the minute `normalize` quantizes to
  // would have `commit` name a file behind the one already open. The patch still
  // carries it — the client applies its own ordering rule — but it must not
  // become what `meta` reads the countdown off.
  it('keeps the newer window live when a commit names an older one', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 3);

    const startAt = liveStart(0);
    const stale = makeLedgerFile('five_hour', startAt, startAt + 5 * HOUR);
    stale.samples.push([startAt, 1]);
    cache.put('five_hour', sessionName(0), stale);

    assert.strictEqual(cache.newest('five_hour')?.startAt, liveStart(2));
    assert.strictEqual(cache.drainPatch().changed.length, 1, 'announced all the same');
  });

  it('handles a kind with no files at all', async () => {
    const storage = new CountingStorage(root, logger);
    await storage.ensureLayout();
    const cache = new LedgerCache(storage);

    await cache.reload();

    assert.deepStrictEqual(storage.taken(), []);
    assert.strictEqual(cache.newest('seven_day'), undefined);
    assert.deepStrictEqual(cache.drainPatch(), { changed: [], removed: [] });
  });

  it('tracks each kind independently, each with its own live file', async () => {
    const storage = new CountingStorage(root, logger);
    const cache = await seeded(storage, 3);

    const weekStart = NOW - 3 * 24 * HOUR;
    const week = makeLedgerFile('seven_day', weekStart, weekStart + 7 * 24 * HOUR);
    week.samples.push([weekStart, 10, 5, 2]);
    await fs.writeFile(
      path.join(root, 'weeks', '2026-05-17T1200Z.json'),
      JSON.stringify(week),
      'utf8',
    );
    await cache.reload();

    assert.deepStrictEqual(storage.taken().sort(), [
      `five_hour/${sessionName(2)}`,
      'seven_day/2026-05-17T1200Z.json',
    ]);
    assert.strictEqual(cache.newest('seven_day')?.startAt, weekStart);
    assert.strictEqual(cache.newest('five_hour')?.startAt, liveStart(2));
  });
});
