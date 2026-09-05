// Throwaway: how long does LedgerCache.reload() actually take at N days?
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const OUT = process.argv[2] ?? 'out'; // compiled output; run `npm run compile` first
const { FileLedgerStorage } = await import(pathToFileURL(join(OUT, 'core/ledgerStorage.js')));
const { LedgerCache } = await import(pathToFileURL(join(OUT, 'core/ledgerCache.js')));
const { toFileName } = await import(pathToFileURL(join(OUT, 'core/fileNames.js')));

const logger = { info() {}, warn() {}, error() {} };
const DAY = 86_400_000;
const NOW = Date.now();

/** A plausible file: a session polled every 3 min for 5h, bookended down. */
function samples(startAt, count, cols) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push([startAt + i * 180_000, ...Array.from({ length: cols }, (_, c) => (i + c) % 100)]);
  }
  return rows;
}

async function seed(root, days) {
  const storage = new FileLedgerStorage(root, logger);
  await storage.ensureLayout();
  let bytes = 0;

  // ~3 sessions a day, each ~40 rows after bookending.
  for (let d = 0; d < days; d += 1) {
    for (let s = 0; s < 3; s += 1) {
      const startAt = NOW - (d + 1) * DAY + s * 6 * 3600_000;
      const file = {
        v: 1, kind: 'five_hour', startAt, resetAt: startAt + 5 * 3600_000,
        cols: ['five_hour'], samples: samples(startAt, 40, 1),
      };
      const body = JSON.stringify(file);
      bytes += body.length;
      await writeFile(join(root, 'sessions', toFileName(startAt)), body, 'utf8');
    }
  }
  // One weekly file per 7 days, ~400 rows x 3 columns.
  for (let w = 0; w < Math.ceil(days / 7); w += 1) {
    const startAt = NOW - (w + 1) * 7 * DAY;
    const file = {
      v: 1, kind: 'seven_day', startAt, resetAt: startAt + 7 * DAY,
      cols: ['seven_day', 'seven_day_sonnet', 'seven_day_opus'], samples: samples(startAt, 400, 3),
    };
    const body = JSON.stringify(file);
    bytes += body.length;
    await writeFile(join(root, 'weeks', toFileName(startAt)), body, 'utf8');
  }
  return { storage, bytes };
}

for (const days of [30, 90, 365, 3650]) {
  const root = await mkdtemp(join(tmpdir(), 'cug-bench-'));
  const { storage, bytes } = await seed(root, days);
  const cache = new LedgerCache(storage);

  const cold = performance.now();
  await cache.reload();
  const coldMs = performance.now() - cold;

  cache.drainPatch();
  const warm = performance.now();
  await cache.reload();
  const warmMs = performance.now() - warm;

  const files = cache.entries('five_hour').length + cache.entries('seven_day').length;
  const snap = performance.now();
  const payload = JSON.stringify(cache.snapshot()).length;
  const snapMs = performance.now() - snap;

  console.log(
    `${String(days).padStart(4)}d  ${String(files).padStart(6)} files  ` +
      `${(bytes / 1e6).toFixed(1).padStart(5)} MB on disk  |  ` +
      `first reload ${coldMs.toFixed(0).padStart(6)} ms  ` +
      `follower reload ${warmMs.toFixed(0).padStart(6)} ms  ` +
      `hydrate payload ${(payload / 1e6).toFixed(1).padStart(5)} MB (${snapMs.toFixed(0)} ms)`,
  );

  await rm(root, { recursive: true, force: true });
}
