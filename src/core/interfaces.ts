// SPDX-License-Identifier: AGPL-3.0-only

import type { CredentialResult, LedgerFile, LedgerKind, Millis, UsageSnapshot } from './types';

/**
 * Every abstraction the engine depends on lives here, so `core/` can be
 * constructed entirely from mocks in a terminal test with no VS Code, no
 * network, and no clock of its own.
 */

export interface IDisposable {
  dispose(): void;
}

/** Injected so tests can drive time deterministically. */
export interface IClock {
  now(): Millis;
}

export interface ILogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Deliberately shaped like `vscode.EventEmitter` so the adapter is a thin
 * wrapper, but declared here so `core/` never imports vscode.
 */
export interface IEventBus<T> extends IDisposable {
  event(listener: (e: T) => void): IDisposable;
  fire(e: T): void;
}

/**
 * Reads Claude Code's credential store. There is intentionally no write, no
 * refresh, and no token of our own: the absence of those methods is the
 * guarantee, not a comment promising it.
 */
export interface ICredentialStore {
  read(): Promise<CredentialResult>;
}

/** Throws `PollError` on any failure; never returns a partial snapshot. */
export interface IUsagePoller {
  poll(): Promise<UsageSnapshot>;
}

export interface ILedgerStorage {
  ensureLayout(): Promise<void>;

  /** File names for a kind, lexicographically sorted (which is chronological). */
  list(kind: LedgerKind): Promise<string[]>;

  read(kind: LedgerKind, name: string): Promise<LedgerFile | undefined>;

  /**
   * The oldest file of a kind, or `undefined` when there are none.
   *
   * What the navigation controls clamp against: paging backwards has to stop at
   * the edge of the data rather than running into blank frames indefinitely, and
   * only the directory knows where that edge is. Returns the file rather than an
   * instant because the answer is `startAt`, and `startAt` is read from the
   * header — the name orders the listing, it is never the source.
   */
  oldest(kind: LedgerKind): Promise<LedgerFile | undefined>;

  /**
   * Every file whose window *started* in `[from, to)`, in chronological order.
   *
   * The listing chooses which files to open — see `namesForStartRange` — and the
   * `startAt` in each header decides which are returned. A loose bound costs one
   * extra read and can never produce a wrong answer.
   */
  readRange(kind: LedgerKind, from: Millis, to: Millis): Promise<LedgerFile[]>;

  /**
   * Every file whose window *intersects* `[from, to)`, in chronological order.
   *
   * The wider of the two page queries, and the one a weekly frame needs: a cycle
   * is longer than any frame that shows it, so the files at both edges begin
   * outside the range. See `namesForOverlap`.
   */
  readOverlapping(kind: LedgerKind, from: Millis, to: Millis): Promise<LedgerFile[]>;

  /**
   * Delete files set aside by `read` as corrupt, once they are older than the
   * given instant. Returns how many went.
   *
   * They are invisible to `list` by design — a quarantined name no longer looks
   * like a ledger file — so nothing else would ever clear them.
   */
  sweepQuarantined(olderThan: Millis): Promise<number>;

  /**
   * Read-modify-write under a per-path lock, committed via a temp file and an
   * atomic rename. `seed` builds the file when it does not exist yet; `mutate`
   * edits in place.
   */
  commit(
    kind: LedgerKind,
    name: string,
    seed: () => LedgerFile,
    mutate: (file: LedgerFile) => void,
  ): Promise<LedgerFile>;

  remove(kind: LedgerKind, name: string): Promise<void>;
}
