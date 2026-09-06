// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import * as fsSync from 'fs';
import * as path from 'path';
import { LedgerCache } from '../../core/ledgerCache';
import { FileLedgerStorage } from '../../core/ledgerStorage';
import { PollSchedule } from '../../core/pollSchedule';
import { selectCalendarWeek, selectPoolDay } from '../../core/selectors';
import { addLocalDays, startOfLocalDay } from '../../core/sessions';
import { statusBarModel } from '../../core/statusText';
import { UsageEngine } from '../../core/usageEngine';
import type { LedgerSnapshot, LedgerUpdatedEvent, Meta, Millis, StatusEvent } from '../../core/types';
import { MockUsagePoller } from '../../vscode/mockUsagePoller';
import { SCENARIO_DIR } from '../../vscode/mockUsagePoller';
import type { Scenario } from '../../vscode/mockUsagePoller';
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
const SCENARIOS = path.join(FIXTURES, SCENARIO_DIR);
const MINUTE = 60_000;

/**
 * The manual-testing scenarios, driven through the real engine.
 *
 * These exist so the rig cannot rot silently. A scenario is a claim about what
 * you will see on screen, and a claim written in offsets from an anchor is
 * exactly the kind that goes quietly wrong — a `nowMin` that lands inside the
 * window it was meant to be outside of still loads, still draws, and still looks
 * plausible. Asserting the claim here means an eyeball check confirms a picture
 * the suite already agrees with, rather than being the only thing standing
 * between a broken fixture and a wrong conclusion.
 *
 * The anchor is the same one the poller derives, so these run against whatever
 * today happens to be.
 */
const anchor = (): Millis => addLocalDays(startOfLocalDay(Date.now()), -1);

function readScenario(file: string): Scenario {
  return JSON.parse(fsSync.readFileSync(path.join(SCENARIOS, file), 'utf8')) as Scenario;
}

interface Replay {
  ledger: LedgerSnapshot;
  meta: Meta;
  status: StatusEvent | undefined;
  now: Millis;
}

/** Load one scenario the way the runner does, and play it to its end. */
async function replay(file: string): Promise<Replay> {
  const scenario = readScenario(file);
  const base = anchor();
  const now = base + (scenario.nowMin ?? 0) * MINUTE;

  const root = await makeTempDir();
  try {
    const clock = new FakeClock(now);
    const logger = new RecordingLogger();
    const storage = new FileLedgerStorage(root, logger);
    const cache = new LedgerCache(storage);
    const updates = new SimpleEventBus<LedgerUpdatedEvent>();
    const statuses = new SimpleEventBus<StatusEvent>();
    const poller = new MockUsagePoller(
      FIXTURES,
      clock,
      logger,
      path.join(SCENARIO_DIR, file),
      base,
    );

    const engine = new UsageEngine(
      poller,
      storage,
      cache,
      updates,
      statuses,
      new PollSchedule(root, 'test', clock, logger, 60_000),
      clock,
      logger,
      { intervalMs: 10 * MINUTE, mock: true },
    );

    await engine.start();
    // The same forced drain the extension host runs; see `drainFixture`.
    while (!poller.exhausted) {
      const before = poller.consumed;
      await engine.tick({ force: true });
      if (poller.consumed === before) {
        break;
      }
    }
    await engine.tick({ force: true });

    const last = updates.received[updates.received.length - 1];
    assert.ok(last !== undefined, `${file} published nothing`);
    return {
      // Read off disk, because a scenario assertion is about the ledger the
      // whole replay built up. Neither of the other two sources answers that:
      // the update event carries only what moved on the tick that fired it, and
      // the cache holds only the window still open.
      ledger: await readLedger(storage),
      meta: last.meta,
      status: statuses.received[statuses.received.length - 1],
      now,
    };
  } finally {
    await removeTempDir(root);
  }
}

describe('test scenarios', () => {
  const files = fsSync.readdirSync(SCENARIOS).filter((name) => name.endsWith('.json')).sort();

  it('ships a scenario directory that is actually populated', () => {
    assert.ok(files.length >= 5, `expected the documented set, found ${files.length}`);
  });

  for (const file of files) {
    it(`${file} is well formed`, () => {
      const scenario = readScenario(file);

      assert.ok(scenario.name, 'a scenario needs a name; it is what the picker shows');
      assert.ok(scenario.description, 'the description is the picker detail line');
      assert.strictEqual(typeof scenario.nowMin, 'number', 'a scenario must pin the clock');
      assert.ok(Array.isArray(scenario.frames) && scenario.frames.length > 0);

      const frames = scenario.frames ?? [];
      for (let index = 1; index < frames.length; index += 1) {
        assert.ok(
          frames[index].atMin >= frames[index - 1].atMin,
          `${file} frame ${index} goes backwards in time`,
        );
      }
      // A frame after the pin would be recorded at a time the chart calls the
      // future, which draws as a line running past the Now marker.
      const latest = frames[frames.length - 1].atMin;
      assert.ok(latest <= (scenario.nowMin ?? 0), `${file} has a frame after nowMin`);
    });
  }

  // The case this whole rig was built for, and the one no fixture could express
  // until `fiveResetMin` was allowed to be null.
  describe('01-lapsed-pool', () => {
    let result: Replay;
    before(async () => {
      result = await replay('01-lapsed-pool.json');
    });

    it('stops writing the session ledger when the pool lapses', () => {
      const sessions = result.ledger.sessions;
      assert.ok(sessions.length > 0, 'the session before the reset must be recorded');

      const file = sessions[sessions.length - 1];
      const lastSample = file.samples[file.samples.length - 1][0];
      assert.ok(
        lastSample < file.resetAt,
        'the last session sample must fall before the reset it never saw',
      );
    });

    it('keeps extending the weekly ledger right up to now', () => {
      const weeks = result.ledger.weeks;
      const file = weeks[weeks.length - 1];
      const lastSample = file.samples[file.samples.length - 1][0];

      assert.strictEqual(lastSample, result.now, 'the weekly bookend slides to the last poll');
    });

    // The two graphs ending at different times is the whole observation.
    it('leaves the two graphs ending hours apart', () => {
      const sessions = result.ledger.sessions;
      const session = sessions[sessions.length - 1];
      const week = result.ledger.weeks[result.ledger.weeks.length - 1];
      const gap =
        week.samples[week.samples.length - 1][0] - session.samples[session.samples.length - 1][0];

      assert.ok(gap > 2 * 60 * MINUTE, `expected a multi-hour gap, got ${gap / MINUTE} minutes`);
    });

    it('reports no open pool, so the status bar goes idle', () => {
      assert.strictEqual(result.meta.fiveResetAt, null);

      const model = statusBarModel({
        status: result.status ?? { state: 'mock' },
        now: result.now,
        five: 3,
        seven: 19,
        fiveResetAt: result.meta.fiveResetAt,
        sevenResetAt: result.meta.sevenResetAt,
      });
      assert.ok(model.label.startsWith('idle'), model.label);
    });

    it('keeps Now on graph 1 even though the line stopped hours ago', () => {
      const view = selectPoolDay(result.ledger.sessions, result.now, result.now, 0);

      assert.strictEqual(view.empty, false);
      assert.ok(view.domain[0] <= result.now && result.now <= view.domain[1]);
      assert.ok(view.resets.length > 0, 'the reset wall is what explains the gap');
    });
  });

  describe('02-quiet-day', () => {
    it('draws today blank and framed rather than showing the placeholder', async () => {
      const result = await replay('02-quiet-day.json');
      const view = selectPoolDay(result.ledger.sessions, result.now, result.now, 0);

      assert.strictEqual(view.sessionCount, 0, 'nothing ran today');
      assert.strictEqual(view.empty, false, 'but the ledger is not empty, so no placeholder');
      assert.ok(view.domain[0] <= result.now && result.now <= view.domain[1]);

      const yesterday = selectPoolDay(result.ledger.sessions, result.now, result.now, 1);
      assert.ok(yesterday.sessionCount > 0, 'paging back one day must reach the data');
    });
  });

  describe('03-stale-weekly', () => {
    it('projects the live cycle and keeps Now inside it', async () => {
      const result = await replay('03-stale-weekly.json');
      const view = selectCalendarWeek(result.ledger.weeks, result.now, 0);

      assert.strictEqual(view.empty, false, 'a projected cycle is framed, not blanked');
      assert.ok(view.domain[0] <= result.now && result.now <= view.domain[1]);
      assert.ok(
        view.series.every((entry) => entry.points.length === 0),
        'the live cycle holds no samples; that is the point',
      );
      assert.ok((view.resetAt ?? 0) > result.now, 'the frame ends ahead of now');

      // The one projected wall in the product, and it has to say so.
      assert.strictEqual(view.resets.length, 1);
      assert.ok(view.resets[0].label.startsWith('Expected reset'), view.resets[0].label);
    });

    it('shows the recorded wall, not a projection, once you page back to the data', async () => {
      const result = await replay('03-stale-weekly.json');
      const recorded = result.ledger.weeks[result.ledger.weeks.length - 1].resetAt;

      const page = [1, 2, 3].map((offset) =>
        selectCalendarWeek(result.ledger.weeks, result.now, offset),
      );
      const walls = page.flatMap((view) => view.resets);

      // More than one page can show it, and that is correct: the 12-hour buffers
      // overlap by design, so a boundary sitting near an edge is visible from
      // both sides of it rather than falling in the crack between two frames.
      assert.ok(walls.length > 0, 'paging back must reach the recorded boundary');
      for (const wall of walls) {
        assert.strictEqual(wall.at, recorded, 'the only wall back here is the recorded one');
        assert.ok(wall.label.startsWith('Reset '), `measured, so not "Expected": ${wall.label}`);
      }
    });

    it('still reaches the recorded data by paging back', async () => {
      const result = await replay('03-stale-weekly.json');
      const found = [1, 2, 3].some((offset) =>
        selectCalendarWeek(result.ledger.weeks, result.now, offset).series.some(
          (entry) => entry.points.length > 0,
        ),
      );

      assert.ok(found, 'the recorded cycle must be reachable within three pages back');
    });
  });

  describe('04-empty-ledger', () => {
    it('writes nothing at all, which is the one case that may say "no data"', async () => {
      const result = await replay('04-empty-ledger.json');

      assert.strictEqual(result.ledger.sessions.length, 0);
      assert.strictEqual(result.ledger.weeks.length, 0);
      assert.strictEqual(selectPoolDay(result.ledger.sessions, result.now, result.now, 0).empty, true);
      assert.strictEqual(selectCalendarWeek(result.ledger.weeks, result.now, 0).empty, true);
    });
  });

  describe('00-live-session', () => {
    it('has an open pool, so the bar shows a percentage and a countdown', async () => {
      const result = await replay('00-live-session.json');

      assert.ok(result.meta.fiveResetAt !== null, 'the pool is still open');
      const model = statusBarModel({
        status: { state: 'mock' },
        now: result.now,
        five: 41,
        seven: 19,
        fiveResetAt: result.meta.fiveResetAt,
        sevenResetAt: result.meta.sevenResetAt,
      });
      assert.ok(!model.label.includes('idle'), model.label);
      assert.ok(model.label.startsWith('41%'), model.label);
    });
  });
});
