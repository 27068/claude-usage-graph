// SPDX-License-Identifier: AGPL-3.0-only

import * as vscode from 'vscode';
import type { IDisposable, IEventBus } from '../core/interfaces';

/**
 * The observer bus that joins the persistent core to the ephemeral UI.
 *
 * It is a thin wrapper and nothing more: the interface lives in `core/` so the
 * engine never imports vscode, and so tests can substitute a plain emitter.
 */
export class VsCodeEventBus<T> implements IEventBus<T> {
  private readonly emitter = new vscode.EventEmitter<T>();

  event(listener: (e: T) => void): IDisposable {
    return this.emitter.event(listener);
  }

  fire(e: T): void {
    this.emitter.fire(e);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
