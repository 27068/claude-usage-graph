// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ScenarioClock } from '../core/clock';
import { clearLedger } from '../core/eviction';
import type { ILedgerStorage, ILogger } from '../core/interfaces';
import type { LedgerCache } from '../core/ledgerCache';
import type { UsageEngine } from '../core/usageEngine';
import type { Millis } from '../core/types';
import { SCENARIO_DIR } from './mockUsagePoller';
import type { MockUsagePoller, Scenario } from './mockUsagePoller';

const MINUTE_MS = 60_000;

export interface ScenarioRunnerOptions {
  fixtureRoot: string;
  poller: MockUsagePoller;
  clock: ScenarioClock;
  storage: ILedgerStorage;
  cache: LedgerCache;
  engine: UsageEngine;
  logger: ILogger;
  /** Replays a fixture to its end; the composition root owns the loop. */
  drain: () => Promise<void>;
}

/**
 * Manual-testing rig: load one scripted state at a time, including its clock.
 *
 * The edge cases this exists for cannot be produced by waiting or by using the
 * extension normally — a five-hour pool that lapsed three hours ago, a weekly
 * cycle three weeks stale, a ledger with nothing in it at all. Each is a
 * combination of ledger contents *and* a position on the clock, and the two have
 * to move together: a lapsed-pool script means nothing if `now` is still inside
 * the window it lapsed from.
 *
 * So a scenario carries both, and switching is a command rather than a launch
 * argument. One dev host steps through the whole set; a relaunch per case would
 * mean rebuilding the window for every assertion you wanted to make by eye.
 *
 * Registered only in development, and only when CUG_TEST_MODE is set. Nothing
 * here can run in an installed extension.
 */
export class ScenarioRunner {
  private active: string | undefined;

  constructor(private readonly options: ScenarioRunnerOptions) {}

  private get directory(): string {
    return path.join(this.options.fixtureRoot, SCENARIO_DIR);
  }

  /** File names in the scenario directory, sorted — they are numbered to order. */
  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.directory);
      return entries.filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      this.options.logger.error(`Could not read ${this.directory}: ${String(error)}`);
      return [];
    }
  }

  /** Peek at a scenario's metadata without loading it, to label the picker. */
  private async describe(file: string): Promise<Scenario> {
    try {
      const raw = await fs.readFile(path.join(this.directory, file), 'utf8');
      return JSON.parse(raw) as Scenario;
    } catch {
      return {};
    }
  }

  async pick(): Promise<void> {
    const files = await this.list();
    if (files.length === 0) {
      void vscode.window.showWarningMessage(
        `No scenarios found in ${this.directory}. See docs/DEVELOPING.md section 10.`,
      );
      return;
    }

    const items = await Promise.all(
      files.map(async (file) => {
        const scenario = await this.describe(file);
        return {
          label: scenario.name ?? file,
          description: file === this.active ? '$(check) loaded' : '',
          detail: scenario.description ?? '',
          file,
        };
      }),
    );

    const chosen = await vscode.window.showQuickPick(items, {
      title: 'Load usage scenario',
      placeHolder: 'Replaces the ledger and pins the clock',
      matchOnDetail: true,
    });
    if (chosen !== undefined) {
      await this.load(chosen.file);
    }
  }

  /**
   * Swap in a scenario: pin the clock, wipe the ledger, replay the script.
   *
   * The order matters and is not interchangeable. The clock moves *first*
   * because `Evictor` and every reset comparison downstream read it, and a script
   * written three weeks in the past is entirely evictable against today's date.
   * The ledger is wiped *before* the replay because the engine appends; left in
   * place, the previous scenario's sessions would interleave with this one's into
   * a ledger that never existed anywhere.
   */
  async load(file: string): Promise<void> {
    const { poller, clock, storage, cache, engine, logger, drain } = this.options;

    const scenario = await poller.loadScenario(path.join(SCENARIO_DIR, file));
    const pinned = pinnedInstant(poller.anchor(), scenario.nowMin);
    clock.pin(pinned);
    logger.info(
      pinned === undefined
        ? `Scenario ${file}: clock left at real time`
        : `Scenario ${file}: clock pinned to ${new Date(pinned).toLocaleString()}`,
    );

    await clearLedger(storage, cache, logger);
    await cache.reload();
    await drain();
    // A scenario whose script writes nothing — the empty-ledger case — consumes
    // its frames without ever publishing, so the panel would keep showing the
    // previous scenario until something else moved. Tick once more to publish
    // the cleared state.
    await engine.tick();

    this.active = file;
    void vscode.window.showInformationMessage(
      `Loaded scenario: ${scenario.name ?? file}${
        pinned === undefined ? '' : ` (clock pinned to ${new Date(pinned).toLocaleString()})`
      }`,
    );
  }
}

function pinnedInstant(base: Millis, nowMin: number | undefined): Millis | undefined {
  return nowMin === undefined ? undefined : base + nowMin * MINUTE_MS;
}
