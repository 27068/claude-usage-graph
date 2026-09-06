// SPDX-License-Identifier: AGPL-3.0-only

import type { Chart } from 'chart.js';
import {
  calendarFrameRange,
  maxDayOffset,
  maxWeekOffset,
  poolAnchor,
  poolDayRange,
  selectCalendarWeek,
  selectPoolDay,
} from '../../core/selectors';
import type {
  ChartSeries,
  ClientMessage,
  HostMessage,
  LedgerFile,
  LedgerKind,
  LedgerPatch,
  LedgerSnapshot,
  Meta,
  Millis,
  PageMode,
} from '../../core/types';
import { applySeries, createChart, nowMarker, resetMarker } from './charts';

interface VsCodeApi {
  postMessage(message: ClientMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

interface PersistedState {
  dayOffset: number;
  weekOffset: number;
  /** Series switched off by the reader. See `WebviewConfig.hiddenSeries`. */
  hiddenSeries: string[];
}

const vscode = acquireVsCodeApi();

/**
 * The webview owns every piece of navigation state. The extension is entirely
 * stateless about paging and never tells us which page to show — it only ships
 * data. That is what stops a background refresh from yanking the viewport away
 * from whichever historical page is being read.
 */
const state = {
  revision: 0,
  // Until the first payload lands we know nothing — which is different from
  // knowing there is nothing. Claiming "No sessions" before then reads as a bug.
  hydrated: false,
  ledger: { sessions: [], weeks: [] } as LedgerSnapshot,
  meta: undefined as Meta | undefined,
  ...restore(),
};

/**
 * What we hold, and it is two different things with two different lifetimes.
 *
 * `page` is the answer to the last page request for that graph — history, which
 * never changes once a window has closed, so it is replaced wholesale and never
 * patched into. `live` is the single window still being written to, which
 * arrives with `hydrate` and is refreshed by every patch.
 *
 * Keeping them apart is what makes the memory and the wire cost independent of
 * how much history the user keeps: the client holds one page and one live file
 * per kind, whether retention is thirty days or a decade.
 *
 * It is also how the client knows the ledger is *empty*, which is a different
 * question from "this page has nothing in it". A quiet day is a blank chart; a
 * ledger with no files at all is the placeholder. No live file, no ledger.
 */
const page: Record<LedgerKind, Map<Millis, LedgerFile>> = {
  five_hour: new Map(),
  seven_day: new Map(),
};
const live: Record<LedgerKind, LedgerFile | undefined> = {
  five_hour: undefined,
  seven_day: undefined,
};

/**
 * The far edge of the ledger: `startAt` of the oldest file of each kind.
 *
 * The one thing about the directory the client cannot see for itself, and the
 * only input the backward controls need. `undefined` means the host says this
 * kind has no files at all, which is the same case as an empty ledger — there is
 * nowhere to page to, so back is disabled and the placeholder is showing anyway.
 */
const oldest: Record<LedgerKind, Millis | undefined> = {
  five_hour: undefined,
  seven_day: undefined,
};

/**
 * How far back each graph may go, in its own units.
 *
 * Recomputed per render rather than stored, because both inputs move: `now`
 * crosses midnight under an open panel, and `oldest` moves forward as eviction
 * runs. A stored limit would be a button that disables itself a day late.
 */
function backLimit(): { day: number; week: number } {
  const now = state.meta?.now ?? Date.now();
  const phase = live.seven_day?.resetAt;
  return {
    day:
      oldest.five_hour === undefined
        ? 0
        : maxDayOffset(poolAnchor(live.five_hour, now), oldest.five_hour),
    week:
      oldest.seven_day === undefined || phase === undefined
        ? 0
        : maxWeekOffset(phase, now, oldest.seven_day),
  };
}

/**
 * Rebuild the arrays the selectors consume, from the page plus the live file.
 *
 * The live file is merged in rather than appended, because it is usually *in*
 * the current page as well — the page is fetched from disk and the patch stream
 * then keeps that same window fresh, so the two agree on identity and the newer
 * copy has to win.
 *
 * Sorted by `resetAt`, which is the order the selectors expect and the order the
 * host reads its own files back in. The sort is over file headers, not samples.
 */
function reproject(): void {
  const order = (kind: LedgerKind): LedgerFile[] => {
    const merged = new Map(page[kind]);
    const current = live[kind];
    if (current !== undefined) {
      merged.set(current.startAt, current);
    }
    return [...merged.values()].sort((a, b) => a.resetAt - b.resetAt);
  };
  state.ledger = { sessions: order('five_hour'), weeks: order('seven_day') };
}

/**
 * Apply one patch.
 *
 * The live slot always takes the newest file of a kind — a poll writes the open
 * window and nothing else, so that is what a patch carries. The page map is
 * updated only for files it already holds, which is what keeps the outgoing
 * window correct when a new one opens: the session that just closed stays in the
 * page with its final samples rather than being frozen at whatever the last
 * patch before the rollover said.
 */
function applyPatch(patch: LedgerPatch): void {
  for (const ref of patch.removed) {
    page[ref.kind].delete(ref.startAt);
    if (live[ref.kind]?.startAt === ref.startAt) {
      live[ref.kind] = undefined;
    }
  }
  for (const file of patch.changed) {
    if (page[file.kind].has(file.startAt)) {
      page[file.kind].set(file.startAt, file);
    }
    const current = live[file.kind];
    if (current === undefined || file.startAt >= current.startAt) {
      live[file.kind] = file;
    }
  }
  reproject();
}

function restore(): PersistedState {
  const saved = vscode.getState();
  return {
    dayOffset: saved?.dayOffset ?? 0,
    weekOffset: saved?.weekOffset ?? 0,
    hiddenSeries: saved?.hiddenSeries ?? [],
  };
}

function persist(): void {
  vscode.setState({
    dayOffset: state.dayOffset,
    weekOffset: state.weekOffset,
    hiddenSeries: state.hiddenSeries,
  });
}

/**
 * The range each graph has asked for, and the request it is waiting on.
 *
 * The host is told which range to send and nothing else — no offset, no page
 * number, nothing it could act on unprompted. Everything about *which* page is
 * on screen stays here, which is the whole reason a background refresh cannot
 * move the viewport.
 */
const requested: Record<LedgerKind, string | undefined> = {
  five_hour: undefined,
  seven_day: undefined,
};
const awaiting: Record<LedgerKind, number> = { five_hour: 0, seven_day: 0 };
let lastRequestId = 0;

function requestPage(kind: LedgerKind, mode: PageMode, from: Millis, to: Millis): void {
  const range = `${from}:${to}`;
  if (requested[kind] === range) {
    return;
  }
  requested[kind] = range;
  lastRequestId += 1;
  awaiting[kind] = lastRequestId;
  vscode.postMessage({ type: 'page', requestId: lastRequestId, kind, mode, from, to });
}

/**
 * Ask for whatever the current offsets need, if it is not already held.
 *
 * Driven from `render` rather than from the click handler, so it covers every
 * way the wanted range can change and not just the obvious one: navigating, yes,
 * but also midnight arriving under an open panel, and the calendar's phase
 * moving when a new cycle's first file lands. Comparing the range rather than
 * the offset is what makes all three the same case.
 *
 * The stale page stays on screen until the answer arrives. At well under a
 * millisecond a page there is nothing to show a spinner for, and blanking the
 * chart first would be the only visible event in the whole exchange.
 */
function ensurePages(now: Millis): void {
  const [from, to] = poolDayRange(poolAnchor(live.five_hour, now), state.dayOffset);
  requestPage('five_hour', 'starts-in', from, to);

  // The phase comes from the newest boundary on record, which is the live file —
  // so before one exists there is no frame to ask about, and nothing to draw.
  const phase = live.seven_day?.resetAt;
  if (phase !== undefined) {
    const [weekFrom, weekTo] = calendarFrameRange(phase, now, state.weekOffset);
    requestPage('seven_day', 'overlaps', weekFrom, weekTo);
  }
}

/**
 * What each stepper moves, in the units its graph pages by.
 *
 * Bigger steps rather than wider frames: a page is still one day on the pool
 * graph and one cycle on the calendar, and there is no zoom. The alternative was
 * 52 clicks of the week button to cross a year, which is what made longer
 * retention unreachable through the UI whatever storage did about the reading.
 *
 * A month is 30 days and 4 cycles rather than a calendar month, because both
 * offsets *are* counts of pages — a calendar month would have to be resolved
 * against a date and would land on a different page depending on where you
 * started. The tooltips say the real number so nothing is implied that is not
 * true.
 */
const NAV_STEPS: Record<string, { days?: number; weeks?: number }> = {
  'pool-year-back': { days: 365 },
  'pool-month-back': { days: 30 },
  'pool-week-back': { days: 7 },
  'pool-day-back': { days: 1 },
  'pool-day-fwd': { days: -1 },
  'pool-week-fwd': { days: -7 },
  'pool-month-fwd': { days: -30 },
  'pool-year-fwd': { days: -365 },
  'calendar-year-back': { weeks: 52 },
  'calendar-month-back': { weeks: 4 },
  'calendar-week-back': { weeks: 1 },
  'calendar-week-fwd': { weeks: -1 },
  'calendar-month-fwd': { weeks: -4 },
  'calendar-year-fwd': { weeks: -52 },
};

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Nav buttons are addressed by `data-nav`, not by id — the same attribute the
 * click delegate switches on, so there is only ever one name for a button.
 */
const navButton = (nav: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`[data-nav="${nav}"]`) as HTMLButtonElement;

const poolChart: Chart<'line', Array<{ x: number; y: number | null }>> = createChart(
  element<HTMLCanvasElement>('pool-canvas'),
  'pool',
);
const calendarChart: Chart<'line', Array<{ x: number; y: number | null }>> = createChart(
  element<HTMLCanvasElement>('calendar-canvas'),
  'calendar',
);

function render(): void {
  const now = state.meta?.now ?? Date.now();
  // A held offset can fall outside the ledger without anyone clicking: a page
  // restored from `getState` may predate an eviction, and the limits move on
  // their own as history is dropped. Pulled back before the range is computed,
  // so the page asked for is the page that will be drawn.
  const limit = backLimit();
  state.dayOffset = clamp(state.dayOffset, limit.day);
  state.weekOffset = clamp(state.weekOffset, limit.week);
  ensurePages(now);

  const pool = selectPoolDay(
    state.ledger.sessions,
    poolAnchor(live.five_hour, now),
    now,
    state.dayOffset,
  );
  element('pool-label').textContent = pool.label;
  element('pool-empty').hidden = !(state.hydrated && pool.empty);
  setMarkers(poolChart, [
    ...pool.resets.map((reset) => resetMarker(reset.at, reset.label)),
    ...(state.dayOffset === 0 ? [nowMarker(now)] : []),
  ]);
  // Domain first: applySeries thins the points against the viewport, so it has
  // to see the domain this frame will actually draw, not the last one's.
  setDomain(poolChart, pool.domain);
  applySeries(poolChart, pool.series, undefined);
  poolChart.update('none');

  const calendar = selectCalendarWeek(state.ledger.weeks, now, state.weekOffset);
  element('calendar-label').textContent = calendar.label;
  element('calendar-empty').hidden = !(state.hydrated && calendar.empty);
  const markers = calendar.resets.map((reset) => resetMarker(reset.at, reset.label));
  if (state.weekOffset === 0) {
    markers.push(nowMarker(now));
  }
  setMarkers(calendarChart, markers);
  setDomain(calendarChart, calendar.domain);
  applySeries(
    calendarChart,
    calendar.series,
    calendar.series.map((entry) => entry.key).filter((key) => !state.hiddenSeries.includes(key)),
  );
  calendarChart.update('none');

  updateNavButtons();
  updateToggles(calendar.series);
}

/**
 * The domain is a pure function of (ledger, offset). On a historical page it
 * comes back identical every refresh, so assigning it here is a no-op and the
 * viewport holds still. Only offset 0 moves, which is the live window.
 */
function setDomain(
  chart: Chart<'line', Array<{ x: number; y: number | null }>>,
  [from, to]: [number, number],
): void {
  const scale = chart.options.scales?.x as { min?: number; max?: number } | undefined;
  if (scale) {
    scale.min = from;
    scale.max = to;
  }
}

function setMarkers(
  chart: Chart<'line', Array<{ x: number; y: number | null }>>,
  lines: ReturnType<typeof nowMarker>[],
): void {
  const plugins = chart.options.plugins as Record<string, unknown>;
  plugins['verticalMarkers'] = { lines };
}

/**
 * Grey out what would do nothing.
 *
 * The backward half is the half that is new, and it is the visible form of the
 * clamp: at the oldest page every back button goes dead, which is how the reader
 * learns the ledger has ended rather than by paging through blank frames looking
 * for data that was evicted months ago.
 */
function updateNavButtons(): void {
  const limit = backLimit();
  const atOldestDay = state.dayOffset >= limit.day;
  const atOldestWeek = state.weekOffset >= limit.week;

  for (const nav of ['pool-day-fwd', 'pool-week-fwd', 'pool-month-fwd', 'pool-year-fwd']) {
    navButton(nav).disabled = state.dayOffset <= 0;
  }
  for (const nav of ['pool-day-back', 'pool-week-back', 'pool-month-back', 'pool-year-back']) {
    navButton(nav).disabled = atOldestDay;
  }
  navButton('pool-today').disabled = state.dayOffset === 0;

  for (const nav of ['calendar-week-fwd', 'calendar-month-fwd', 'calendar-year-fwd']) {
    navButton(nav).disabled = state.weekOffset <= 0;
  }
  for (const nav of ['calendar-week-back', 'calendar-month-back', 'calendar-year-back']) {
    navButton(nav).disabled = atOldestWeek;
  }
  navButton('calendar-now').disabled = state.weekOffset === 0;
}

/**
 * Rebuild the toggle row from the series the current frame actually has.
 *
 * Built here rather than served in the shell because the set is discovered, not
 * fixed — see `renderDashboardHtml`. Creating the elements also sidesteps
 * Chromium's form restoration, which resets served controls to their markup
 * default after the page script runs: a node this script creates has no such
 * default to be restored to.
 *
 * Rewritten only when the set of keys changes. A rebuild on every render would
 * discard the element under the reader's cursor mid-click on any frame that
 * refreshes while the pointer is down, and the weekly chart refreshes on a
 * three-minute timer.
 */
let toggleKeys = '';

function updateToggles(series: readonly ChartSeries[]): void {
  const container = element('series-toggles');
  const keys = series.map((entry) => entry.key);
  const signature = keys.join('|');

  if (signature !== toggleKeys) {
    toggleKeys = signature;
    container.textContent = '';
    for (const entry of series) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.series = entry.key;
      label.append(input, ` ${entry.label}`);
      container.append(label);
    }
  }

  syncToggleChecks();
}

/** Tick each box to match `hiddenSeries`, without disturbing the elements. */
function syncToggleChecks(): void {
  const inputs = element('series-toggles').querySelectorAll<HTMLInputElement>('[data-series]');
  for (const input of Array.from(inputs)) {
    input.checked = !state.hiddenSeries.includes(input.dataset.series ?? '');
  }
}

/**
 * Move a graph, and never past either end of the ledger.
 *
 * Clamped in both directions: offset 0 is the live page and there is nothing
 * after it, and the oldest file is the far edge — past which the reader would
 * page into blank frames with nothing on screen to say the data had stopped.
 *
 * Clamping rather than refusing is what makes the big steps land well: from
 * today, with forty days on record, the `Y` step goes to the oldest page rather
 * than nowhere.
 */
function navigate(deltaDays: number, deltaWeeks: number, absolute?: 'pool' | 'calendar'): void {
  if (absolute === 'pool') {
    state.dayOffset = 0;
  } else if (absolute === 'calendar') {
    state.weekOffset = 0;
  } else {
    const limit = backLimit();
    state.dayOffset = clamp(state.dayOffset + deltaDays, limit.day);
    state.weekOffset = clamp(state.weekOffset + deltaWeeks, limit.week);
  }
  persist();
  render();
}

const clamp = (offset: number, limit: number): number => Math.min(Math.max(0, offset), limit);

document.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-nav]');
  if (!target) {
    return;
  }
  const nav = target.dataset.nav;
  if (nav === 'pool-today') {
    navigate(0, 0, 'pool');
    return;
  }
  if (nav === 'calendar-now') {
    navigate(0, 0, 'calendar');
    return;
  }
  const step = NAV_STEPS[nav ?? ''];
  if (step !== undefined) {
    navigate(step.days ?? 0, step.weeks ?? 0);
  }
});

document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement;
  const key = input.dataset.series;
  if (key === undefined) {
    return;
  }
  state.hiddenSeries = input.checked
    ? state.hiddenSeries.filter((candidate) => candidate !== key)
    : [...new Set([...state.hiddenSeries, key])];
  vscode.setState({
    dayOffset: state.dayOffset,
    weekOffset: state.weekOffset,
    hiddenSeries: state.hiddenSeries,
  });
  vscode.postMessage({ type: 'series', hidden: state.hiddenSeries });
  render();
});

/** Injected by `scripts/build-webview.mjs` at bundle time. */
declare const __BUILD_TIME__: string;

/**
 * Name the build on screen, but only for an unreleased one.
 *
 * A prerelease suffix is the signal: a Marketplace build is a plain `x.y.z` and
 * shows nothing. `extensionMode` cannot serve here, since an installed `-dev`
 * vsix runs as Production exactly like a published one.
 *
 * The time is when the *bundle* was built, which is what makes it worth
 * printing: it goes stale the moment a compile is skipped, where a version
 * number or an install date would both still look current.
 *
 * Showing it unconditionally would put a timestamp in front of every published
 * reader to cover a case they do not have. A release is verified against a
 * version freshly bumped and never installed before, so the version itself
 * identifies that build; the stamp is only needed across a dev cycle, where the
 * version stays put from one build to the next.
 */
function showBuild(version: string): void {
  const footer = element('build');
  const unreleased = version.includes('-');

  footer.hidden = !unreleased;
  if (unreleased) {
    footer.textContent = `${version} · built ${new Date(__BUILD_TIME__).toLocaleString()}`;
  }
}

function showStatus(message: HostMessage & { type: 'status' }): void {
  const banner = element('status');
  const friendly: Record<string, string> = {
    ok: '',
    mock: 'Showing synthetic development data.',
    'no-credentials': 'Claude Code credentials not found. Run `claude` in a terminal and sign in.',
    'stale-token': 'Renewing the Claude Code access token.',
    'auth-error': 'Anthropic refused the Claude Code credential.',
    'rate-limited': 'Anthropic is rate limiting requests; backing off.',
    'network-error': 'Could not reach Anthropic.',
  };

  const text = message.message ?? friendly[message.state] ?? '';
  const hidden = message.state === 'ok' || text.length === 0;
  banner.hidden = hidden;
  banner.textContent = text;
  banner.className = `status status-${message.state}`;
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;

  switch (message.type) {
    case 'hydrate':
    case 'ledger/patch': {
      // Out-of-order or duplicated delivery must never rewind the chart. A
      // hydrate is exempt: it is a complete payload answering this panel's own
      // request, and it carries the engine's current revision rather than a
      // newer one, so testing it against the sequence would discard it.
      //
      // Dropping a patch is safe only because of that exemption. A patch is a
      // difference, so skipping one would ordinarily leave a permanent hole —
      // but the only patches that can arrive before a hydrate are ones the
      // hydrate itself already contains, since the host builds it from the cache
      // those writes have already landed in.
      if (message.type === 'ledger/patch' && message.revision <= state.revision) {
        return;
      }
      state.revision = message.revision;
      state.hydrated = true;
      state.meta = message.meta;
      if (message.type === 'hydrate') {
        live.five_hour = message.live.five_hour;
        live.seven_day = message.live.seven_day;
        oldest.five_hour = message.oldest.five_hour;
        oldest.seven_day = message.oldest.seven_day;
        reproject();
        // Authoritative, empty included — and empty is now the ordinary case,
        // meaning "nothing switched off" rather than "nothing to draw".
        state.hiddenSeries = message.config.hiddenSeries;
        showBuild(message.config.version);
      } else {
        applyPatch(message.patch);
      }
      render();
      break;
    }
    case 'ledger/page': {
      // Answers arrive in whatever order the host finishes them, and a reader
      // clicking through pages can leave several in flight. Only the newest
      // request for a graph may land: an older answer is not stale data to be
      // merged, it is a different page, and drawing it would move the viewport
      // off the page the reader chose.
      if (message.requestId !== awaiting[message.kind]) {
        return;
      }
      page[message.kind] = new Map(message.files.map((file) => [file.startAt, file]));
      // Refreshed with every answer, so the back buttons follow eviction rather
      // than staying on whatever the panel was told when it opened.
      oldest[message.kind] = message.oldest;
      reproject();
      render();
      break;
    }
    case 'status':
      showStatus(message);
      break;
    default:
      break;
  }
});

// Chromium restores form-control state on a webview reload, and it does so
// *after* this script runs — quietly undoing every `input.checked` we just set.
// `pageshow` fires after that restore, so this is the last word on the toggles.
//
// Building the boxes in script rather than serving them ought to make this moot:
// restoration matches controls parsed from the markup, and these are not. Kept
// because it costs one pass over a handful of checkboxes, and because the shell
// having *no* toggles in it now means a regression here would be silent — the
// row would simply come back all-ticked and start drawing hidden series again.
window.addEventListener('pageshow', syncToggleChecks);

// Restore the saved page *before* asking for data, so the first frame lands on
// the page the reader left rather than snapping to today and then jumping back.
render();
vscode.postMessage({ type: 'ready' });
