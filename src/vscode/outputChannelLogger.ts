// SPDX-License-Identifier: AGPL-3.0-only

import * as vscode from 'vscode';
import type { ILogger } from '../core/interfaces';

/**
 * The only place the headless engine is visible without opening the dashboard,
 * which makes it the tool for confirming the core really does run on its own.
 */
export class OutputChannelLogger implements ILogger, vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor(name: string) {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('INFO ', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('WARN ', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('ERROR', message, args);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string, args: unknown[]): void {
    const extra = args.length > 0 ? ` ${args.map((arg) => String(arg)).join(' ')}` : '';
    this.channel.appendLine(`[${new Date().toISOString()}] ${level} ${message}${extra}`);
  }
}
