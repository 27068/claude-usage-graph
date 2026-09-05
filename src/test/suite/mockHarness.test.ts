// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import * as path from 'path';
import { LedgerCache } from '../../core/ledgerCache';
import { FileLedgerStorage } from '../../core/ledgerStorage';
import { PollSchedule } from '../../core/pollSchedule';
import { selectPoolDay } from '../../core/selectors';
import { addLocalDays, startOfLocalDay } from '../../core/sessions';
import { UsageEngine } from '../../core/usageEngine';
import type { LedgerFile, LedgerUpdatedEvent, StatusEvent } from '../../core/types';
import { MockUsagePoller } from '../../vscode/mockUsagePoller';
import {
  FakeClock,
  RecordingLogger,
  SimpleEventBus,
  makeTempDir,
  readLedger,
  removeTempDir,
} from './helpers';

/** out/test/suite -> project root */
const FIXTURES = path.join(__dirname, '..', '..', '..', 'fixtures');
const NOW = new Date(2026, 4, 20, 12, 0, 0, 0).getTime();

/**
 * Drives the development fixture through the real engine.
 *
 * The point of this suite is that the mock harness does not bypass anything: it
 * feeds raw payloads through the same normalizer, dedupe rules and rollover
 * logic a live poll uses, so what you see pressing F5 is produced by the code
 * that runs in production.
 */
describe('mock harness (end to end)', () => {
  let root: string;
  let storage: FileLedgerStorage;
  let cache: LedgerCache;
  let engine: UsageEngine;
  let sessions: LedgerFile[];
  let weeks: LedgerFile[];

  before(async () => {
    root = await makeTempDir();
    const clock = new FakeClock(NOW);
    const logger = new RecordingLogger();
    storage = new FileLedgerStorage(root, logger);
    cache = new LedgerCache(storage);

    engine = new UsageEngine(
      new MockUsagePoller(FIXTURES, clock, logger),
      storage,
      cache,
      new SimpleEventBus<LedgerUpdatedEvent>(),
      new SimpleEventBus<StatusEvent>(),
      new PollSchedule(root, 'test', clock, logger, 60_000),
      clock,
      logger,
      { intervalMs: 10 * 60_000, mock: true },
    );

    await engine.start();
    // Forced, like `drainFixture` in the extension host: the fixture is replayed
    // as fast as it can be read, and every tick after the first is inside the
    // interval the previous one just scheduled.
    for (let tick = 0; tick < 24; tick += 1) {
      await engine.tick({ force: true });
    }

    ({ sessions, weeks } = await readLedger(storage));
  });

  after(async () => {
    engine.dispose();
    await removeTempDir(root);
  });

  it('produces one file per five-hour window', () => {
    assert.strictEqual(sessions.length, 3, 'the fixture scripts three distinct sessions');
  });

  it('records a session that begins at 23:00 and resets after midnight', () => {
    const yesterday = addLocalDays(startOfLocalDay(NOW), -1);
    const late = sessions.find((file) => file.startAt === yesterday + 23 * 3_600_000);

    assert.ok(late, 'the 23:00 session should exist');
    assert.strictEqual(late.resetAt, yesterday + 28 * 3_600_000, 'it resets at 04:00 the next day');
  });

  it('buckets every session under the day it started, including the late one', () => {
    const yesterday = addLocalDays(startOfLocalDay(NOW), -1);
    const view = selectPoolDay(sessions, NOW, 1);

    assert.strictEqual(view.sessionCount, 3, 'all three started yesterday');
    assert.strictEqual(view.domain[0], yesterday + 7 * 3_600_000, '08:00 start, framed from 07:00');
    assert.ok(
      view.domain[1] > startOfLocalDay(NOW),
      'the axis must extend past midnight to cover the late session',
    );
  });

  it('breaks the line where the value moved while we were away', () => {
    const first = sessions[0];
    const breaks = first.samples.filter((sample) => sample[1] === null);

    assert.strictEqual(breaks.length, 1, 'exactly one dead zone in the first session');
  });

  it('does NOT break the line across the long stretch where nothing moved', () => {
    // The fixture idles 77 minutes at 41% after the break. If elapsed time alone
    // could trigger a dead zone, this session would carry a second null.
    const first = sessions[0];
    const nulls = first.samples.filter((sample) => sample[1] === null).length;

    assert.strictEqual(nulls, 1, 'idleness must not manufacture a second break');
  });

  it('compresses the idle stretches instead of storing every tick', () => {
    const first = sessions[0];

    assert.strictEqual(
      first.samples.length,
      7,
      `nine frames should compress to seven rows, got ${JSON.stringify(first.samples)}`,
    );
  });

  it('keeps the reset boundary in the header and off every row', () => {
    for (const file of sessions) {
      assert.strictEqual(typeof file.resetAt, 'number');
      for (const sample of file.samples) {
        assert.strictEqual(sample.length, 2, 'a session row is [t, five_hour]');
      }
    }
  });

  it('records the weekly cycle alongside the sessions', () => {
    assert.strictEqual(weeks.length, 1, 'the fixture stays inside one weekly cycle');
    assert.ok(weeks[0].samples.length > 1);
  });

  it('gives a plan that meters no model tier exactly one weekly column', () => {
    // The fixture is Pro-shaped: an all-models window and nothing else. Columns
    // are earned by reporting a number, so this is the whole header — a plan
    // without per-model allowances must not carry per-model columns at all,
    // which is what stops the chart offering series that can never be drawn.
    assert.deepStrictEqual(weeks[0].cols, ['seven_day']);
    for (const sample of weeks[0].samples) {
      assert.strictEqual(sample.length, 2, 'a week row is [t, seven_day]');
    }
  });
});
