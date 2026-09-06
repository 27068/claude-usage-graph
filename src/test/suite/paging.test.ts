// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { FileLedgerStorage } from '../../core/ledgerStorage';
import { toFileName } from '../../core/fileNames';
import {
  calendarFrameRange,
  poolDayRange,
  selectCalendarWeek,
  selectPoolDay,
} from '../../core/selectors';
import { addLocalDays, startOfLocalDay } from '../../core/sessions';
import { FIVE_HOUR_MS, WEEK_MS } from '../../core/windows';
import { RecordingLogger, makeLedgerFile, makeTempDir, removeTempDir } from './helpers';
import type { LedgerFile, LedgerKind } from '../../core/types';

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 4, 20, 14, 30);

/**
 * The page the client fetches must contain everything the chart draws.
 *
 * These are the tests that hold the two halves of paging together. The client
 * computes a range with `poolDayRange` / `calendarFrameRange` and asks the host
 * for it; the host resolves that range through the name bounds and reads what it
 * finds; the selectors then draw whatever came back. Nothing in that chain
 * checks itself — a bound that is one file short produces a chart that is
 * *plausible*, with a line that stops early or a reset wall missing, and no
 * error anywhere.
 *
 * So each case asserts the strongest available property: the view rendered from
 * one page is identical to the view rendered from the entire ledger.
 */
describe('paging', () => {
  let root: string;
  let storage: FileLedgerStorage;
  let sessions: LedgerFile[];
  let weeks: LedgerFile[];

  /** Seed a window and return it, with samples every half hour. */
  async function seed(kind: LedgerKind, startAt: number, span: number): Promise<LedgerFile> {
    return storage.commit(
      kind,
      toFileName(startAt),
      () => makeLedgerFile(kind, startAt, startAt + span),
      (file) => {
        for (let at = startAt; at < startAt + span; at += 30 * 60_000) {
          file.samples.push([at, Math.round((at - startAt) / span * 100)]);
        }
      },
    );
  }

  beforeEach(async () => {
    root = await makeTempDir();
    storage = new FileLedgerStorage(root, new RecordingLogger());
    await storage.ensureLayout();

    sessions = [];
    weeks = [];

    // Five days of sessions at deliberately awkward instants: seconds on the
    // clock, so nothing lines up with a filename; one starting at 23:58 local,
    // which runs past midnight into the next day and must stay on the day it
    // began; and one at 00:00:29, which shares a name with midnight itself.
    const midnight = startOfLocalDay(NOW);
    for (let back = 0; back < 5; back += 1) {
      const day = startOfLocalDay(addLocalDays(midnight, -back));
      sessions.push(await seed('five_hour', day + 9 * HOUR + 17_000, FIVE_HOUR_MS));
      sessions.push(await seed('five_hour', day + 15 * HOUR + 3_000, FIVE_HOUR_MS));
      sessions.push(await seed('five_hour', day + 23 * HOUR + 58 * 60_000, FIVE_HOUR_MS));
      sessions.push(await seed('five_hour', day + 29_000, FIVE_HOUR_MS));
    }

    // Four consecutive cycles, phase-aligned to the newest, so the frames the
    // calendar pages through line up with real file boundaries.
    const newestReset = NOW + 2 * 24 * HOUR;
    for (let back = 0; back < 4; back += 1) {
      weeks.push(await seed('seven_day', newestReset - (back + 1) * WEEK_MS, WEEK_MS));
    }
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  /** What the client holds: the page it asked for, plus the live window. */
  function held(page: LedgerFile[], live: LedgerFile | undefined): LedgerFile[] {
    const merged = new Map(page.map((file) => [file.startAt, file]));
    if (live !== undefined) {
      merged.set(live.startAt, live);
    }
    return [...merged.values()];
  }

  it('draws the same day from one page as from the whole ledger', async () => {
    const live = sessions.reduce((a, b) => (a.resetAt > b.resetAt ? a : b));

    for (let offset = 0; offset < 5; offset += 1) {
      const [from, to] = poolDayRange(NOW, offset);
      const page = await storage.readRange('five_hour', from, to);

      assert.deepStrictEqual(
        selectPoolDay(held(page, live), NOW, NOW, offset),
        selectPoolDay(sessions, NOW, NOW, offset),
        `pool page ${offset}`,
      );
    }
  });

  it('draws the same cycle from one page as from the whole ledger', async () => {
    const live = weeks.reduce((a, b) => (a.resetAt > b.resetAt ? a : b));

    for (let offset = 0; offset < 4; offset += 1) {
      const [from, to] = calendarFrameRange(live.resetAt, NOW, offset);
      const page = await storage.readOverlapping('seven_day', from, to);

      assert.deepStrictEqual(
        selectCalendarWeek(held(page, live), NOW, offset),
        selectCalendarWeek(weeks, NOW, offset),
        `calendar page ${offset}`,
      );
    }
  });

  // A cycle is longer than the frame that shows it, so both edge files begin
  // outside the range. `readRange` would return neither and the chart would be
  // blank in the middle of a week that has data — which is why the calendar asks
  // a different question of the same listing.
  it('needs the overlap query, not the start-range one, for a cycle', async () => {
    const live = weeks.reduce((a, b) => (a.resetAt > b.resetAt ? a : b));
    const [from, to] = calendarFrameRange(live.resetAt, NOW, 2);

    const overlapping = await storage.readOverlapping('seven_day', from, to);
    const startingIn = await storage.readRange('seven_day', from, to);

    assert.ok(overlapping.length > startingIn.length, 'the frame straddles cycle boundaries');
    assert.deepStrictEqual(
      selectCalendarWeek(overlapping, NOW, 2).series,
      selectCalendarWeek(weeks, NOW, 2).series,
      'and the overlap query is the one that draws the line',
    );
  });

  // A session that begins at 00:00:29 carries the *same* name as midnight,
  // because the name is truncated to the minute. So the name alone cannot say
  // which day it belongs to, and a rule that answered with the name — which is
  // what `fromFileName` did, and why it was deleted — would have a coin flip
  // here. The header says 29 seconds past midnight, so it is today's.
  it('files a session by its start, not by a name it shares with midnight', async () => {
    const day = startOfLocalDay(NOW);
    const early = day + 29_000;

    const today = await storage.readRange('five_hour', ...poolDayRange(NOW, 0));
    const yesterday = await storage.readRange('five_hour', ...poolDayRange(NOW, 1));

    assert.strictEqual(toFileName(early), toFileName(day), 'named for the boundary itself');
    assert.ok(today.some((file) => file.startAt === early));
    assert.ok(!yesterday.some((file) => file.startAt === early));
  });

  // The one that runs past midnight. It starts on this day and belongs to it,
  // and it must not also appear on the next.
  it('files a session that crosses midnight under the day it began', async () => {
    const day = startOfLocalDay(NOW);
    const late = day + 23 * HOUR + 58 * 60_000;

    const today = await storage.readRange('five_hour', ...poolDayRange(NOW, 0));
    const tomorrow = await storage.readRange(
      'five_hour',
      ...poolDayRange(addLocalDays(NOW, 1), 0),
    );

    assert.ok(today.some((file) => file.startAt === late));
    assert.ok(!tomorrow.some((file) => file.startAt === late), 'never on both pages');
  });
});
