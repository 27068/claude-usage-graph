// SPDX-License-Identifier: AGPL-3.0-only

import type { LedgerFile, Millis, StatusEvent } from './types';
import { POLL_INTERVAL_MS } from './usageEngine';

/**
 * What the status bar should say, decided with no reference to VS Code.
 *
 * This lives in core because it holds the only judgement the status bar makes —
 * which reading has gone stale, which state outranks which, how a countdown is
 * worded — and the adapter wrapped around it cannot be unit tested at all: it
 * imports `vscode`, and the terminal suite has no such module to load. Splitting
 * the decision out is what makes the half worth testing testable, and leaves
 * `src/vscode/statusBar.ts` as assignment statements.
 */

const MINUTE_MS = 60_000;

/** Middle dot. Escaped so no editing tool can mangle it without failing loudly. */
const SEPARATOR = ' · ';

/**
 * What both authentication tooltips promise, and why they can promise it.
 *
 * The credential is re-read on every poll and a missing or expired one costs no
 * network call, so `usageEngine.handleFailure` deliberately does *not* back off
 * for either state — the cadence stays flat and the next tick is at most one
 * interval away. That bound is the whole message: without it the reader is told
 * to sign in and then left with no idea whether to wait or to go looking for a
 * button.
 *
 * Rounded up, because a ceiling that overstates the wait by seconds is honest
 * and one that understates it is not. Saying "no reload needed" is worth the
 * words: the previous wording told people to reload, which does nothing a tick
 * would not have done on its own a moment later.
 */
const RESUME_PHRASE = `Tracking resumes on its own within ${Math.ceil(
  POLL_INTERVAL_MS / MINUTE_MS,
)} minutes — no reload needed.`;

export interface StatusBarModel {
  /** Codicon id. The adapter wraps it in the `$(...)` the status bar expects. */
  icon: string;
  label: string;
  tooltip: string;
  /** Mapped onto a ThemeColor by the adapter; core has no colours of its own. */
  severity: 'none' | 'warning' | 'error';
}

export interface StatusBarInputs {
  status: StatusEvent;
  now: Millis;
  /** Last value recorded, whether or not the window it describes is still open. */
  five: number | null;
  seven: number | null;
  /**
   * Null once the window has closed — see `usageEngine.openReset`, which
   * discards a boundary that has passed. For the five-hour pool that is not a
   * missing reading but a positive one: there is no window.
   */
  fiveResetAt: Millis | null;
  sevenResetAt: Millis | null;
}

export function statusBarModel(inputs: StatusBarInputs): StatusBarModel {
  const { status, now } = inputs;

  switch (status.state) {
    case 'ok':
    case 'mock': {
      // A five-hour pool exists only while a session is open. Once the window
      // has closed the newest file's last sample describes a pool that is gone,
      // so the percentage has to go with the countdown — left in place it sits
      // there looking live, and the only hint that it is stale would be a
      // countdown that quietly vanished from beside it.
      //
      // `idle` rather than a dash, because a dash already means "no reading" and
      // this is the opposite: the reading is that there is no window. It is also
      // the actionable state — the next message opens a fresh pool, and the
      // reader gets to choose when those five hours start.
      const open = inputs.fiveResetAt !== null;
      const five = open
        ? `${percent(inputs.five)}${remaining(inputs.fiveResetAt, now)}`
        : 'idle';
      const seven = `${percent(inputs.seven)}${remaining(inputs.sevenResetAt, now)}`;

      return {
        icon: 'graph-line',
        label: `${five}${SEPARATOR}${seven}`,
        // The bar itself does not say which number is which, so the tooltip
        // carries the labels and the wall-clock times the countdowns hide.
        tooltip:
          status.state === 'mock'
            ? 'Synthetic development data'
            : [
                open
                  ? `Session Usage: ${percent(inputs.five)}${resetPhrase(inputs.fiveResetAt)}`
                  : 'Session Usage: no active session; your next message opens a new 5-hour window',
                `Weekly Usage: ${percent(inputs.seven)}${resetPhrase(inputs.sevenResetAt)}`,
                'Click to open the dashboard',
              ].join('\n'),
        severity: 'none',
      };
    }

    case 'no-credentials':
      return {
        icon: 'warning',
        label: 'Claude: not signed in',
        tooltip: `Run \`claude\` in a terminal and sign in.\n${RESUME_PHRASE}`,
        severity: 'warning',
      };

    case 'auth-error':
      return {
        icon: 'error',
        label: 'Claude: session expired',
        tooltip: `The Claude Code session token has expired. Run \`claude\` to sign in again.\n${RESUME_PHRASE}`,
        severity: 'error',
      };

    case 'rate-limited':
      return {
        icon: 'clock',
        label: 'Claude: throttled',
        tooltip:
          status.retryAt === undefined
            ? 'Backing off after a rate limit.'
            : `Backing off; next attempt around ${new Date(status.retryAt).toLocaleTimeString()}`,
        severity: 'warning',
      };

    default:
      return {
        icon: 'cloud-offline',
        label: 'Claude: offline',
        tooltip: status.message ?? 'Could not reach Anthropic.',
        severity: 'none',
      };
  }
}

/**
 * The most recent numeric reading in a column, skipping the nulls that mark a
 * dead zone. Kept here beside its only caller rather than in `selectors.ts`,
 * which reads whole series rather than single values.
 */
export function lastValue(file: LedgerFile | undefined, column: number): number | null {
  const samples = file?.samples;
  if (samples === undefined) {
    return null;
  }
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const value = samples[index][column + 1];
    if (typeof value === 'number') {
      return value;
    }
  }
  return null;
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)}%`;
}

/** The countdown, with its leading space — or nothing at all when unknown. */
function remaining(resetAt: Millis | null, now: Millis): string {
  if (resetAt === null) {
    return '';
  }
  return ` ${formatRemaining(resetAt - now)}`;
}

/**
 * A countdown short enough to sit in a status bar.
 *
 * `2h 41m` up to a day, then `1d 16h` — the minute is noise once the wait is
 * measured in days, and dropping it keeps the field from growing. Truncating
 * rather than rounding means the figure never claims more time than is left.
 */
export function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  const days = Math.floor(minutes / (24 * 60));
  if (days >= 1) {
    return `${days}d ${Math.floor((minutes % (24 * 60)) / 60)}h`;
  }
  const hours = Math.floor(minutes / 60);
  return hours >= 1 ? `${hours}h ${minutes % 60}m` : `${minutes % 60}m`;
}

function resetPhrase(resetAt: Millis | null): string {
  return resetAt === null ? '' : `, resets ${new Date(resetAt).toLocaleString()}`;
}
