// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { CredentialReader } from './auth/credentialReader';
import { ScenarioClock, SystemClock } from './core/clock';
import { RETENTION_DAYS, retentionMsFromDays } from './core/eviction';
import { LedgerCache } from './core/ledgerCache';
import { FileLedgerStorage } from './core/ledgerStorage';
import { PollSchedule } from './core/pollSchedule';
import { addLocalDays, startOfLocalDay } from './core/sessions';
import { POLL_INTERVAL_MS, UsageEngine } from './core/usageEngine';
import type { LedgerUpdatedEvent, Meta, StatusEvent } from './core/types';
import { ClaudeCliRefresher } from './vscode/claudeCliRefresher';
import { DashboardPanel, VIEW_TYPE } from './vscode/dashboardPanel';
import { HttpUsagePoller } from './vscode/httpUsagePoller';
import { MockUsagePoller } from './vscode/mockUsagePoller';
import { OutputChannelLogger } from './vscode/outputChannelLogger';
import { UsageStatusBar } from './vscode/statusBar';
import { ScenarioRunner } from './vscode/testScenarios';
import { VsCodeEventBus } from './vscode/vscodeEventBus';

/**
 * Composition root. This is the only file that calls `new`, and the only place
 * the dependency graph is assembled.
 *
 * Note what does *not* happen here: no panel is created. The engine starts and
 * runs for the life of the window whether or not anything is ever rendered, and
 * it holds no reference to a panel — the two are joined only by an event bus.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new OutputChannelLogger('Claude Usage Graph');

  // Manual-testing rig. Gated on development mode *and* an explicit environment
  // variable, so neither an installed extension nor an ordinary F5 can end up
  // with a clock someone else is allowed to move. See `vscode/testScenarios.ts`.
  const devMode = context.extensionMode === vscode.ExtensionMode.Development;
  const testMode = devMode && process.env.CUG_TEST_MODE === '1';
  // Also built for a plain mock run, because a fixture may pin the clock itself:
  // the screenshot script describes a specific past week and declares the
  // instant to freeze at, so that NOW lands inside the data instead of hours
  // past the end of it. Still development-only, and still inert until something
  // pins it — an unpinned ScenarioClock is a SystemClock.
  const scenarioClock = devMode ? new ScenarioClock() : undefined;
  const clock = scenarioClock ?? new SystemClock();

  const updates = new VsCodeEventBus<LedgerUpdatedEvent>();
  const statuses = new VsCodeEventBus<StatusEvent>();

  // Isolation is taken here rather than asked for.
  //
  // A dev host cannot be given a storage root of its own from `launch.json`.
  // Both `--profile` and `--user-data-dir` are dropped: an already-running
  // VS Code opens the development window itself, keeping the storage it already
  // has, and `--profile` compounds it by registering the profile first so the
  // attempt looks like it worked. The environment does reach the extension host
  // process, so that is the seam that works. Development mode only — this must
  // never be able to redirect an installed extension's ledger.
  const override = devMode ? process.env.CUG_STORAGE_ROOT : undefined;
  const root = override ?? context.globalStorageUri.fsPath;
  // Logged because "is this window isolated from my real ledger?" is otherwise
  // answerable only by hunting through VS Code's storage tree, and a dev host
  // that quietly shares the real root looks exactly like mock mode failing.
  logger.info(`Ledger root: ${root}${override === undefined ? '' : ' (CUG_STORAGE_ROOT)'}`);
  const storage = new FileLedgerStorage(root, logger);
  const cache = new LedgerCache(storage);
  const schedule = new PollSchedule(root, randomUUID(), clock, logger, POLL_INTERVAL_MS);

  // Mock data is the default when developing, but an explicit setting always
  // wins — otherwise there would be no way to exercise the live endpoint from an
  // Extension Development Host. `get()` cannot distinguish "unset" from "set to
  // the declared default", so inspect the value's origin instead.
  const mockSetting = vscode.workspace
    .getConfiguration('claudeUsageGraph')
    .inspect<boolean>('useMockData');
  const explicitMock =
    mockSetting?.workspaceFolderValue ?? mockSetting?.workspaceValue ?? mockSetting?.globalValue;
  const useMock = explicitMock ?? devMode;

  // Which script to replay. An environment variable rather than a setting: this
  // is a launch-configuration concern, it must not appear in a user's settings
  // UI, and `launch.json` can set it per configuration. See `docs/DEVELOPING.md`
  // section 1 for the screenshot configuration that uses it.
  const fixtureFile = process.env.CUG_MOCK_FIXTURE ?? 'mock-usage.json';

  // Derived from real time, never from `clock`. A scenario pins the clock to
  // `anchor + nowMin`, so an anchor read back off that clock would chase the
  // value it is supposed to define.
  const fixtureRoot = vscode.Uri.joinPath(context.extensionUri, 'fixtures').fsPath;
  const fixtureBase = addLocalDays(startOfLocalDay(Date.now()), -1);

  const mockPoller = useMock
    ? new MockUsagePoller(fixtureRoot, clock, logger, fixtureFile, fixtureBase)
    : undefined;
  const credentials = new CredentialReader(clock, logger);
  const poller = mockPoller ?? new HttpUsagePoller(credentials, clock, logger);
  // Mock mode reads no credential and so can never report one stale; giving it a
  // refresher would only add a way to start a CLI that fixes nothing.
  const refresher = useMock ? undefined : new ClaudeCliRefresher(credentials, logger);

  if (useMock) {
    logger.info(`Running with synthetic fixture data (development mode, ${fixtureFile})`);
  }

  const engine = new UsageEngine(
    poller,
    storage,
    cache,
    updates,
    statuses,
    schedule,
    clock,
    logger,
    {
      intervalMs: POLL_INTERVAL_MS,
      mock: useMock,
      retentionMs: retentionMsFromDays(
        vscode.workspace
          .getConfiguration('claudeUsageGraph')
          .get<number>('retentionDays', RETENTION_DAYS),
      ),
    },
    refresher,
  );

  // Track the most recent meta and status so a panel opened later hydrates with
  // real values instead of a blank frame.
  let latestMeta: Meta = {
    now: clock.now(),
    fiveResetAt: null,
    sevenResetAt: null,
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    mock: useMock,
  };
  let latestStatus: StatusEvent | undefined;

  context.subscriptions.push(
    { dispose: () => updates.dispose() },
    { dispose: () => statuses.dispose() },
    { dispose: () => engine.dispose() },
    logger,
    new UsageStatusBar(updates, statuses, clock),
  );

  updates.event((event) => {
    latestMeta = event.meta;
  });
  statuses.event((event) => {
    latestStatus = event;
  });

  /**
   * Freeze the clock where the fixture says, before anything reads it.
   *
   * Ordered ahead of `engine.start()` deliberately. Every row the engine writes
   * is stamped from the snapshot rather than the clock, but the frame the panel
   * draws, the Now marker and the status bar countdown all read `now` — so a
   * start that ran first would publish one round of meta from real time and then
   * jump, which looks exactly like the ledger being stale.
   *
   * Only a fixture that asks for it: `mock-usage.json` declares no `nowMin` and
   * keeps running on real time, which is what an open-ended development fixture
   * wants.
   */
  async function pinFixtureClock(): Promise<void> {
    if (mockPoller === undefined || scenarioClock === undefined) {
      return;
    }
    const scenario = await mockPoller.loadScenario(fixtureFile);
    if (scenario.nowMin === undefined) {
      return;
    }
    const pinned = mockPoller.anchor() + scenario.nowMin * 60_000;
    scenarioClock.pin(pinned);
    logger.info(`Clock pinned to ${new Date(pinned).toISOString()} by ${fixtureFile}`);
  }

  // Started before any UI is registered, because a panel restored by the
  // serializer can hydrate while activation is still running. Panels await this
  // promise, so a hydrate can never read the cache before it has been loaded
  // from disk — which would report a full ledger as "No data".
  const started = pinFixtureClock()
    .then(() => engine.start())
    .then(() => drainFixture(engine, mockPoller, logger))
    .catch((error: unknown) => {
      logger.error(`Usage engine failed to start: ${String(error)}`);
    });

  const panelDependencies = () => ({
    extensionUri: context.extensionUri,
    version: String(context.extension.packageJSON.version),
    updates,
    statuses,
    cache,
    storage,
    logger,
    latest: () => ({ meta: latestMeta, status: latestStatus }),
    ready: started,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeUsageGraph.openDashboard', () => {
      DashboardPanel.reveal(panelDependencies());
    }),
    // Forced, so it polls rather than deferring to a deadline another window
    // set. Any window can serve it: the claim is what keeps the ledger to one
    // writer, not which window happens to have polled last.
    vscode.commands.registerCommand('claudeUsageGraph.refreshNow', () =>
      void engine.tick({ force: true }),
    ),
    vscode.commands.registerCommand('claudeUsageGraph.showLogs', () => logger.show()),
    vscode.commands.registerCommand('claudeUsageGraph.openSettings', () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id}`,
      ),
    ),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel): Promise<void> {
        DashboardPanel.restore(panel, panelDependencies());
      },
    }),
  );

  // Only ever registered in the test host, so the command does not appear in an
  // ordinary development window's palette and cannot exist in an installed one.
  if (testMode && mockPoller !== undefined && scenarioClock !== undefined) {
    const runner = new ScenarioRunner({
      fixtureRoot,
      poller: mockPoller,
      clock: scenarioClock,
      storage,
      cache,
      engine,
      logger,
      drain: () => drainFixture(engine, mockPoller, logger),
    });
    context.subscriptions.push(
      vscode.commands.registerCommand('claudeUsageGraph.loadTestScenario', () => void runner.pick()),
    );
    // The palette entry is gated on this key rather than always contributed: the
    // command exists only here, and an entry for an unregistered command fails
    // when someone picks it out of an ordinary window's palette.
    void vscode.commands.executeCommand('setContext', 'claudeUsageGraph.testMode', true);
    logger.info('Test mode: "Claude Usage: Load Test Scenario" is available in the palette');
  }

  await started;
}

/**
 * Play a mock fixture to its end, immediately.
 *
 * A frame is a scripted observation carrying its own timestamp, so replaying the
 * script quickly and replaying it slowly write byte-identical ledgers — the only
 * thing the live timer adds is the wait. For a fixture dense enough to draw a
 * day without dead-zone breaks that wait is hours, during which the dashboard
 * shows a fraction of the picture and looks broken. Drain it instead; the normal
 * timer then holds on the final frame, which is what the poller already does
 * once the script runs out.
 *
 * Draining has to force each tick, because the schedule this window just set is
 * three minutes out and every frame after the first would defer to it. The
 * unforced tick inside `engine.start()` is therefore the gate: if it consumed
 * nothing, another window is polling and this one is rendering that window's
 * real ledger. Forcing from there would write synthetic frames into it — the
 * hazard `docs/DEVELOPING.md` section 1 is about — so stop before the first
 * forced tick rather than after it.
 */
async function drainFixture(
  engine: UsageEngine,
  poller: MockUsagePoller | undefined,
  logger: OutputChannelLogger,
): Promise<void> {
  if (poller === undefined) {
    return;
  }
  if (poller.consumed === 0) {
    logger.info('Fixture drain stopped: another window is polling');
    return;
  }
  while (!poller.exhausted) {
    const before = poller.consumed;
    await engine.tick({ force: true });
    // A turn can still be lost mid-drain, to a hand-forced refresh elsewhere.
    if (poller.consumed === before) {
      logger.info('Fixture drain stopped: lost the poll turn to another window');
      return;
    }
  }
  logger.info(`Fixture replayed in full (${poller.consumed} frames)`);
}

export function deactivate(): void {
  // Everything is registered in context.subscriptions and disposed by VS Code.
}
