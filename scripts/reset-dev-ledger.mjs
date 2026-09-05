// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Empties one development host's ledger. Usage:
 *
 *   node scripts/reset-dev-ledger.mjs .vscode-screenshot-host
 *   node scripts/reset-dev-ledger.mjs .vscode-test-host
 *
 * Why every dev launch needs this. Both replay fixtures are anchored to *local
 * midnight of the previous day*, so the same file describes a different span of
 * wall-clock time depending on when it runs — and the screenshot fixture is
 * regenerated against the clock on every launch besides. The ledger, though, is
 * a ledger: it survives between launches and faithfully records whatever it is
 * replayed. Two launches on different days therefore layer two histories into
 * data no real account could ever report:
 *
 *   - overlapping weekly cycles, drawn as two lines over the same hours with
 *     only one of them owning the hover targets;
 *   - "weekly" resets a day apart rather than a week — one per launch day;
 *   - reset walls stranded mid-line, because the wall belongs to one
 *     generation's session and the line beneath it to another's;
 *   - a line restarting at zero with no boundary in front of it.
 *
 * None of that is a charting bug. `selectCalendarWeek` draws every file
 * overlapping the frame, which is correct while cycles cannot overlap, and real
 * ones cannot. The fix is to stop manufacturing impossible input.
 * `ScenarioRunner.load` already wipes for this reason on every scenario switch;
 * this is the same wipe, applied to the launch itself.
 *
 * Deliberately narrow: the target must be a `.vscode-*-host` directory directly
 * inside the repository, and only `sessions/`, `weeks/` and the poll lease are
 * removed. The real ledger lives under `globalStorageUri` and is unreachable
 * from here.
 */

import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything the extension writes under a `CUG_STORAGE_ROOT`. */
const TARGETS = ['sessions', 'weeks', 'poll.lease'];

const requested = process.argv[2];
if (requested === undefined) {
  console.error('Usage: node scripts/reset-dev-ledger.mjs <.vscode-*-host>');
  process.exit(1);
}

// A path guard rather than trust: this script deletes directories, and the one
// mistake worth making impossible is pointing it at a real ledger.
if (!/^\.vscode-[a-z-]+-host$/.test(requested)) {
  console.error(
    `Refusing to clear "${requested}": only a .vscode-<name>-host directory in the repository root can be cleared.`,
  );
  process.exit(1);
}

const root = join(REPO, requested);

if (!existsSync(root)) {
  console.log(`Ledger already absent (${requested})`);
  process.exit(0);
}

const removed = [];
for (const target of TARGETS) {
  const path = join(root, target);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    removed.push(target);
  }
}

console.log(
  removed.length === 0
    ? `Ledger was already empty (${requested})`
    : `Cleared ${requested}: ${removed.join(', ')}`,
);
