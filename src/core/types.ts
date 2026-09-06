// SPDX-License-Identifier: AGPL-3.0-only

/** Epoch milliseconds. Every timestamp in this codebase is one of these. */
export type Millis = number;

/**
 * One ledger row: `[t, ...values]`.
 *
 * `t` is the moment the row was observed. For a bookend row it is overwritten in
 * place as idle time passes, which is what lets a flat run cost two rows instead
 * of one per tick. A `null` in every value column marks a dead-zone break.
 */
export type Sample = [Millis, ...(number | null)[]];

export type LedgerKind = 'five_hour' | 'seven_day';

/** Value columns, in order, for each kind of ledger file. `t` is column 0. */
export const SESSION_COLS = ['five_hour'] as const;

/**
 * The weekly columns a file starts with. Only `seven_day` is universal — every
 * paid plan reports it — so it is the only one seeded.
 *
 * Per-model windows are *not* a fixed list. Which ones exist is a property of
 * the plan, and it changes: Pro reports none, Max reports an Opus window, and
 * Anthropic adds and retires model tiers on its own schedule. So the model
 * columns are discovered from the payload and appended per file — see
 * `LedgerFile.cols`.
 */
export const WEEK_BASE_COLS = ['seven_day'] as const;

/**
 * One session (5-hour pool) or one weekly cycle, stored as its own file.
 *
 * `resetAt` lives here rather than on every row: it is constant for the life of
 * the file, and a change in it is precisely what starts a new file.
 */
export interface LedgerFile {
  v: 1;
  kind: LedgerKind;
  startAt: Millis;
  resetAt: Millis;
  /**
   * Column names excluding `t`, matching each row's value slots positionally.
   *
   * **Append-only, for the life of the file.** Alignment is positional, so
   * removing or reordering a column silently re-reads every row already written
   * against the wrong name. Appending cannot: rows written before the column
   * existed are simply shorter, and a missing slot reads as null.
   *
   * That invariant is what makes switching plans mid-cycle safe in both
   * directions. A tier that appears is appended and starts drawing from the first
   * poll that reported it; a tier that goes away keeps its column and stops
   * contributing values. Neither disturbs a column already in the file, so files
   * carrying columns this build does not produce still read correctly.
   */
  cols: string[];
  samples: Sample[];
}

/** One utilization window as reported by the usage endpoint. */
export interface UsageWindow {
  /** Percentage 0-100, or null when the plan has no such window. */
  utilization: number | null;
  resetsAt: Millis | null;
}

/** A normalized poll result. The wire shape is confined to `normalize.ts`. */
export interface UsageSnapshot {
  at: Millis;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  /**
   * The per-model weekly windows the payload carried, keyed by wire name
   * (`seven_day_opus`, `seven_day_fable`, …) and in payload order.
   *
   * A list rather than named fields: the set is plan-dependent and changes over
   * time, and nothing downstream needs to know which tiers these are — only that
   * each has a name to label and a number to plot.
   */
  models: ReadonlyArray<{ key: string; window: UsageWindow }>;
}

/** What `applySample` did, so callers can log and tests can assert intent. */
export type SampleOutcome =
  | { kind: 'anchor' }
  | { kind: 'bookend' }
  | { kind: 'append' }
  | { kind: 'gap+append' }
  /** Every value was null — nothing to plot, and recording it would be
   *  indistinguishable from a dead-zone break row. */
  | { kind: 'skipped' };

/**
 * `stale-token` and `auth-error` look alike and are not.
 *
 * A stale token is the ordinary state of a machine nobody has used for eight
 * hours: Claude Code renews it on its next start, and running its CLI is enough
 * to force that without spending a single inference token. Nothing is wrong, so
 * nothing is reported as wrong.
 *
 * `auth-error` is the endpoint refusing a credential that was locally valid.
 * Refreshing cannot fix that, which is why the two must never share a branch —
 * a refresher wired to this one would spawn a CLI against a revoked login on
 * every tick.
 */
export type PollFailureKind =
  | 'no-credentials'
  | 'stale-token'
  | 'auth-error'
  | 'rate-limited'
  | 'network-error';

export type StatusState = 'ok' | 'mock' | PollFailureKind;

/** Thrown by `IUsagePoller.poll()`. The `kind` maps directly onto a status state. */
export class PollError extends Error {
  constructor(
    readonly kind: PollFailureKind,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PollError';
  }
}

/**
 * Result of reading Claude Code's credential store. We only ever read.
 *
 * `stale` and `signed-out` are both "the access token has expired", separated by
 * the one field that says whether Claude Code can still renew it on its own.
 * The distinction is made here, where the fields are, rather than downstream:
 * only this module knows the skew and the two encodings of an expiry.
 */
export type CredentialResult =
  | { state: 'ok'; token: string; expiresAt: Millis }
  /** Access token expired, refresh token still good — Claude Code will renew. */
  | { state: 'stale'; expiresAt: Millis }
  /** The refresh token has expired as well. Nothing short of signing in helps. */
  | { state: 'signed-out'; expiresAt: Millis }
  | { state: 'missing' }
  | { state: 'malformed'; reason: string };

/** Everything the webview needs that is not a ledger row. */
export interface Meta {
  now: Millis;
  fiveResetAt: Millis | null;
  sevenResetAt: Millis | null;
  tzOffsetMinutes: number;
  mock: boolean;
}

export interface LedgerSnapshot {
  sessions: LedgerFile[];
  weeks: LedgerFile[];
}

/**
 * Identifies one ledger file without carrying it.
 *
 * `kind` and `startAt` together are the file's identity — they are exactly what
 * `toFileName` encodes — so nothing needs to ship the name alongside the file.
 */
export interface LedgerRef {
  kind: LedgerKind;
  startAt: Millis;
}

/**
 * What moved in the ledger since the last publish.
 *
 * A tick writes at most one file per kind, so the ordinary patch is one or two
 * small files rather than the whole ledger. `removed` carries what eviction and
 * the scenario runner's wipe have deleted, and both of them say so themselves:
 * `LedgerCache` holds only the live window, so a removal that is not announced
 * is a removal no panel ever hears about.
 */
export interface LedgerPatch {
  changed: LedgerFile[];
  removed: LedgerRef[];
}

/**
 * Fired on every disk write, whether or not a panel is listening.
 *
 * Deliberately carries a *patch* and the newest file per kind rather than the
 * whole ledger. Both always-on subscribers — the status bar and the meta tracker
 * — read only the newest file of each kind, and a panel hydrates on that and
 * then asks storage for whichever page it wants. So nothing on this path ever
 * assembles the whole ledger, opened dashboard or not.
 */
export interface LedgerUpdatedEvent {
  revision: number;
  patch: LedgerPatch;
  /** The newest file of each kind, which is all the status bar and meta need. */
  newest: Record<LedgerKind, LedgerFile | undefined>;
  meta: Meta;
  outcome: SampleOutcome;
}

export interface StatusEvent {
  state: StatusState;
  message?: string;
  /** When the next attempt is due, while backing off. */
  retryAt?: Millis;
}

/**
 * The host ships two things and nothing else: the window still being written to,
 * and the page the client asked for.
 *
 * `hydrate` carries the live file of each kind — enough to draw the current
 * frame, decide whether the ledger is empty at all, and take the phase the
 * calendar pages by. Every tick after it is a `ledger/patch` naming only what
 * moved, which is the one or two files a poll can touch. History is not pushed:
 * the client asks for a range and gets a `ledger/page` back.
 *
 * Both of those also carry `oldest`, the `startAt` of the first file of a kind.
 * It is the only thing the client cannot work out for itself — it holds one page
 * and one live file, so "is there anything behind this?" is a question about the
 * directory — and it is what the backward controls disable on. Repeated on every
 * page answer rather than sent once, because eviction moves that edge forward
 * under an open panel and a stale clamp is a button that pages into nothing.
 *
 * **`ledger/page` is only ever sent in answer to a `page` request.** The client
 * is the sole owner of which page is on screen; the host stores no offset and
 * never volunteers one. Blur that and a background refresh starts yanking the
 * viewport away from whatever historical page is being read.
 */
export type HostMessage =
  | {
      type: 'hydrate';
      revision: number;
      /** The newest file of each kind; absent means this kind has no files. */
      live: Partial<Record<LedgerKind, LedgerFile>>;
      /** `startAt` of the oldest file of each kind; absent means none exist. */
      oldest: Partial<Record<LedgerKind, Millis>>;
      meta: Meta;
      config: WebviewConfig;
    }
  | { type: 'ledger/patch'; revision: number; patch: LedgerPatch; meta: Meta }
  | {
      type: 'ledger/page';
      requestId: number;
      kind: LedgerKind;
      files: LedgerFile[];
      /** `startAt` of the oldest file of this kind, as of answering. */
      oldest?: Millis;
    }
  | { type: 'status'; state: StatusState; message?: string; retryAt?: Millis };

/**
 * What a page request means, and it is the client's to choose because the two
 * graphs ask genuinely different questions.
 *
 * `starts-in` — the files whose window *began* inside the range. Graph 1 buckets
 * a session by the day it started, so a session running past midnight belongs to
 * the day before.
 *
 * `overlaps` — the files whose window intersects the range. Graph 2 draws a
 * cycle wherever it was being spent, and a weekly cycle straddles both ends of
 * any frame narrower than it.
 */
export type PageMode = 'starts-in' | 'overlaps';

export type ClientMessage =
  | { type: 'ready' }
  | {
      type: 'page';
      /**
       * Echoed back on the answer. The client discards any page whose id is not
       * the one it is currently waiting for, so a slow response for a page the
       * reader has already navigated away from cannot land on screen.
       */
      requestId: number;
      kind: LedgerKind;
      mode: PageMode;
      from: Millis;
      to: Millis;
    }
  | { type: 'series'; hidden: string[] };

export interface WebviewConfig {
  /**
   * The extension's own version, so the panel can say which build is on screen.
   *
   * A prerelease suffix is what marks a build as unreleased, and the panel keys
   * its build stamp off that — `context.extensionMode` cannot, since an
   * installed `-dev` vsix runs as Production like any other.
   */
  version: string;
  /**
   * Series the reader has switched **off**, rather than the ones left on.
   *
   * Storing the complement is what lets the series set be discovered. An
   * allow-list has to name every series that may be drawn, so a tier appearing
   * for the first time would be absent from it and silently hidden on the one
   * poll where the reader most wants to see it. A deny-list defaults new tiers to
   * visible, and stale entries cost nothing but a line in settings.
   */
  hiddenSeries: string[];
}

/** One plotted point. `y: null` breaks the line, which is how gaps render. */
export interface ChartPoint {
  x: Millis;
  y: number | null;
}

export interface ChartSeries {
  key: string;
  label: string;
  points: ChartPoint[];
}

/** A vertical reset wall: where it goes, and what it says. */
export interface ResetMarker {
  at: Millis;
  label: string;
}

/**
 * Graph 1: one local day of 5-hour sessions.
 *
 * `domain` is a pure function of the ledger and the offset, so on a historical
 * page it is identical across refreshes and the viewport cannot drift.
 */
export interface PoolDayView {
  /**
   * True only when the ledger holds no sessions *at all* — the placeholder both
   * graphs show before there is anything to draw.
   *
   * Deliberately not "this page has no data". A day with no sessions still has a
   * frame, a label and a Now line, so it draws blank and says nothing; claiming
   * "no data" there would report an idle day as a missing one.
   */
  empty: boolean;
  dayKey: string;
  label: string;
  domain: [Millis, Millis];
  series: ChartSeries[];
  sessionCount: number;
  /** Each session's reset boundary and its wall label, for Graph 1. */
  resets: ResetMarker[];
}

/** Graph 2: one weekly cycle, flanked by 12-hour buffers. */
export interface CalendarWeekView {
  /**
   * True only when the ledger holds no weeks at all. With even one on record the
   * cycle length is known, so any week — including one still ahead of the newest
   * file — can be framed and labelled and simply drawn without a line. See
   * `PoolDayView.empty`, which carries the same meaning.
   */
  empty: boolean;
  label: string;
  domain: [Millis, Millis];
  /**
   * Where this page's seven-day frame ends — what identifies the page.
   *
   * Aligned to the phase of the newest recorded boundary, then stepped in whole
   * weeks. It is a frame edge, not a claim that a cycle ended here; the walls
   * below are the only thing that claims that.
   */
  resetAt: Millis | null;
  /**
   * The reset walls to draw, read off the ledger rather than off the frame.
   *
   * A wall says "the allowance reset here", which is a measurement, so there is
   * one for each boundary a week file actually recorded inside this frame — none
   * at all for a past week that went unobserved. The single exception is the live
   * page with nothing recorded in it, which projects one and labels it
   * *Expected*, because when the cycle being spent right now ends is worth
   * knowing even unmeasured. The 12-hour buffers are what keeps a wall off the
   * frame edge.
   */
  resets: ResetMarker[];
  series: ChartSeries[];
}
