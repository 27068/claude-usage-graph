# Changelog

## 1.1.0

- **The extension now renews the access token.** Previously, once the access
  token expired, the graph stopped updating until you next used Claude Code.
  - If a renewal fails, the status bar shows a warning.
  - Renewing writes to the Claude Code credential file, something earlier
    versions avoided as a general precaution, but in this new update, writing
    has been thoroughly investigated and tested, and stays clear of Claude
    Code's own renewal.
  - None of this applies on macOS, where the credential is in the keychain, so
    the extension cannot modify it.
- **Session Usage no longer goes blank at midnight.** A session belongs to the
  day it started, so a session opened late last night stays on last night's
  page. The view now follows it there until it resets, rather than moving to
  the new day and leaving the open session on the page behind.
- **Neither meter reports a window it can no longer see.** A weekly allowance
  that has reset, and a session pool that has closed since the last poll, now
  read as a dash rather than continuing to show the percentage they last
  reported, which looked current and was not. Session Usage says `idle` only
  when a poll has found no session open, not whenever the extension has not
  looked.

## 1.0.1

- An extension icon, so the Marketplace listing and the Extensions list no
  longer fall back to a placeholder.
- Homepage and Issues links on the listing, beside the existing Repository one.
- The README carries the icon in its title.

## 1.0.0

Initial release.

- **Session Usage** — one local day of 5-hour windows. Each is its own
  cumulative stepped line, climbing from zero and stopping at the wall where it
  expired; the gap between two sessions is real and is drawn as one. A session
  belongs to the day it started on, so a day can run to 29 hours.
- **Weekly Usage** — one allowance cycle, anchored to Anthropic's reset
  boundary rather than to midnight, with a line per weekly window your plan
  reports. Those are discovered from the data rather than from a built-in list,
  so a model tier this extension has never heard of still charts itself.
- Both views page by day, week, month or year, and stay where you put them when
  a refresh lands underneath.
- **Status bar** — the 5-hour pool and the weekly allowance, each with a
  countdown to its own reset, and a plain statement when there is no open
  session or no valid token.
- One poll every 180 seconds per machine, shared by every VS Code window, with
  exponential backoff on a rate limit.
- History is kept locally as one file per session and per weekly cycle, served
  a page at a time, and evicted past the retention window. A year is about
  1.5 MB.
- No credentials of its own: it reads the token Claude Code already maintains,
  spends it on one read-only GET, and has no write path to your credential
  store at all.
