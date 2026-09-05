// SPDX-License-Identifier: AGPL-3.0-only

import * as vscode from 'vscode';
import type { IClock, IDisposable, IEventBus } from '../core/interfaces';
import { lastValue, statusBarModel } from '../core/statusText';
import type { StatusBarInputs } from '../core/statusText';
import type { LedgerUpdatedEvent, Millis, StatusEvent } from '../core/types';

/**
 * How often the countdown is redrawn.
 *
 * The poll runs every three minutes, so rendering only on its events would let
 * a minute figure sit visibly stale and then jump. This timer costs nothing —
 * it recomputes two strings — and keeps the minute honest.
 */
const REFRESH_MS = 20_000;

const SEVERITY_COLOR: Record<string, string | undefined> = {
  none: undefined,
  warning: 'statusBarItem.warningBackground',
  error: 'statusBarItem.errorBackground',
};

/**
 * The whole authentication surface.
 *
 * Because the extension holds no credential of its own, there is nothing to
 * collect and no sign-in flow to run — the only thing to communicate is whether
 * Claude Code's own session is usable, and what to do when it is not.
 *
 * Every decision about wording lives in `core/statusText.ts`, where it can be
 * tested without a VS Code to host it. What is left here is reading the ledger,
 * keeping the clock ticking, and assigning three properties.
 */
export class UsageStatusBar implements IDisposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: IDisposable[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private latest: { five: number | null; seven: number | null } = { five: null, seven: null };
  private resets: { five: Millis | null; seven: Millis | null } = { five: null, seven: null };
  private status: StatusEvent = { state: 'ok' };

  constructor(
    updates: IEventBus<LedgerUpdatedEvent>,
    statuses: IEventBus<StatusEvent>,
    /**
     * Injected rather than read from `Date.now()` so a scenario clock drives the
     * countdown too. Without this the bar keeps real time while every graph
     * beside it is showing a scripted instant.
     */
    private readonly clock: IClock,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claudeUsageGraph.openDashboard';

    this.disposables.push(
      updates.event((event) => this.onUpdate(event)),
      statuses.event((event) => this.onStatus(event)),
    );

    this.timer = setInterval(() => this.render(), REFRESH_MS);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    this.refreshVisibility();
  }

  private onUpdate(event: LedgerUpdatedEvent): void {
    this.latest = {
      five: lastValue(event.newest.five_hour, 0),
      seven: lastValue(event.newest.seven_day, 0),
    };
    this.resets = { five: event.meta.fiveResetAt, seven: event.meta.sevenResetAt };
    this.render();
  }

  private onStatus(event: StatusEvent): void {
    this.status = event;
    this.render();
  }

  private render(): void {
    const inputs: StatusBarInputs = {
      status: this.status,
      now: this.clock.now(),
      five: this.latest.five,
      seven: this.latest.seven,
      fiveResetAt: this.resets.five,
      sevenResetAt: this.resets.seven,
    };
    const model = statusBarModel(inputs);
    const color = SEVERITY_COLOR[model.severity];

    this.item.text = `$(${model.icon}) ${model.label}`;
    this.item.tooltip = model.tooltip;
    this.item.backgroundColor = color === undefined ? undefined : new vscode.ThemeColor(color);

    this.refreshVisibility();
  }

  private refreshVisibility(): void {
    const enabled = vscode.workspace
      .getConfiguration('claudeUsageGraph')
      .get<boolean>('showStatusBar', true);
    if (enabled) {
      this.item.show();
    } else {
      this.item.hide();
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.item.dispose();
  }
}
