// SPDX-License-Identifier: AGPL-3.0-only

import type { LedgerFile, Millis, Sample, SampleOutcome } from './types';

/**
 * A gap longer than this is only a dead zone if the utilization *also* moved.
 * Time alone never breaks the line — that is ordinary idleness.
 */
export const IDLE_GAP_MS = 10 * 60 * 1000;

/**
 * Fold one poll result into a ledger file, in place.
 *
 * The branch order below is the design, not an accident:
 *
 *  1. Unchanged values bookend, and they are checked *before* elapsed time. Eight
 *     hours asleep at a steady percentage yields two rows and an unbroken flat
 *     line, not a break.
 *  2. A run of identical values is stored as exactly two rows — an anchor that
 *     pins the left edge of the flat segment, and a bookend whose timestamp
 *     slides right. A third identical row is never written; without the anchor,
 *     sliding the only row would drag the step's rising edge forward as you idle.
 *  3. The break row sits one millisecond after the last *observed* sample, not
 *     adjacent to the new one, so the flat line stops where our knowledge
 *     actually stopped instead of spanning hours we never saw.
 *
 * A five-hour reset needs no case here: `resets_at` changes, the engine rolls to
 * a new file, and the drop renders as a segment boundary.
 */
export function applySample(
  file: LedgerFile,
  t: Millis,
  values: ReadonlyArray<number | null>,
): SampleOutcome {
  if (values.every((value) => value === null)) {
    // Recording this would be byte-identical to a dead-zone break row.
    return { kind: 'skipped' };
  }

  const samples = file.samples;
  const count = samples.length;

  if (count === 0) {
    samples.push(row(t, values));
    return { kind: 'anchor' };
  }

  const last = samples[count - 1];
  const matches = (candidate: Sample): boolean =>
    values.every((value, index) => candidate[index + 1] === value);

  // 1. Unchanged: extend the flat run rather than growing the file.
  if (matches(last)) {
    if (count >= 2 && matches(samples[count - 2])) {
      last[0] = t;
      return { kind: 'bookend' };
    }
    samples.push(row(t, values));
    return { kind: 'append' };
  }

  // 2. Changed *and* unobserved for a while: a real gap in our knowledge.
  if (t - last[0] > IDLE_GAP_MS) {
    samples.push(row(last[0] + 1, values.map(() => null)));
    samples.push(row(t, values));
    return { kind: 'gap+append' };
  }

  // 3. Changed while we were watching.
  samples.push(row(t, values));
  return { kind: 'append' };
}

function row(t: Millis, values: ReadonlyArray<number | null>): Sample {
  return [t, ...values] as Sample;
}
