// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { FIVE_HOUR_MS, WEEK_MS } from '../../core/windows';
import {
  Evictor,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  RETENTION_DAYS,
  RETENTION_MS,
  retentionMsFromDays,
} from '../../core/eviction';
import type { EvictorOptions } from '../../core/eviction';
import { LedgerCache } from '../../core/ledgerCache';
import { FileLedgerStorage } from '../../core/ledgerStorage';
import { toFileName } from '../../core/fileNames';
import { RecordingLogger, makeLedgerFile, makeTempDir, removeTempDir } from './helpers';
import type { LedgerKind } from '../../core/types';

const NOW = Date.UTC(2026, 2, 1, 12, 0);
const DAY = 86_400_000;

/**
 * Comfortably past the cutoff, expressed against the default rather than as a
 * count of days.
 *
 * A test that hardcodes "40 days is stale" is really asserting what the default
 * retention happens to be, and it fails the day that moves — which it has, from
 * 30 to 365. `STALE` and `EVEN_STALER` say what they mean instead: old enough to
 * go, and one file older still where a test needs two in order.
 */
const STALE = RETENTION_MS + 10 * DAY;
const EVEN_STALER = STALE + DAY;
const SPAN: Record<LedgerKind, number> = { five_hour: FIVE_HOUR_MS, seven_day: WEEK_MS };

describe('Evictor', () => {
  let root: string;
  let logger: RecordingLogger;
  let storage: FileLedgerStorage;
  let cache: LedgerCache;

  beforeEach(async () => {
    root = await makeTempDir();
    logger = new RecordingLogger();
    storage = new FileLedgerStorage(root, logger);
    cache = new LedgerCache(storage);
    await storage.ensureLayout();
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  /** Seed a file whose window opened at `at` and closes a real span later. */
  async function seedAt(kind: LedgerKind, at: number): Promise<string> {
    const name = toFileName(at);
    await storage.commit(kind, name, () => makeLedgerFile(kind, at, at + SPAN[kind]), (file) => {
      file.samples.push([at, 1]);
    });
    return name;
  }

  /**
   * Build an evictor the way `UsageEngine.start` does: load, then construct.
   *
   * The reload is kept in that order because the engine does it, not because
   * eviction needs it — candidates come from the listing and `resetAt` from each
   * file's own header. What it does buy is a populated live slot, which is what
   * makes "the file being evicted is the one the cache holds" reachable here.
   */
  async function build(
    now = NOW,
    retentionMs?: number,
    options?: EvictorOptions,
  ): Promise<Evictor> {
    await cache.reload();
    return new Evictor(storage, cache, now, logger, retentionMs, options);
  }

  /** One pass, which is all a handful of files ever needs. */
  async function evict(now = NOW, retentionMs?: number): Promise<number> {
    return (await build(now, retentionMs)).sweep();
  }

  /**
   * A budget that expires the instant it is looked at, so every pass stops
   * after exactly one file.
   *
   * Fake rather than real elapsed time: a test that leaned on a 1 ms budget and
   * a real clock would pass or fail on how busy the machine is.
   */
  function oneFilePerPass(): EvictorOptions {
    let calls = 0;
    return { budgetMs: 1, monotonic: () => calls++ };
  }

  it('drops files whose window closed before the cutoff and keeps the rest', async () => {
    const stale = await seedAt('five_hour', NOW - STALE);
    const fresh = await seedAt('five_hour', NOW - 2 * DAY);

    assert.strictEqual(await evict(), 1);
    const remaining = await storage.list('five_hour');
    assert.deepStrictEqual(remaining, [fresh]);
    assert.ok(!remaining.includes(stale));
  });

  // The cache holds the live window and nothing else, so it cannot diff a
  // listing to work out what went — the files eviction deletes are precisely the
  // ones it never held. Unannounced, a removal reaches no panel at all.
  it('announces every removal, because nothing else can', async () => {
    const stale = NOW - STALE;
    await seedAt('five_hour', stale);
    await seedAt('seven_day', stale);
    await seedAt('five_hour', NOW - 2 * DAY);
    cache.drainPatch();

    assert.strictEqual(await evict(), 2);

    const patch = cache.drainPatch();
    assert.deepStrictEqual(
      patch.removed.sort((a, b) => a.kind.localeCompare(b.kind)),
      [
        { kind: 'five_hour', startAt: stale },
        { kind: 'seven_day', startAt: stale },
      ],
      'a panel must not be left drawing files that are gone',
    );
  });

  // The rollover case: eviction can reach the file the cache is holding as live
  // if a window has sat idle past the whole retention span. It must let go of
  // it, or `meta` would keep reporting a boundary off a file that is deleted.
  it('clears the live slot when the file it holds is the one evicted', async () => {
    await seedAt('five_hour', NOW - STALE);
    await cache.reload();
    assert.ok(cache.newest('five_hour') !== undefined, 'precondition: it is held');

    await (await build()).sweep();

    assert.strictEqual(cache.newest('five_hour'), undefined);
  });

  // Retention is measured from `resetAt` — the boundary the API reported — not
  // from the name, which records when the window opened.
  it('keeps a file whose window closes exactly on the boundary', async () => {
    const boundary = await seedAt('five_hour', NOW - RETENTION_MS - FIVE_HOUR_MS);

    assert.strictEqual(await evict(), 0, 'the boundary is inclusive — do not drop it');
    assert.deepStrictEqual(await storage.list('five_hour'), [boundary]);
  });

  it('drops a file whose window closed one minute past the boundary', async () => {
    await seedAt('five_hour', NOW - RETENTION_MS - FIVE_HOUR_MS - 60_000);
    assert.strictEqual(await evict(), 1);
  });

  // The case that makes reading `resetAt` matter. A weekly file is named for
  // the start of its cycle, so the one being written to right now looks up to
  // seven days old by name while holding this morning's samples.
  it('never evicts the cycle in progress, however short the retention', async () => {
    const thisWeek = await seedAt('seven_day', NOW - 6 * DAY);
    const thisSession = await seedAt('five_hour', NOW - 4 * 3600_000);

    assert.strictEqual(await evict(NOW, DAY), 0, 'both windows are still collecting');
    assert.deepStrictEqual(await storage.list('seven_day'), [thisWeek]);
    assert.deepStrictEqual(await storage.list('five_hour'), [thisSession]);
  });

  it('keeps a week whose name is past the cutoff but whose data is not', async () => {
    const straddling = await seedAt('seven_day', NOW - RETENTION_MS - 2 * DAY);
    await seedAt('seven_day', NOW - RETENTION_MS - 8 * DAY);

    assert.strictEqual(await evict(), 1);
    assert.deepStrictEqual(await storage.list('seven_day'), [straddling]);
  });

  it('sweeps both sessions and weeks', async () => {
    await seedAt('five_hour', NOW - STALE);
    await seedAt('seven_day', NOW - STALE);
    await seedAt('seven_day', NOW - DAY);

    assert.strictEqual(await evict(), 2);
    assert.strictEqual((await storage.list('five_hour')).length, 0);
    assert.strictEqual((await storage.list('seven_day')).length, 1);
  });

  // A damaged file is set aside under a name `list` cannot see, so this sweep is
  // the only thing that will ever clear it. Before it existed they accumulated
  // for the life of the install.
  it('deletes a quarantined file once it is past the cutoff', async () => {
    const stale = `${toFileName(NOW)}.corrupt-${NOW - STALE}`;
    await fs.writeFile(path.join(root, 'sessions', stale), 'wreckage', 'utf8');

    await evict();

    assert.deepStrictEqual(await fs.readdir(path.join(root, 'sessions')), []);
  });

  it('keeps a recently quarantined file, so it can still be recovered by hand', async () => {
    const recent = `${toFileName(NOW)}.corrupt-${NOW - DAY}`;
    await fs.writeFile(path.join(root, 'sessions', recent), 'wreckage', 'utf8');

    await evict();

    assert.deepStrictEqual(await fs.readdir(path.join(root, 'sessions')), [recent]);
  });

  it('quarantines a corrupt file rather than deleting it on first sight', async () => {
    const name = toFileName(NOW - STALE);
    await fs.writeFile(path.join(root, 'sessions', name), 'not json at all', 'utf8');

    await evict();

    const left = await fs.readdir(path.join(root, 'sessions'));
    assert.strictEqual(left.length, 1, 'set aside for recovery, not destroyed');
    assert.ok(left[0].includes('.corrupt-'), left[0]);
    assert.strictEqual(logger.errors.length, 1, 'and it says so');
  });

  it('leaves a corrupt but recent file where it can be found', async () => {
    const name = toFileName(NOW - DAY);
    await fs.writeFile(path.join(root, 'sessions', name), 'not json at all', 'utf8');

    await evict();

    const left = await fs.readdir(path.join(root, 'sessions'));
    assert.strictEqual(left.length, 1);
    assert.ok(left[0].includes('.corrupt-'));
  });

  it('ignores files that are not ours', async () => {
    await fs.writeFile(path.join(root, 'sessions', 'README.txt'), 'x', 'utf8');

    assert.strictEqual(await evict(), 0);
    assert.deepStrictEqual(await fs.readdir(path.join(root, 'sessions')), ['README.txt']);
  });

  it('does nothing on an empty store', async () => {
    assert.strictEqual(await evict(), 0);
  });

  // Why the budget exists: lowering `retentionDays` from 365 to 30 with a year
  // of history is ~1,100 unlinks — 0.16 s here, and 33 s on a redirected
  // storage root over SMB.
  it('stops when the budget runs out and resumes on the next pass', async () => {
    for (const extra of [0, 1, 2]) {
      await seedAt('five_hour', NOW - STALE - extra * DAY);
    }
    const evictor = await build(NOW, undefined, oneFilePerPass());

    assert.strictEqual(await evictor.sweep(), 1);
    assert.strictEqual((await storage.list('five_hour')).length, 2);
    assert.ok(evictor.pending, 'there is more to do, and the next tick has to know it');

    assert.strictEqual(await evictor.sweep(), 1);
    assert.strictEqual(await evictor.sweep(), 1);
    assert.strictEqual((await storage.list('five_hour')).length, 0);

    // The budget is checked *after* a removal, so the pass that takes the last
    // file still ends on a spent one. The pass that finds nothing left is what
    // closes it out — and after that it costs a boolean per tick and no I/O.
    assert.ok(evictor.pending);
    assert.strictEqual(await evictor.sweep(), 0);
    assert.ok(!evictor.pending);
  });

  it('takes at least one file however small the budget', async () => {
    await seedAt('five_hour', NOW - STALE);
    await seedAt('five_hour', NOW - EVEN_STALER);
    const evictor = await build(NOW, undefined, { budgetMs: 0, monotonic: () => 0 });

    assert.strictEqual(await evictor.sweep(), 1, 'a budget that can delete nothing never drains');
  });

  it('leaves quarantined files to the pass that finishes', async () => {
    const stale = `${toFileName(NOW)}.corrupt-${NOW - STALE}`;
    await fs.writeFile(path.join(root, 'sessions', stale), 'wreckage', 'utf8');
    await seedAt('five_hour', NOW - STALE);
    await seedAt('five_hour', NOW - EVEN_STALER);
    const evictor = await build(NOW, undefined, oneFilePerPass());

    await evictor.sweep();
    const midway = await fs.readdir(path.join(root, 'sessions'));
    assert.ok(midway.includes(stale), 'a directory scan is not worth repeating per pass');

    while (evictor.pending) {
      await evictor.sweep();
    }
    assert.deepStrictEqual(await fs.readdir(path.join(root, 'sessions')), []);
  });

  // A window closing mid-sweep. The unfinished half is not persisted and does
  // not need to be: the next startup recomputes exactly the same work.
  it('stops deleting once cancelled', async () => {
    await seedAt('five_hour', NOW - STALE);
    const evictor = await build(NOW);
    evictor.cancel();

    assert.strictEqual(await evictor.sweep(), 0);
    assert.strictEqual((await storage.list('five_hour')).length, 1);
    assert.ok(!evictor.pending, 'and it is not asked again');
  });

  // The cutoff is captured once, at construction. A resumed pass that re-read
  // the setting would turn "a lowered retention takes effect at the next
  // window" into "history disappears under the running one".
  it('never widens the cutoff it was built with', async () => {
    await seedAt('five_hour', NOW - STALE);
    const young = await seedAt('five_hour', NOW - RETENTION_MS - FIVE_HOUR_MS + 30 * 60_000);
    const evictor = await build(NOW, undefined, oneFilePerPass());

    while (evictor.pending) {
      await evictor.sweep();
    }

    assert.deepStrictEqual(await storage.list('five_hour'), [young], 'alive when the pass began');
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe('retentionMsFromDays', () => {
  it('turns a setting into a cutoff', () => {
    assert.strictEqual(retentionMsFromDays(90), 90 * DAY_MS);
  });

  // A floor only against nonsense. It does not have to protect the window in
  // progress: `Evictor` ages a file by when its data stops, so even a
  // one-day retention keeps the week and the session still being written to.
  it('never lets the window reach zero', () => {
    assert.strictEqual(retentionMsFromDays(0), MIN_RETENTION_DAYS * DAY_MS);
    assert.strictEqual(retentionMsFromDays(-30), MIN_RETENTION_DAYS * DAY_MS);
  });

  it('caps a value at what the navigation controls can cross', () => {
    assert.strictEqual(retentionMsFromDays(1e9), MAX_RETENTION_DAYS * DAY_MS);
  });

  // `package.json` declares a minimum, but that only drives the settings UI —
  // a hand-edited settings.json or a synced profile can still deliver anything.
  it('falls back to the default for a value that is not a number', () => {
    for (const value of [undefined, null, 'thirty', Number.NaN, {}]) {
      assert.strictEqual(retentionMsFromDays(value), RETENTION_MS, String(value));
    }
  });

  it('takes whole days rather than a fraction of one', () => {
    assert.strictEqual(retentionMsFromDays(30.9), 30 * DAY_MS);
  });
});

/**
 * The setting and the constants are one fact written in two files, and only one
 * of them is type-checked.
 *
 * `package.json` is what the user sees and what supplies the value when nothing
 * is configured; the constants are what the code clamps and falls back to. Drift
 * shows up as a settings UI that offers a range the code refuses, or a default
 * the description does not match — neither of which anything else would catch.
 */
describe('retentionDays contribution', () => {
  const declared = JSON.parse(
    fsSync.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
  ).contributes.configuration.properties['claudeUsageGraph.retentionDays'];

  it('declares the same default the code falls back to', () => {
    assert.strictEqual(declared.default, RETENTION_DAYS);
  });

  it('declares the same bounds the code clamps to', () => {
    assert.strictEqual(declared.minimum, MIN_RETENTION_DAYS);
    assert.strictEqual(declared.maximum, MAX_RETENTION_DAYS);
  });
});
