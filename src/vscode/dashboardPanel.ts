// SPDX-License-Identifier: AGPL-3.0-only

import * as vscode from 'vscode';
import type { IDisposable, IEventBus, ILedgerStorage, ILogger } from '../core/interfaces';
import type { LedgerCache } from '../core/ledgerCache';
import type {
  ClientMessage,
  HostMessage,
  LedgerFile,
  LedgerKind,
  LedgerUpdatedEvent,
  Meta,
  Millis,
  StatusEvent,
} from '../core/types';
import { renderDashboardHtml } from '../webview/template';

/**
 * Also written out longhand in `package.json`, as the `activeWebviewPanelId`
 * when-clause on the `editor/title` menu items. That is what puts the gear and
 * output icons in the tab's title bar, and it is matched as a plain string —
 * renaming this constant without renaming it there loses both buttons silently.
 */
export const VIEW_TYPE = 'claudeUsageGraph.dashboard';

export interface PanelDependencies {
  extensionUri: vscode.Uri;
  /** The extension's own version, forwarded to the panel as its build identity. */
  version: string;
  updates: IEventBus<LedgerUpdatedEvent>;
  statuses: IEventBus<StatusEvent>;
  cache: LedgerCache;
  /** Where history is read from. The cache holds only the live window. */
  storage: ILedgerStorage;
  logger: ILogger;
  /** Latest known meta and status, so a freshly opened panel is not blank. */
  latest: () => { meta: Meta; status: StatusEvent | undefined };
  /** Resolves once the ledger cache has been loaded from disk. */
  ready: Promise<void>;
}

/**
 * The ephemeral half of the extension.
 *
 * It subscribes to the bus on construction and unsubscribes on disposal, and it
 * is the *only* thing that knows a webview exists — the engine holds no
 * reference to it and keeps running whether or not one is ever built.
 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  private readonly disposables: IDisposable[] = [];
  private disposed = false;
  private revision = 0;

  static reveal(dependencies: PanelDependencies): void {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (DashboardPanel.current !== undefined) {
      DashboardPanel.current.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Claude Usage Graph', column, {
      enableScripts: true,
      // Deliberately false: the DOM is cheap to rebuild, and the client persists
      // its own page through getState/setState, so nothing is lost.
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(dependencies.extensionUri, 'media')],
    });

    DashboardPanel.current = new DashboardPanel(panel, dependencies);
  }

  static restore(panel: vscode.WebviewPanel, dependencies: PanelDependencies): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(dependencies.extensionUri, 'media')],
    };
    DashboardPanel.current?.dispose();
    DashboardPanel.current = new DashboardPanel(panel, dependencies);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly dependencies: PanelDependencies,
  ) {
    // Subscribe BEFORE handing the webview its HTML. Assigning `html` starts the
    // page loading, and the client posts `ready` as soon as it has restored its
    // saved page — which can easily beat a listener registered afterwards. A
    // dropped `ready` means `hydrate` never fires and the panel sits empty until
    // the next poll, which is a very confusing first impression.
    this.disposables.push(
      dependencies.updates.event((event) => this.onLedgerUpdated(event)),
      dependencies.statuses.event((event) => this.post({ type: 'status', ...event })),
      panel.webview.onDidReceiveMessage((message: ClientMessage) => this.onClientMessage(message)),
    );

    panel.onDidDispose(() => this.dispose());

    // The client builds the toggles from the series the ledger turns out to
    // have — see the note in `renderDashboardHtml`.
    panel.webview.html = renderDashboardHtml(panel.webview, dependencies.extensionUri);
  }

  /**
   * Forward only what moved.
   *
   * A tick writes at most one file per kind, so this is a few hundred bytes
   * across the host/webview boundary rather than a re-send of the retention
   * window. An empty patch still posts: `meta` carries the reset countdowns,
   * which move whether or not a sample was recorded.
   */
  private onLedgerUpdated(event: LedgerUpdatedEvent): void {
    this.revision = event.revision;
    this.post({
      type: 'ledger/patch',
      revision: event.revision,
      patch: event.patch,
      meta: event.meta,
    });
  }

  private onClientMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'ready':
        void this.hydrate();
        break;
      case 'page':
        void this.servePage(message);
        break;
      case 'series':
        void vscode.workspace
          .getConfiguration('claudeUsageGraph')
          .update('hiddenSeries', message.hidden, vscode.ConfigurationTarget.Global);
        break;
      default:
        break;
    }
  }

  private async hydrate(): Promise<void> {
    // The cache is loaded asynchronously at activation, and a panel restored by
    // the serializer can ask for data before that finishes. Without this wait it
    // would be handed an empty snapshot and render "No data" over a full ledger.
    await this.dependencies.ready;
    if (this.disposed) {
      return;
    }

    const { meta, status } = this.dependencies.latest();

    // The live window of each kind, and the far edge of the ledger. The live
    // file draws the current frame, says whether the ledger holds anything at
    // all, and carries the boundary the calendar takes its phase from; `oldest`
    // is the one fact behind it that only the directory has, and it is what the
    // backward controls stop at. Together they are all the client needs before
    // it can work out which page to ask for.
    const live: Partial<Record<LedgerKind, LedgerFile>> = {};
    const oldest: Partial<Record<LedgerKind, Millis>> = {};
    for (const kind of ['five_hour', 'seven_day'] as const) {
      const newest = this.dependencies.cache.newest(kind);
      if (newest !== undefined) {
        live[kind] = newest;
      }
      const first = await this.dependencies.storage.oldest(kind);
      if (first !== undefined) {
        oldest[kind] = first.startAt;
      }
    }

    // Deliberately *not* `this.revision + 1`. Revisions are the engine's
    // sequence, and inventing the next one means the engine's real update
    // carries a number the client has already seen and discards as stale —
    // leaving a panel that hydrated empty blank until the poll after next.
    // Logged because a silently-empty panel is otherwise indistinguishable from
    // a dropped `ready`: this line proves hydrate ran and says what it carried.
    this.dependencies.logger.info(
      `Dashboard hydrated (revision ${this.revision}): ` +
        `live ${Object.keys(live).join(', ') || 'none'}`,
    );
    this.post({
      type: 'hydrate',
      revision: this.revision,
      live,
      oldest,
      meta,
      config: { hiddenSeries: hiddenSeries(), version: this.dependencies.version },
    });

    if (status !== undefined) {
      this.post({ type: 'status', ...status });
    }
  }

  /**
   * Answer one page request, and only ever as an answer.
   *
   * This is the sole place a `ledger/page` is posted, and it posts exactly the
   * range that was asked for, tagged with the id it was asked under. The host
   * keeps no offset of its own and there is no path by which it can decide the
   * client should be looking somewhere else.
   *
   * Read straight from storage rather than through the cache. History is
   * immutable once a window has closed, so a page needs no coherence with
   * anything the cache holds; the live file arrives separately, by patch.
   */
  private async servePage(request: ClientMessage & { type: 'page' }): Promise<void> {
    await this.dependencies.ready;
    if (this.disposed) {
      return;
    }
    const { storage } = this.dependencies;
    const files =
      request.mode === 'overlaps'
        ? await storage.readOverlapping(request.kind, request.from, request.to)
        : await storage.readRange(request.kind, request.from, request.to);

    // Re-read rather than cached from hydrate: eviction moves this edge forward
    // under an open panel, and a clamp that has gone stale is a back button that
    // pages into nothing. It costs one listing and one read on a click.
    const first = await storage.oldest(request.kind);
    const answer: HostMessage = {
      type: 'ledger/page',
      requestId: request.requestId,
      kind: request.kind,
      files,
    };
    if (first !== undefined) {
      answer.oldest = first.startAt;
    }
    this.post(answer);
  }

  /**
   * Every outbound message goes through here. The disposed guard is what makes
   * a tick that lands in the same macrotask as a tab close a no-op instead of a
   * "Webview is disposed" throw.
   */
  private post(message: HostMessage): void {
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    if (DashboardPanel.current === this) {
      DashboardPanel.current = undefined;
    }
  }
}

/**
 * Which calendar series the reader has switched off. Empty by default.
 *
 * Unfiltered, deliberately. There is no fixed column list to filter against —
 * the series are discovered from the ledger, and a key this build has never seen
 * is exactly what a plan change looks like. A deny-list needs no such guard: an
 * entry naming a series that does not report hides nothing, because nothing
 * draws it.
 */
function hiddenSeries(): string[] {
  return vscode.workspace.getConfiguration('claudeUsageGraph').get<string[]>('hiddenSeries', []);
}
