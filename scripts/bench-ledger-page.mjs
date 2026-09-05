// What does loading ONE page cost, out of a decade-sized store?
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const OUT = process.argv[2] ?? 'out'; // compiled output; run `npm run compile` first
const { FileLedgerStorage } = await import(pathToFileURL(join(OUT, 'core/ledgerStorage.js')));
const { toFileName } = await import(pathToFileURL(join(OUT, 'core/fileNames.js')));

const logger = { info() {}, warn() {}, error() {} };
const DAY = 86_400_000;
const NOW = Date.now();
const DAYS = 3650;

function samples(startAt, count, cols) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push([startAt + i * 180_000, ...Array.from({ length: cols }, (_, c) => (i + c) % 100)]);
  }
  return rows;
}

const root = await mkdtemp(join(tmpdir(), 'cug-page-'));
const storage = new FileLedgerStorage(root, logger);
await storage.ensureLayout();

const sessionNames = [];
for (let d = 0; d < DAYS; d += 1) {
  for (let s = 0; s < 3; s += 1) {
    const startAt = NOW - (d + 1) * DAY + s * 6 * 3600_000;
    const name = toFileName(startAt);
    if (d === 1200) sessionNames.push(name); // an arbitrary day deep in history
    await writeFile(
      join(root, 'sessions', name),
      JSON.stringify({
        v: 1, kind: 'five_hour', startAt, resetAt: startAt + 5 * 3600_000,
        cols: ['five_hour'], samples: samples(startAt, 40, 1),
      }),
      'utf8',
    );
  }
}
let weekName = '';
for (let w = 0; w < Math.ceil(DAYS / 7); w += 1) {
  const startAt = NOW - (w + 1) * 7 * DAY;
  const name = toFileName(startAt);
  if (w === 170) weekName = name;
  await writeFile(
    join(root, 'weeks', name),
    JSON.stringify({
      v: 1, kind: 'seven_day', startAt, resetAt: startAt + 7 * DAY,
      cols: ['seven_day', 'seven_day_sonnet', 'seven_day_opus'], samples: samples(startAt, 400, 3),
    }),
    'utf8',
  );
}

async function time(label, run) {
  const samplesMs = [];
  for (let i = 0; i < 20; i += 1) {
    const t = performance.now();
    await run();
    samplesMs.push(performance.now() - t);
  }
  samplesMs.sort((a, b) => a - b);
  console.log(
    `${label.padEnd(34)} median ${samplesMs[10].toFixed(2).padStart(6)} ms   ` +
      `worst ${samplesMs[19].toFixed(2).padStart(6)} ms`,
  );
}

// A directory listing is what page resolution would cost without an index.
await time('list() one kind (11k files)', () => storage.list('five_hour'));
await time('a day page: 3 session files', async () => {
  for (const name of sessionNames) await storage.read('five_hour', name);
});
await time('a week page: 1 weekly file', () => storage.read('seven_day', weekName));

await rm(root, { recursive: true, force: true });
