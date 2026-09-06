// SPDX-License-Identifier: AGPL-3.0-only

import * as vscode from 'vscode';

/**
 * The webview shell.
 *
 * The CSP is deliberately total: `default-src 'none'`, scripts only via a
 * per-load nonce, and every asset served from the extension's own `media`
 * directory. Nothing is fetched from a CDN, which is also why Chart.js is
 * bundled into `dashboard.js` rather than pulled at runtime.
 *
 * The series toggles are **not** baked in here: the container below ships empty
 * and the client fills it. Which series exist is discovered from the ledger, so
 * the host would have to guess at the plan's shape to name them while rendering
 * the shell. Building them in script also sidesteps Chromium's form restoration
 * — see `updateToggles` in the client.
 */
export function renderDashboardHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
  const nonce = createNonce();
  const asset = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', ...parts));

  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('dashboard.css')}">
<title>Claude Usage Graph</title>
</head>
<body>
<div id="status" class="status" hidden></div>

<section class="panel">
  <header class="panel-head">
    <h2>Session Usage</h2>
    <div class="nav">
      <div class="nav-group">
        <button type="button" data-nav="pool-year-back" title="Back 365 days" aria-label="Back 365 days"><span class="nav-arrow">&#9664;</span>Y</button>
        <button type="button" data-nav="pool-month-back" title="Back 30 days" aria-label="Back 30 days"><span class="nav-arrow">&#9664;</span>M</button>
        <button type="button" data-nav="pool-week-back" title="Back 7 days" aria-label="Back 7 days"><span class="nav-arrow">&#9664;</span>W</button>
        <button type="button" data-nav="pool-day-back" title="Back one day" aria-label="Back one day"><span class="nav-arrow">&#9664;</span>D</button>
      </div>
      <span id="pool-label" class="date-label"></span>
      <div class="nav-group">
        <button type="button" data-nav="pool-day-fwd" title="Forward one day" aria-label="Forward one day">D<span class="nav-arrow">&#9654;</span></button>
        <button type="button" data-nav="pool-week-fwd" title="Forward 7 days" aria-label="Forward 7 days">W<span class="nav-arrow">&#9654;</span></button>
        <button type="button" data-nav="pool-month-fwd" title="Forward 30 days" aria-label="Forward 30 days">M<span class="nav-arrow">&#9654;</span></button>
        <button type="button" data-nav="pool-year-fwd" title="Forward 365 days" aria-label="Forward 365 days">Y<span class="nav-arrow">&#9654;</span></button>
      </div>
      <button type="button" data-nav="pool-today" class="primary">Today</button>
    </div>
  </header>
  <div class="chart-wrap">
    <canvas id="pool-canvas"></canvas>
    <p id="pool-empty" class="empty" hidden>No session data recorded yet.</p>
  </div>
</section>

<section class="panel">
  <header class="panel-head">
    <h2>Weekly Usage</h2>
    <div class="nav">
      <div class="nav-group">
        <button type="button" data-nav="calendar-year-back" title="Back 52 cycles" aria-label="Back 52 cycles"><span class="nav-arrow">&#9664;</span>Y</button>
        <button type="button" data-nav="calendar-month-back" title="Back 4 cycles" aria-label="Back 4 cycles"><span class="nav-arrow">&#9664;</span>M</button>
        <button type="button" data-nav="calendar-week-back" title="Previous cycle" aria-label="Previous cycle"><span class="nav-arrow">&#9664;</span>W</button>
      </div>
      <span id="calendar-label" class="date-label"></span>
      <div class="nav-group">
        <button type="button" data-nav="calendar-week-fwd" title="Next cycle" aria-label="Next cycle">W<span class="nav-arrow">&#9654;</span></button>
        <button type="button" data-nav="calendar-month-fwd" title="Forward 4 cycles" aria-label="Forward 4 cycles">M<span class="nav-arrow">&#9654;</span></button>
        <button type="button" data-nav="calendar-year-fwd" title="Forward 52 cycles" aria-label="Forward 52 cycles">Y<span class="nav-arrow">&#9654;</span></button>
      </div>
      <button type="button" data-nav="calendar-now" class="primary">Current</button>
    </div>
  </header>
  <div class="series-toggles" id="series-toggles"></div>
  <div class="chart-wrap">
    <canvas id="calendar-canvas"></canvas>
    <p id="calendar-empty" class="empty" hidden>No weekly data recorded yet.</p>
  </div>
</section>

<footer id="build" class="build" hidden></footer>

<script nonce="${nonce}" src="${asset('dashboard.js')}"></script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let index = 0; index < 32; index += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
