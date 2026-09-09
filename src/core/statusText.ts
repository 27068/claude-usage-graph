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
 * What a column shows with nothing behind it. Named because two callers need to
 * agree on it: `percent` reaches it from a missing value, and the weekly column
 * reaches it from a boundary that has passed.
 */
const NO_READING = '—';

/**
 * What the authentication tooltips promise, and why they can promise it.
 *
 * The credential is re-read on every poll and a missing, stale or dead one costs
 * no network call, so `usageEngine.handleFailure` deliberately does *not* back
 * off for any of those states — the cadence stays flat and the next tick is at
 * most one interval away. That bound is the whole message: without it the reader
 * is told to sign in and then left with no idea whether to wait or to go looking
 * for a button.
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
  /**
   * Whether a poll actually found no five-hour window, as opposed to our never
   * having looked. Read only when `fiveResetAt` is null, and the difference
   * between saying `idle` and admitting to a dash.
   */
  fiveIdleObserved: boolean;
}

export function statusBarModel(inputs: StatusBarInputs): StatusBarModel {
  const { status, now } = inputs;

  switch (status.state) {
    case 'ok':
    case 'mock': {
      // A five-hour pool exists only while a session is open, so this column has
      // three states rather than two. Either way the percentage cannot outlive
      // the window: the newest file's last sample describes a pool that is gone,
      // so it goes with the countdown — left in place it sits there looking
      // live, and the only hint that it is stale would be a countdown that
      // quietly vanished from beside it.
      //
      // `idle` is a reading, not the lack of one, which is what earns it a word
      // where a dash would say the opposite. It is also the actionable state —
      // the next message opens a fresh pool, and the reader gets to choose when
      // those five hours start. So it is spent only on the evidence that backs
      // it: a poll that came back with no five-hour window at all. Absent that
      // evidence the honest reading is the dash, because before the first poll
      // lands there is nothing to distinguish a closed pool from an open one we
      // have not looked at.
      const open = inputs.fiveResetAt !== null;
      const idle = !open && inputs.fiveIdleObserved;
      const five = open
        ? `${percent(inputs.five)}${remaining(inputs.fiveResetAt, now)}`
        : idle
          ? 'idle'
          : NO_READING;
      const fiveTooltip = open
        ? `Session Usage: ${percent(inputs.five)}${resetPhrase(inputs.fiveResetAt)}`
        : idle
          ? 'Session Usage: no active session; your next message opens a new 5-hour window'
          : 'Session Usage: no reading yet; the next poll reports the current session';

      // A weekly allowance runs whether or not anyone is working, so it has no
      // `idle` counterpart: a null boundary here does not mean the window is
      // gone, it means the week we recorded has ended and no poll has yet named
      // its successor. Both readings we could show are wrong — the old week's
      // percentage measures an allowance that no longer exists, and the new
      // week's is unobserved, so zero would be inventing a measurement rather
      // than showing one. The dash already means "no reading", which is exactly
      // the state, and the next poll replaces it.
      const weekKnown = inputs.sevenResetAt !== null;
      const sevenPercent = weekKnown ? percent(inputs.seven) : NO_READING;
      const seven = `${sevenPercent}${remaining(inputs.sevenResetAt, now)}`;

      return {
        icon: 'graph-line',
        label: `${five}${SEPARATOR}${seven}`,
        // The bar itself does not say which number is which, so the tooltip
        // carries the labels and the wall-clock times the countdowns hide.
        tooltip:
          status.state === 'mock'
            ? 'Synthetic development data'
            : [
                fiveTooltip,
                weekKnown
                  ? `Weekly Usage: ${sevenPercent}${resetPhrase(inputs.sevenResetAt)}`
                  : 'Weekly Usage: no reading yet; the next poll reports the current week',
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

    // Signed in, with the credential in a store this cannot read — Windows
    // Credential Manager, reached through an API no Node process has.
    //
    // The only state that offers no action, and it must not borrow one from the
    // states either side. Signing in and using Claude Code both write back to
    // the same store, so either instruction would send somebody round a loop
    // that cannot terminate. It also cannot claim the login is healthy: the
    // expiry is inside the credential nobody here can read. So it says what is
    // established, which is that the figures are unavailable and why.
    case 'unreadable-store':
      return {
        icon: 'circle-slash',
        label: 'Claude: usage unavailable',
        tooltip:
          'Claude Code stores its credential where this extension cannot read it, so usage cannot be tracked on this machine.\n' +
          'Signing in again will not change that — a renewed token goes to the same place.',
        severity: 'none',
      };

    // Raised by the engine only while a redemption is actually in flight, so the
    // bound is seconds. It is never a resting state: the poll that follows
    // replaces it either way.
    case 'renewing':
      return {
        icon: 'sync~spin',
        label: 'Claude: renewing',
        tooltip: 'The Claude Code access token expired. Renewing it now.',
        severity: 'none',
      };

    // A redemption was refused within the last half hour, so this is the one
    // expiry that is not merely a wait. It earns a colour for that reason and
    // for one more: where renewal works, the state below is unreachable, so
    // without this the only difference between "renewal is broken" and "nothing
    // has happened yet" would be a line in a log nobody opens.
    //
    // Still not an error. The credential is untouched, the login is fine, and
    // using Claude Code fixes it — the warning is about our renewal, not theirs.
    case 'renewal-failed':
      return {
        icon: 'warning',
        label: 'Claude: renewal failed',
        tooltip:
          'The Claude Code access token expired and could not be renewed.\n' +
          'Your login is fine, and using Claude Code renews it.\n' +
          'The reason is in the Claude Usage Graph output channel.',
        severity: 'warning',
      };

    // An access token lasts eight hours, so this is what a machine looks like
    // after a night off. Nothing is wrong and nobody needs to sign in, which is
    // why it carries no severity.
    //
    // Reached when no renewal is coming: either one was tried and failed, or the
    // credential is in a store this cannot write, which is macOS. So it must not
    // promise a number of minutes — a machine left alone sits here until Claude
    // Code is used, and naming a bound that never arrives is worse than naming
    // none.
    case 'stale-token':
      return {
        icon: 'sync',
        label: 'Claude: token expired',
        tooltip:
          'The Claude Code access token has expired.\n' +
          'Tracking resumes the next time you use Claude Code, which renews it.',
        severity: 'none',
      };

    // The endpoint refused a credential that had *not* expired. Renewing cannot
    // help, which is what separates this from the case above and why it keeps
    // the error colour.
    case 'auth-error':
      return {
        icon: 'error',
        label: 'Claude: rejected',
        tooltip: status.message ?? 'Anthropic refused the Claude Code credential.',
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
  return value === null ? NO_READING : `${Math.round(value)}%`;
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
