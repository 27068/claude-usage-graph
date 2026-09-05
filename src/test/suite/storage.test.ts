// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileLedgerStorage } from '../../core/ledgerStorage';
import { isLedgerFileName, toFileName } from '../../core/fileNames';
import { RecordingLogger, makeLedgerFile, makeTempDir, removeTempDir } from './helpers';

const T0 = Date.UTC(2026, 1, 6, 17, 0);
const NAME = toFileName(T0);

describe('fileNames', () => {
  it('encodes an instant as a UTC basic-format name, truncated to the minute', () => {
    assert.strictEqual(toFileName(T0), '2026-02-06T1700Z.json');
    assert.strictEqual(toFileName(T0 + 59_000), '2026-02-06T1700Z.json', 'seconds are dropped');
  });

  // The property everything downstream leans on: `list` returns a plain
  // lexicographic sort and treats it as chronological. Asserted by generating
  // names out of order and checking the sort agrees with the instants that
  // produced them — no decoder needed, and none exists.
  it('sorts lexicographically into chronological order', () => {
    const instants = [
      Date.UTC(2026, 11, 31, 23, 59),
      Date.UTC(2026, 0, 1, 0, 0),
      Date.UTC(2026, 5, 15, 12, 30),
      Date.UTC(2025, 9, 8, 7, 6),
    ];
    const chronological = [...instants].sort((a, b) => a - b).map(toFileName);

    assert.deepStrictEqual([...chronological].sort(), chronological);
  });

  it('recognises our files and nothing else', () => {
    assert.ok(isLedgerFileName(NAME));
    for (const name of [
      'poll.lease',
      'meta.json',
      'nope.json',
      '2026-02-06T1700Z.json.tmp',
      '2026-02-06T1700Z.json.corrupt-123',
      '2026-02-06T170Z.json',
    ]) {
      assert.strictEqual(isLedgerFileName(name), false, `${name} should not be ours`);
    }
  });
});

describe('FileLedgerStorage', () => {
  let root: string;
  let logger: RecordingLogger;
  let storage: FileLedgerStorage;

  beforeEach(async () => {
    root = await makeTempDir();
    logger = new RecordingLogger();
    storage = new FileLedgerStorage(root, logger);
    await storage.ensureLayout();
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  it('returns undefined for a file that does not exist', async () => {
    assert.strictEqual(await storage.read('five_hour', NAME), undefined);
  });

  // Where paging backwards stops. The instant comes from the header, never from
  // the name — the listing only chooses which file to open.
  describe('oldest', () => {
    const HOUR = 3600_000;

    async function seed(at: number): Promise<void> {
      await storage.commit(
        'five_hour',
        toFileName(at),
        () => makeLedgerFile('five_hour', at, at + 5 * HOUR),
        (file) => {
          file.samples.push([at, 1]);
        },
      );
    }

    it('is undefined when the kind holds nothing', async () => {
      assert.strictEqual(await storage.oldest('five_hour'), undefined);
    });

    it('takes the first name, whatever order the files were written in', async () => {
      await seed(T0);
      await seed(T0 - 3 * 24 * HOUR);
      await seed(T0 + 24 * HOUR);

      const first = await storage.oldest('five_hour');
      assert.strictEqual(first?.startAt, T0 - 3 * 24 * HOUR);
    });

    it('keeps each kind to its own edge', async () => {
      await seed(T0);
      assert.strictEqual(await storage.oldest('seven_day'), undefined);
    });

    // It walks forward rather than giving up on `names[0]`: a file can be
    // quarantined by the very read that looks at it, and the clamp must then be
    // the oldest file that is actually readable.
    it('steps past a damaged file to the oldest one that reads', async () => {
      const damaged = T0 - 5 * 24 * HOUR;
      await fs.writeFile(path.join(root, 'sessions', toFileName(damaged)), 'wreckage', 'utf8');
      await seed(T0);

      const first = await storage.oldest('five_hour');
      assert.strictEqual(first?.startAt, T0);
      assert.strictEqual(logger.errors.length, 1, 'and the damaged one is quarantined');
    });
  });

  it('lists nothing before anything is written', async () => {
    assert.deepStrictEqual(await storage.list('five_hour'), []);
    assert.deepStrictEqual(await storage.list('seven_day'), []);
  });

  it('round-trips a file through commit and read', async () => {
    await storage.commit(
      'five_hour',
      NAME,
      () => makeLedgerFile('five_hour', T0, T0 + 5 * 3600_000),
      (file) => {
        file.samples.push([T0, 4]);
      },
    );

    const loaded = await storage.read('five_hour', NAME);
    assert.ok(loaded);
    assert.strictEqual(loaded.kind, 'five_hour');
    assert.strictEqual(loaded.startAt, T0);
    assert.deepStrictEqual(loaded.samples, [[T0, 4]]);
  });

  it('seeds only once, then mutates the existing file', async () => {
    let seeded = 0;
    const seed = () => {
      seeded += 1;
      return makeLedgerFile('five_hour', T0, T0 + 5 * 3600_000);
    };

    for (let i = 0; i < 3; i += 1) {
      await storage.commit('five_hour', NAME, seed, (file) => {
        file.samples.push([T0 + i, i]);
      });
    }

    assert.strictEqual(seeded, 1, 'seed must not run once the file exists');
    const loaded = await storage.read('five_hour', NAME);
    assert.strictEqual(loaded?.samples.length, 3);
  });

  it('keeps every concurrent commit to one path — none lost', async () => {
    const seed = () => makeLedgerFile('five_hour', T0, T0 + 5 * 3600_000);

    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        storage.commit('five_hour', NAME, seed, (file) => {
          file.samples.push([T0 + index, index]);
        }),
      ),
    );

    const loaded = await storage.read('five_hour', NAME);
    assert.strictEqual(loaded?.samples.length, 10, 'a concurrent write was clobbered');
    const values = loaded.samples.map((sample) => sample[1]).sort((a, b) => Number(a) - Number(b));
    assert.deepStrictEqual(values, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('leaves no temp files behind', async () => {
    await storage.commit(
      'five_hour',
      NAME,
      () => makeLedgerFile('five_hour', T0, T0 + 5 * 3600_000),
      (file) => file.samples.push([T0, 1]),
    );

    const entries = await fs.readdir(path.join(root, 'sessions'));
    assert.deepStrictEqual(entries, [NAME]);
  });

  it('keeps the two kinds in separate directories', async () => {
    await storage.commit(
      'five_hour',
      NAME,
      () => makeLedgerFile('five_hour', T0, T0 + 5 * 3600_000),
      (file) => file.samples.push([T0, 1]),
    );
    await storage.commit(
      'seven_day',
      NAME,
      () => makeLedgerFile('seven_day', T0, T0 + 7 * 86_400_000),
      (file) => file.samples.push([T0, 1, null, null, null]),
    );

    assert.deepStrictEqual(await storage.list('five_hour'), [NAME]);
    assert.deepStrictEqual(await storage.list('seven_day'), [NAME]);
  });

  it('ignores foreign files when listing', async () => {
    await fs.writeFile(path.join(root, 'sessions', 'notes.txt'), 'hello', 'utf8');
    await fs.writeFile(path.join(root, 'sessions', 'meta.json'), '{}', 'utf8');
    assert.deepStrictEqual(await storage.list('five_hour'), []);
  });

  it('quarantines a corrupt file instead of throwing', async () => {
    const target = path.join(root, 'sessions', NAME);
    await fs.writeFile(target, '{ this is not json', 'utf8');

    const loaded = await storage.read('five_hour', NAME);
    assert.strictEqual(loaded, undefined, 'a corrupt file must read as absent');
    assert.ok(logger.errors.length > 0, 'the corruption should be logged');

    const entries = await fs.readdir(path.join(root, 'sessions'));
    assert.ok(
      entries.some((name) => name.startsWith(`${NAME}.corrupt-`)),
      'the damaged file should be kept for recovery',
    );
  });

  it('quarantines a file whose shape is wrong even if the JSON parses', async () => {
    await fs.writeFile(path.join(root, 'sessions', NAME), '{"hello":"world"}', 'utf8');
    assert.strictEqual(await storage.read('five_hour', NAME), undefined);
  });

  it('recovers by reseeding after a corrupt file is quarantined', async () => {
    await fs.writeFile(path.join(root, 'sessions', NAME), 'garbage', 'utf8');

    const result = await storage.commit(
      'five_hour',
      NAME,
      () => makeLedgerFile('five_hour', T0, T0 + 5 * 3600_000),
      (file) => file.samples.push([T0, 42]),
    );

    assert.deepStrictEqual(result.samples, [[T0, 42]]);
    assert.deepStrictEqual((await storage.read('five_hour', NAME))?.samples, [[T0, 42]]);
  });

  it('removes a file and tolerates removing one twice', async () => {
    await storage.commit(
      'five_hour',
      NAME,
      () => makeLedgerFile('five_hour', T0, T0 + 5 * 3600_000),
      (file) => file.samples.push([T0, 1]),
    );

    await storage.remove('five_hour', NAME);
    await storage.remove('five_hour', NAME);
    assert.deepStrictEqual(await storage.list('five_hour'), []);
  });

  describe('readRange', () => {
    const HOUR = 3600_000;

    /** A session that opened at `at` and closed five hours later. */
    async function seed(at: number): Promise<string> {
      const name = toFileName(at);
      await storage.commit(
        'five_hour',
        name,
        () => makeLedgerFile('five_hour', at, at + 5 * HOUR),
        (file) => file.samples.push([at, 1]),
      );
      return name;
    }

    it('returns the files that started in the range, in order', async () => {
      await seed(T0);
      await seed(T0 + HOUR);
      await seed(T0 + 2 * HOUR);

      const page = await storage.readRange('five_hour', T0, T0 + 2 * HOUR);
      assert.deepStrictEqual(
        page.map((file) => file.startAt),
        [T0, T0 + HOUR],
        'the upper end is exclusive',
      );
    });

    // The half that makes the residual slack harmless. This file is named in the
    // minute the range begins in, so the bound has to open it — a name fixes the
    // minute a window started in and not the second, so it could have started
    // either side of 17:00:30. Its header says it started before, so out it
    // goes.
    it('drops a file the bound reached but the header rules out', async () => {
      const before = await seed(T0 + 10_000);
      await seed(T0 + HOUR);

      const page = await storage.readRange('five_hour', T0 + 30_000, T0 + 2 * HOUR);
      assert.deepStrictEqual(page.map((file) => file.startAt), [T0 + HOUR]);
      assert.ok(await storage.read('five_hour', before), 'read, not deleted');
    });

    // And the case the widening exists for: named a minute early by truncation,
    // but genuinely inside the range.
    it('keeps a file named before the range that started inside it', async () => {
      await seed(T0 + 30_000);

      const page = await storage.readRange('five_hour', T0 + 20_000, T0 + HOUR);
      assert.deepStrictEqual(page.map((file) => file.startAt), [T0 + 30_000]);
    });

    it('is empty for a range with nothing in it, and for an empty store', async () => {
      assert.deepStrictEqual(await storage.readRange('five_hour', T0, T0 + HOUR), []);
      await seed(T0);
      assert.deepStrictEqual(await storage.readRange('five_hour', T0 + 8 * HOUR, T0 + 9 * HOUR), []);
      assert.deepStrictEqual(await storage.readRange('seven_day', T0, T0 + HOUR), []);
    });

    it('takes the window that straddles the start, which starts before it', async () => {
      await seed(T0 - 4 * HOUR);
      await seed(T0 + HOUR);

      const overlapping = await storage.readOverlapping('five_hour', T0, T0 + 2 * HOUR);
      assert.deepStrictEqual(
        overlapping.map((file) => file.startAt),
        [T0 - 4 * HOUR, T0 + HOUR],
        'it was still open at T0, so the frame draws it',
      );
      assert.deepStrictEqual(
        (await storage.readRange('five_hour', T0, T0 + 2 * HOUR)).map((file) => file.startAt),
        [T0 + HOUR],
        'and the start-range query is right to leave it out',
      );
    });

    it('leaves out a window that closed before the range began', async () => {
      await seed(T0 - 6 * HOUR);
      const page = await storage.readOverlapping('five_hour', T0, T0 + 2 * HOUR);
      assert.deepStrictEqual(page, [], 'it reset an hour before the frame opens');
    });

    // The calendar draws a wall wherever the API reported a reset, so a cycle
    // ending exactly on the frame's left edge has to come back — losing it would
    // silently drop a boundary that was actually observed.
    it('keeps a window whose reset lands exactly on the range start', async () => {
      await seed(T0 - 5 * HOUR);
      const page = await storage.readOverlapping('five_hour', T0, T0 + 2 * HOUR);
      assert.deepStrictEqual(page.map((file) => file.resetAt), [T0]);
    });

    it('skips a damaged file rather than failing the page', async () => {
      await fs.writeFile(path.join(root, 'sessions', toFileName(T0)), 'wreckage', 'utf8');
      await seed(T0 + HOUR);

      const page = await storage.readRange('five_hour', T0, T0 + 2 * HOUR);
      assert.deepStrictEqual(page.map((file) => file.startAt), [T0 + HOUR]);
      assert.strictEqual(logger.errors.length, 1, 'quarantined, and said so');
    });
  });
});
