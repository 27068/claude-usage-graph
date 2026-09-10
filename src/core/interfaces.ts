// SPDX-License-Identifier: AGPL-3.0-only

import type {
  CredentialResult,
  LedgerFile,
  LedgerKind,
  Millis,
  RefreshOutcome,
  UsageSnapshot,
} from './types';

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
 * Reads Claude Code's credential store. Separate from the refresher below, and
 * kept that way: the read path is on every poll and can never write, so no
 * ordinary tick can disturb a login.
 */
export interface ICredentialStore {
  read(): Promise<CredentialResult>;
}

/**
 * Renews the access token in Claude Code's credential store.
 *
 * It is not free of consequence, and the consequence is the whole design. A
 * renewal may rotate the refresh token, so a copy of the credential taken
 * beforehand is dead the moment this returns, and an implementation that
 * redeems a grant without durably storing what comes back signs the user out.
 * Nothing here keeps such a copy, and nothing should.
 */
export interface ICredentialRefresher {
  /**
   * Redeem the refresh token once. Never throws.
   *
   * Says what happened rather than whether it worked, because the caller has to
   * decide between coming back in fifteen seconds and coming back in half an
   * hour, and only this end can tell those apart.
   */
  refresh(): Promise<RefreshOutcome>;
}

/**
 * Keeps the access token alive on its own clock.
 *
 * Deliberately not the engine's job. The two run on unrelated schedules — one
 * paces requests to a usage endpoint, the other counts down to a token expiry —
 * and an earlier design that shared a deadline between them made every retry
 * cost a usage request and put the ladder in a fight with the poll backoff.
 *
 * So this owns a timer, sleeps most of the day, and publishes no status. The
 * engine only ever asks it a question.
 */
export interface ITokenRenewer extends IDisposable {
  /**
   * Begin. `onRenewed` fires after a renewal lands, so a poll blocked on the
   * old token does not have to wait out its interval to notice.
   */
  start(onRenewed: () => void): void;

  /**
   * Whether the last attempt was refused.
   *
   * The engine asks when a poll comes back on an expired token, because an
   * expiry nobody was renewing and one a renewal was refused for are a wait and
   * a fault, and they must not share a colour.
   */
  isFailing(): boolean;

  /**
   * Check in from the poll tick.
   *
   * Renewal is invisible from outside: it can stop while polling carries on and
   * nothing on screen would say so. This re-arms a timer that has been lost and
   * does no renewal work of its own, the same way the engine hands the evictor a
   * pass without waiting on it.
   */
  nudge(): void;
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
