// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type {
  IClock,
  IDisposable,
  IEventBus,
  ILogger,
  IUsagePoller,
} from '../../core/interfaces';
import type { ILedgerStorage } from '../../core/interfaces';
import type {
  LedgerFile,
  LedgerKind,
  LedgerSnapshot,
  Millis,
  UsageSnapshot,
} from '../../core/types';
import { SESSION_COLS, WEEK_BASE_COLS } from '../../core/types';

/**
 * A week header for tests that exercise column mechanics.
 *
 * Named explicitly rather than borrowed from production, which has no fixed
 * list: a file records whichever tiers its plan reported while it was open, so a
 * test that needs several columns has to say which several. These are what a
 * file seeded by an older build carries, `extra_usage` included — the realistic
 * case for reading old history back through the current code.
 */
export const WEEK_FIXTURE_COLS = [
  'seven_day',
  'seven_day_sonnet',
  'seven_day_opus',
  'extra_usage',
] as const;

export class FakeClock implements IClock {
  constructor(private current: Millis) {}

  now(): Millis {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(at: Millis): void {
    this.current = at;
  }
}

export class RecordingLogger implements ILogger {
  readonly infos: string[] = [];
  readonly warns: string[] = [];
  readonly errors: string[] = [];

  info(message: string): void {
    this.infos.push(message);
  }

  warn(message: string): void {
    this.warns.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

/** A plain in-process bus, standing in for the vscode.EventEmitter adapter. */
export class SimpleEventBus<T> implements IEventBus<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly received: T[] = [];

  event(listener: (e: T) => void): IDisposable {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((candidate) => candidate !== listener);
      },
    };
  }

  fire(e: T): void {
    this.received.push(e);
    for (const listener of [...this.listeners]) {
      listener(e);
    }
  }

  dispose(): void {
    this.listeners = [];
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

/** Replays a scripted sequence of snapshots, or throws a scripted error. */
export class StubPoller implements IUsagePoller {
  calls = 0;
  private queue: Array<UsageSnapshot | Error> = [];

  constructor(private fallback?: UsageSnapshot | Error) {}

  push(...items: Array<UsageSnapshot | Error>): this {
    this.queue.push(...items);
    return this;
  }

  async poll(): Promise<UsageSnapshot> {
    this.calls += 1;
    const next = this.queue.shift() ?? this.fallback;
    if (next === undefined) {
      throw new Error('StubPoller has nothing left to return');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

export function snapshotAt(
  at: Millis,
  options: {
    five?: number | null;
    fiveReset?: Millis | null;
    seven?: number | null;
    sevenReset?: Millis | null;
    /** Per-model weekly windows, keyed by wire name, as `normalize` finds them. */
    models?: Record<string, number | null>;
  } = {},
): UsageSnapshot {
  return {
    at,
    fiveHour: { utilization: options.five ?? 10, resetsAt: options.fiveReset ?? at + 3_600_000 },
    sevenDay: { utilization: options.seven ?? 20, resetsAt: options.sevenReset ?? at + 86_400_000 },
    models: Object.entries(options.models ?? {}).map(([key, utilization]) => ({
      key,
      window: { utilization, resetsAt: null },
    })),
  };
}

export async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'claude-usage-graph-'));
}

export async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export function makeLedgerFile(kind: LedgerKind, startAt: Millis, resetAt: Millis): LedgerFile {
  return {
    v: 1,
    kind,
    startAt,
    resetAt,
    cols: kind === 'five_hour' ? [...SESSION_COLS] : [...WEEK_BASE_COLS],
    samples: [],
  };
}

/**
 * The whole ledger, read off disk and ordered the way the selectors want it.
 *
 * `LedgerCache` holds only the live window, so an assertion about what a run
 * built up has to go to storage instead. Tests are the only caller and the only
 * place this is wanted; production reads a page, never the lot.
 */
export async function readLedger(storage: ILedgerStorage): Promise<LedgerSnapshot> {
  const ofKind = async (kind: LedgerKind): Promise<LedgerFile[]> => {
    const files: LedgerFile[] = [];
    for (const name of await storage.list(kind)) {
      const file = await storage.read(kind, name);
      if (file !== undefined) {
        files.push(file);
      }
    }
    return files.sort((a, b) => a.resetAt - b.resetAt);
  };
  return { sessions: await ofKind('five_hour'), weeks: await ofKind('seven_day') };
}
