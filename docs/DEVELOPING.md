# Developing

How the extension is put together, where to find things, and how to build, run
and test it.

> Anything specific to *your* machine — resolved toolchain paths, local storage
> locations — belongs in `docs/LOCAL.md`, which is gitignored. See
> [Local environment](#9-local-environment) at the bottom.
>
> `CLAUDE.md` at the repo root is the short version for coding agents. It is
> loaded automatically and imports `docs/LOCAL.md`, so there is no need to paste
> either file into a prompt.

---

## 1. Quick start

```bash
npm install
npm run compile
npm run test:unit    # plain mocha — no VS Code, no network, no display
```

Node **24** is pinned in `.node-version`, so `fnm`, `nvm` and `volta` all pick it
up automatically. If your shell reports `node: not recognized`, your version
manager has not shimmed that shell — see [Local environment](#9-local-environment).

Press <kbd>F5</kbd> for an Extension Development Host. Development mode replays
`fixtures/mock-usage.json` through the real pipeline, so the synthetic run
exercises the same code a live run does. The script is drained on activation
rather than played on the three-minute timer: a frame carries its own timestamp,
so replaying it fast and replaying it slowly write identical ledgers, and only
the fast one puts the whole picture on screen before you have stopped looking.

That replay is conditional on winning the first poll turn, which is easy to miss.
The **Run Extension** configuration passes only `--extensionDevelopmentPath`, so
the dev host runs in your normal profile and shares one `globalStorageUri` — and
therefore one poll schedule — with an installed copy of the extension. With an ordinary
window already running, the dev host never polls at all: it renders that window's
real ledger from disk, and the fixture is never touched, which looks like mock
mode silently failing. Open it with no other window and the reverse holds — it
takes the turn and writes synthetic frames into the real ledger.

**You cannot fix this with launch arguments, and both obvious attempts fail
quietly.** When VS Code is already running it opens the development window
itself, keeping the storage root it already has, so `--user-data-dir` and
`--profile` in `launch.json` are dropped on the way — `--profile` after
registering the profile, so it appears in the profile picker and the attempt
looks like it worked. `env` does reach the extension host process, so that is
the seam that works: set **`CUG_STORAGE_ROOT`** to a directory and the extension
puts its ledger and its poll schedule there instead of under `globalStorageUri`.
It is honoured in development mode only.

The root in use is logged on activation. Before trusting any dev host, read the
`Ledger root:` line in the **Claude Usage Graph** output channel — an isolated
one is suffixed `(CUG_STORAGE_ROOT)`. The line after it is the tell for the other
half: `Fixture replayed in full` means this window is driving the fixture, while
`Fixture drain stopped: another window is polling` means you are looking at
another window's ledger.

### Screenshots

**Run Extension (screenshot data)** in `launch.json` is that fix already applied,
plus a fixture built for the README rather than for exercising edge cases. Just
launch it and open the dashboard: its `preLaunchTask` is the chained
**screenshot: fresh data**, which clears that host's ledger, regenerates the
fixture and then compiles, so the data always ends at the NOW it pins. Run it
alone from the NPM Scripts view or `npm run screenshot:prepare` for the files.

**The wipe is not housekeeping.** A regeneration in a later week is anchored to a
different Monday, while the ledger persists between launches — so without it, two
launches layer two synthetic histories into data no real account could report:
overlapping weekly cycles drawn as two lines over the same hours with only one
answering the hover, reset walls stranded mid-line because the wall belongs to
one generation and the line beneath it to another, and "weekly" resets hours
rather than a week apart. Nothing is wrong with the charts when that happens;
`selectCalendarWeek` draws every file overlapping the frame, which is right when
cycles cannot overlap — and real ones cannot. `ScenarioRunner.load` wipes for the
same reason on every scenario switch. It sets
`CUG_STORAGE_ROOT=.vscode-screenshot-host` so it cannot touch your real ledger,
and `CUG_MOCK_FIXTURE=screenshot-usage.json` to choose the script — an
environment variable rather than a setting, so it stays out of a user's settings
UI. That directory is gitignored; delete it to start from an empty ledger.

**The fixture pins its own week, and the clock with it.** It declares a
`baseDate` — the most recent Monday whose whole composition has already happened
— and a `nowMin`, and `activate` freezes a `ScenarioClock` there for any mock
fixture that asks. So NOW is drawn inside the data rather than at the real time,
and the same command produces the same picture whenever it runs — there is no
shoot-within-the-hour window and no time of day that degrades the layout. It is
generated rather than committed only because regenerating rolls it forward a week
so the dates stay recent.

The composition is a working pattern rather than an arithmetic one: Monday
09:03–11:58, lunch, 13:02–17:54, then the same shape on Tuesday stopping at
16:11, which is NOW. The five-hour windows are *derived* from that rather than
listed — each afternoon crosses a boundary and so spends two of them — which is
why the walls land a few minutes off the hour. That is deliberate: a real window
opens on first use, so a wall at exactly 09:00 reads as generated. The weekly
reset is the one boundary that is a whole hour, because Anthropic assigns that
one rather than your working day producing it.

Running Tuesday past its first boundary is what gives graph 1 its composition —
a reset wall behind NOW and another ahead of it. Stop at lunchtime and only the
wall ahead survives, which is a duller and less representative picture.

`weeklyCost` in `SHAPES` is sized so a worked-through window spends around 8% of
the week, matching what the meter is observed to do. The ratio is the point: a
pool is exhausted by one hard session while a week is meant to absorb a dozen,
so a fixture where two days ate half the allowance would misrepresent the
headroom the plan has.

Two rules keep the weekly line honest, and both are worth preserving if you edit
the generator. It may only climb on frames where the pool climbed, so lunch and
the night read as plateaus that a reader can check against graph 1 directly. And
frames stay 9 minutes apart for as long as any window is open, so `applySample`
bookends the flat runs into two rows instead of breaking the line — the overnight
gap carries across unbroken because the first frame of the next window repeats
the previous weekly value. `scripts/make-screenshot-fixture.mjs` explains the
rest, and refuses to write a fixture whose reset wall would collide with NOW.

The README expects two images, both captured from that window and saved into
`docs/screenshots/` — a directory excluded from the vsix, since the marketplace
fetches README images from the repository host rather than from the package:

| File | What it is |
| --- | --- |
| `dashboard.png` | The whole dashboard tab, both graphs, nothing else in frame. |
| `status-bar.png` | The status bar item alone, cropped tight. |

Shoot with a dark theme unless the README says otherwise, and keep the dashboard
tall enough that both graphs get their full height — the charts size to the
viewport, so a short window squashes them rather than scrolling.

Those paths are relative, which the packager only tolerates because
`package.json` declares a `repository`: `vsce` rewrites a relative image to
`<repo>/raw/HEAD/...` and a relative link to `<repo>/blob/HEAD/...`, and without
the field it stops with an error naming the image. `--allow-missing-repository`
is not an escape hatch: it covers the missing field but not the images. And the
rewrite does not check that the file exists, so a green `npm run package` is not
evidence the screenshots are there.

---

## 2. Architecture

### The one rule

**`src/core/` never imports `vscode`.**

That single constraint carries the whole design. It keeps the persistent engine
independent of the UI, and it is what lets the entire test suite run in a bare
terminal with no VS Code download, no display and no network. It is one
convenient import away from being broken, so it is *asserted*, not trusted —
`src/test/suite/architecture.test.ts` fails the build if `core/` ever imports
vscode.

Every dependency `core/` needs is declared as an interface in
`src/core/interfaces.ts` (`IClock`, `ILogger`, `ILedgerStorage`, `IUsagePoller`,
`IEventBus`, `ICredentialStore`) and implemented by a thin adapter in
`src/vscode/`. Tests substitute plain objects.

### The layers

```
src/extension.ts        composition root — the only file that calls `new`
      |
      +-- src/auth/     reads Claude Code's existing OAuth token. Read-only.
      +-- src/core/     the persistent engine. No vscode, ever.
      +-- src/vscode/   thin adapters implementing core's interfaces
      +-- src/webview/  the dashboard UI (bundled separately — see section 4)
```

### How data moves

```
HttpUsagePoller --poll--> normalize --> UsageEngine --> sampleRules --> ledger files
 (or MockUsagePoller)                        |                             (disk)
                                             |
                                        IEventBus  <-- LedgerUpdatedEvent
                                             |
                              +--------------+--------------+
                          StatusBar                  DashboardPanel
                                                            | postMessage
                                                            v
                                                   webview/client/main.ts
                                                            |
                                                   selectors --> charts.ts
```

Four things about that flow are load-bearing:

- **The engine does not know the UI exists.** `extension.ts` creates no panel.
  The engine starts on activation and runs for the life of the window whether or
  not anything is ever rendered; the two are joined only by an event bus. Opening
  the dashboard is a *subscriber* appearing, not the engine starting.
- **Selectors run inside the webview, not the host.** The host ships ledger
  files; `core/selectors.ts` turns them into chart series on the client. This is
  why `core/` is imported by webview code too, and why the paths the client
  touches must stay free of Node built-ins as well as vscode.
- **The client is handed the live window and asks for the rest.**
  `LedgerUpdatedEvent` carries what moved, plus the newest file of each kind —
  which is all the status bar and `meta` ever read, so no snapshot is built for a
  window that never opens a dashboard. `hydrate` gives the panel the live file of
  each kind, plus `oldest` so the back buttons know where the ledger ends; the
  client then computes the range it wants and asks for it, and the host answers
  that range and only that range. So both the payload and the client's memory are
  flat in the retention window rather than growing with it — and because the host
  stores no offset and never sends a page unprompted, a background refresh cannot
  move the viewport off the page being read. See `core/types.ts` for the protocol
  and its ownership rule.
- **Navigation is bigger steps, not wider frames.** A page is one local day on
  the pool graph and one cycle on the calendar, always; ±1 day/week/month/year
  changes how far a click moves, never how much is drawn at once. There is no
  zoom, and there is deliberately no downsampling behind `readRange` — a page is
  three files and 0.41 ms, so "read every file in the range" is the permanent
  implementation rather than a first cut, and there is nothing to show a loading
  indicator for. Offsets are clamped in *both* directions: `maxDayOffset` and
  `maxWeekOffset` in `core/selectors.ts` are the inverse of the two range
  functions beside them, which is why they live there rather than in the client
  — a clamp derived from a different notion of "one page back" than the fetch
  uses is a button that disables itself on the wrong page.
- **One window polls per turn, not all of them.** `core/pollSchedule.ts` shares
  a *deadline* in global storage rather than an owner: a window may poll only by
  winning a compare-and-set on when the next poll is due, and it holds that
  claim for the milliseconds it takes to write and read back, not across the
  request. Windows that do not win read the ledger from disk and take the
  deadline back with them, so they wake when the next turn is genuinely due
  instead of an interval after their own phase — which is what stops the cadence
  decaying when several windows sit at different points in the interval. A
  follower still has to find out what the poller wrote, but it does not re-read
  the ledger to do it. `commit` only ever names the window currently open, and
  names sort chronologically, so the only file that can still be changing is the
  last one in the listing: `LedgerCache` holds that file and nothing else, and
  `reload` costs one directory listing and one read per kind at any retention —
  on the first load as much as on every one after it. A `fingerprint` of row
  count and last timestamp then decides whether the file it re-read is worth
  announcing. **A closed file is never re-opened** — see the reload's own comment
  for what holds that up and what would break it. Deletions cannot come from a
  listing, because a cache holding one file per kind has nothing to diff it
  against: `Evictor` and `clearLedger` announce their own removals, and a removal
  nobody announces is one no panel hears about.

### Where the data lives

Ledger files sit under the extension's `globalStorageUri`, split into
`sessions/` (the 5-hour pool) and `weeks/` (the weekly allowance). Files are
named for the UTC instant they start (`2026-02-06T1700Z.json`), which buys
identity and chronological sort order from a plain directory listing — and
nothing else. The name is never read back as data: retention ages a file by the
`resetAt` in its header, because the name says when a window *opened*, and the
weekly file being written to right now opened up to seven days ago. See the
header comment in `core/fileNames.ts`.

**Weekly columns are per-file and discovered, not a fixed list.** Every plan
reports an all-models window; some also meter individual model tiers against
their own sub-allowance, and which tiers those are differs by plan and changes
over time. So a week file's `cols` header records whichever tiers reported while
that file was open, `normalize.ts` takes any `seven_day_*` key it finds, and a
column is added the first time one carries a number — never merely for being
present, or a plan that reports a tier as permanently null would chart an
allowance the reader does not have.

Two consequences worth knowing before touching this. **`cols` is append-only**:
rows are aligned positionally, so removing or reordering a column re-reads every
row already written against the wrong name, whereas appending leaves short rows
that correctly read as null. And **the chart draws a column only where it carries
a reading in the visible frame**, which is what lets a tier appear or be retired
mid-cycle, and lets a retired one still draw on the pages where it was real.
Together they mean a plan change needs no migration and no code change. The full
reasoning is on `LedgerFile.cols` in `core/types.ts`.

**The cost of this layout is file count, not bytes.** A decade of history is
only ~14.6 MB — a row is 18 bytes, and bookending collapses idle runs to two of
them — but it is ~11,500 files, and each one costs ~96 µs to open on Windows
regardless of how little is inside it. Reading them all takes 1.5 s; the same
bytes in one file take 58 ms. JSON parsing is under 5% of it. So when a ledger
path is slow, look at how many files it opens, never at how big they are.

**And 96 µs is the best case by a wide margin**, which is the half that is easy
to lose. It is a warm local NVMe SSD on an idle machine; the same open is
~1 ms while an antivirus scanner is looking at a cold file, ~5 ms per scattered
file on a spindle, and ~30 ms over SMB — and `globalStorageUri` lands in the
user's config directory (`%APPDATA%`, `~/.config`, `~/Library/Application
Support`), which on a managed machine is routinely a roaming profile, a
redirected folder or an NFS home. Even locally the median hides the tail:
across 1,095 files, p50 was 0.105 ms and the four slowest were 16% of the total
time. So "it measures at 160 ms here" is a claim about one laptop, and any design
that opens a number of files proportional to how much history the user keeps is a
design that fails somewhere else. Nothing in the extension does: startup and each
page change alike cost one listing and a handful of opens.

`scripts/bench-ledger-reload.mjs` and `scripts/bench-ledger-page.mjs` are what
those numbers come from. Both take the compiled `out/` directory as an optional
argument, seed a temp store, and clean up after themselves — run `npm run
compile` first.

### Two things that look like the obvious fix and are not

Both get proposed roughly once a year, so the measurements are here rather than
in a commit message.

**A persisted index** — one file at the storage root holding
`{ name, startAt, resetAt }` per ledger file, so a page can be resolved without
listing. It is *slower than not having one*. Resolving one day page out of 10,950
session files: `list()` + bound + read the page is 5.68 ms; index + the same read
is 8.75 ms, because the index has to be reconciled against `list()` to stay a
hint rather than an authority, so its own read is pure addition. In practice the
no-index figure is lower still, since `reload` calls `list()` every tick anyway.
It also cannot desync, needs no writer coordination, and has no crash-recovery
story — because it is not a record of the directory, it *is* the directory. See
the bounds in `core/fileNames.ts`.

**SQLite** — indexed range queries, eviction as one `DELETE`, real transactions,
change detection from `PRAGMA data_version`, and no more `MutexRegistry` or
`atomicWrite` retry ladder. Multi-process is a non-concern; SQLite is built for
it. It is rejected on **distribution**, not on merits: `package.json` has zero
runtime dependencies today, `engines.vscode` is `^1.90.0` which predates Node
22.5 so `node:sqlite` cannot be assumed, `better-sqlite3` is native and must
match the *Electron* ABI (per-platform vsix targets, re-cut whenever that moves),
and `sql.js` serialises the whole database back to disk, which reintroduces the
whole-file rewrite this design exists to avoid. Two trade-offs worth knowing
either way: corruption gets much less likely but its blast radius inverts —
`readUnlocked` quarantines one damaged file and carries on, and there is no
equivalent for a corrupt `.db` — and SQLite's most-documented corruption cause is
broken locking on network filesystems, which is exactly what a roaming or
network-mounted config directory can be.

---

## 3. File structure

### `src/core/` — the engine

| File | What it owns |
| --- | --- |
| `types.ts` | Every shared type. `Millis`, `Sample`, ledger shapes, `HostMessage`/`ClientMessage`. Start here. |
| `windows.ts` | The two window lengths, and the only place either is written. Read this before changing five hours or seven days to anything else. |
| `interfaces.ts` | Every abstraction the engine depends on. The seam between core and vscode. |
| `usageEngine.ts` | The orchestrator: poll, normalize, fold, write, emit. The largest file, and the one that ties the rest together. |
| `normalize.ts` | The *only* place that knows the wire shape of `GET /api/oauth/usage`. A wire change costs this file and a fixture. |
| `sampleRules.ts` | Fold one poll into a ledger file: bookending, dead-zone detection, the idle-gap rule. |
| `selectors.ts` | Ledger to chart series. Runs client-side. |
| `sessions.ts` | Day bucketing and local-time formatting. A session belongs to the day it *started*. |
| `ticks.ts` | Gridline positions for the time axis. Chart.js cannot be trusted to place these. |
| `markers.ts` | Which reset walls and Now lines fall inside a frame. Dropping one is silent, so the rule lives where it can be tested. |
| `statusText.ts` | What the status bar says. Split from the adapter because the adapter imports vscode and cannot be unit tested. |
| `ledgerStorage.ts` | Ledger directory I/O. `sessions/` and `weeks/`, plus `readRange` — a page of history resolved from the listing. |
| `ledgerCache.ts` | The live window of each kind, plus the patch of what has moved. Not a mirror: history is paged from storage. |
| `fileNames.ts` | UTC filename encode/decode, and the bounds that turn a directory listing into an interval index. Identity and sort order, never a data source. |
| `eviction.ts` | Drops files whose `resetAt` is past the retention window, sweeps quarantined ones, and clamps the setting. A budgeted pass at a time, so a large sweep never blocks a tick. |
| `pollSchedule.ts` | Cross-window shared deadline, so one window polls per turn. |
| `mutex.ts` | Promise-chain mutex serialising writes. |
| `atomicWrite.ts` | Temp-file-plus-rename, with Windows contention retries. |
| `clock.ts` | `SystemClock`, and `ScenarioClock` for the manual-testing rig (section 10). Injected so tests drive time deterministically. |

### `src/vscode/` — adapters

| File | What it owns |
| --- | --- |
| `dashboardPanel.ts` | The webview panel: lifecycle and the host side of the message protocol. |
| `httpUsagePoller.ts` | The live poller. Hits the real endpoint. |
| `mockUsagePoller.ts` | Replays a fixture from `fixtures/`. The default in development; which file is chosen by `CUG_MOCK_FIXTURE`. |
| `statusBar.ts` | Status bar item, and the entire authentication surface. |
| `vscodeEventBus.ts` | `IEventBus` over `vscode.EventEmitter`. |
| `outputChannelLogger.ts` | `ILogger` over an output channel — how to watch the headless engine run. |

### `src/webview/` — the UI

| File | What it owns |
| --- | --- |
| `template.ts` | The shell HTML and a deliberately total CSP (`default-src 'none'`). Runs in the host. |
| `client/main.ts` | Client entry: message handling, navigation state, panel wiring. |
| `client/charts.ts` | Chart.js construction, series styling, the reset and now markers. See section 7. |

### Elsewhere

| Path | What it is |
| --- | --- |
| `src/extension.ts` | Composition root. The whole dependency graph, assembled once. |
| `src/auth/credentialReader.ts` | Reads Claude Code's token. One public method, no write path, no refresh — by design, and asserted in tests. |
| `src/test/suite/` | The unit suite. One file per core concern, plus `architecture.test.ts`. |
| `media/dashboard.js` | **Build artifact.** esbuild bundle of `webview/client/`. Generated, gitignored. Never edit. |
| `media/dashboard.css` | Dashboard styling. Hand-written, not generated. |
| `media/icon.png` | Marketplace and extension-list icon. Generated by `scripts/make-icon.mjs`, never edited by hand. |
| `fixtures/mock-usage.json` | The synthetic run: idle stretch, sudden jump, a gap *with* a value change (must break the line), a gap *without* one (must not), a session rollover, a session crossing midnight. |
| `fixtures/screenshot-usage.json` | Generated, gitignored. A dense gapless run for README images — see section 1. |
| `scripts/make-screenshot-fixture.mjs` | Writes the above, anchored to the clock at generation time. |
| `scripts/bench-ledger-*.mjs` | Ledger read benchmarks — reload cost and single-page cost. See section 2. |
| `scripts/make-icon.mjs` | Draws the icon from signed distance fields — see section 11. |

### Where do I find...?

- **A chart looks wrong** — `webview/client/charts.ts` for how it is drawn,
  `core/selectors.ts` for what is drawn, `core/ticks.ts` for the axis.
- **The line breaks (or does not) when it should not** — `core/sampleRules.ts`.
- **The API response changed** — `core/normalize.ts` and the fixture. Nowhere else.
  A model tier appearing or disappearing is not a change: those are discovered.
- **A day is bucketed oddly, or DST broke something** — `core/sessions.ts`.
- **Two windows fighting, or a corrupt write** — `core/pollSchedule.ts`,
  `core/atomicWrite.ts`.
- **Auth, or "not signed in"** — `auth/credentialReader.ts`, `vscode/statusBar.ts`.
- **Adding a command or setting** — `package.json` `contributes`, then
  `extension.ts` to wire it.

---

## 4. The webview bundle

The webview is **bundled**. The browser never loads your TypeScript:

```
src/webview/client/*.ts  --esbuild-->  media/dashboard.js  --loaded by--> the webview
```

`media/dashboard.js` is a generated build artifact and is gitignored — every
F5 configuration rebuilds it via its `npm: compile` preLaunchTask, and
`vscode:prepublish` rebuilds it before packaging. Editing anything under
`src/webview/client/` changes **nothing** on screen until that bundle is
regenerated.

### `npm run watch` does not rebuild the webview

```json
"watch": "tsc -watch -p ./"
```

It watches the **extension host** code only. No esbuild, ever. Edit `charts.ts`
while `watch` is running and you get a clean recompile scrolling by and an
unchanged chart. Watch mode covers `src/core/` and `src/vscode/`; it does not
cover `src/webview/`.

### What actually rebuilds what

| Command | Extension host (`out/`) | Webview bundle (`media/dashboard.js`) |
| --- | --- | --- |
| `npm run watch` | yes, on save | **never** |
| `npm run build:webview` | no | yes |
| `npm run compile` | yes | yes |
| `npm run package` | yes (via `vscode:prepublish`) | yes |
| <kbd>F5</kbd> | yes | yes (`preLaunchTask` is `npm: compile`) |

**Rule of thumb: after touching `src/webview/`, run `npm run compile`.**

---

## 5. Getting the running extension to pick it up

Rebuilding is only half of it — the host also has to reload.

**Extension Development Host** (<kbd>F5</kbd>) — the normal loop:

1. `npm run compile`
2. In the EDH window: <kbd>Ctrl</kbd>+<kbd>R</kbd> (Developer: Reload Window)

Reloading without recompiling reloads the *old* bundle. Both steps, every time.
The webview caches too — if the panel looks stale after a reload, close and
reopen the panel.

**Installed VSIX** — for testing the real packaged artifact. Three steps, and
skipping any one of them leaves the old build on screen:

```
npm run package                                                   # 1. build
code --install-extension claude-usage-graph-<version>.vsix --force  # 2. install
                                                                  # 3. reload window
```

**`npm run package` does not install anything.** It writes a `.vsix` file to the
repo root and stops. Reloading after it reloads whatever is still in
`~/.vscode/extensions/`, which is the previous build — the rebuild is real, the
verification in section 6 passes, and the screen does not change. If a change is
not appearing and the bundle checks out, this is why.

`--force` is the second half of the same trap: the version in `package.json` does
not change between local builds, so without it VS Code sees a version it already
has and the install is a silent no-op.

Between releases the version carries a `-dev` suffix — see section 11 — and that
is what tells the two builds apart at a glance: a plain `1.1.0` in the Extensions
list came from the Marketplace, `1.1.1-dev` is one of yours. It does not remove
the need for `--force`, since the dev version is just as constant across local
builds as a release version is.

To settle it in one command, compare what is installed against what you built.
VS Code keeps extensions in `~/.vscode/extensions/` on every platform, so only
the shell differs:

```bash
ext=~/.vscode/extensions/<publisher>.<name>-<version>/media/dashboard.js
cmp -s "$ext" media/dashboard.js && echo same || echo STALE
```

```powershell
$ext = "$HOME\.vscode\extensions\<publisher>.<name>-<version>\media\dashboard.js"
(Get-FileHash $ext).Hash -eq (Get-FileHash media/dashboard.js).Hash
```

`STALE`/`False` means you are looking at a stale install, not a bad change.

> `vsce package` fails on **relative links in `README.md`** while `package.json`
> has no `repository` field, because it cannot rewrite them to absolute URLs.
> Reference repo-only paths as inline code, not links, until a repository URL is
> added.

> Once a `.vscodeignore` exists, `vsce` stops consulting `.gitignore` altogether.
> Gitignored working directories are therefore **not** excluded by default — the
> dev hosts' ledgers under `.vscode-test-host/` and `.vscode-screenshot-host/`
> shipped inside the vsix until `.vscodeignore` named them. After adding any new
> generated or local directory, run `npx vsce ls` and read the list; it prints
> exactly what would be packaged, without building anything.

---

## 6. Verify the change is really in the bundle

If a change is not appearing, confirm it survived into `media/dashboard.js`
before editing the source again. The bundle is minified, so grep for the shape,
not your identifier names:

```bash
grep -o '.\{60\}<a Chart.js option name>.\{60\}' media/dashboard.js
```

```powershell
$c = Get-Content media/dashboard.js -Raw
[regex]::Matches($c, '.{60}<a Chart.js option name>.{60}') | Select-Object -Expand Value
```

Chart.js option keys and other object literal keys survive minification, so they
make reliable anchors. Local identifiers do not, but their *initializers* do,
which makes a named constant easy to trace: `const LINE_WIDTH = 2` shows up as
`var ia=2`, and a constant derived from it keeps the expression — `(ia+1)/2`.

If you cannot find your value, the bundle is stale: go back to section 4. If you
can find it and the screen still disagrees, the install is stale: section 5.

---

## 7. Chart gotchas (`src/webview/client/charts.ts`)

Stroke weight and marker size are single module constants at the top of the
file, deliberately **not** per-series values, so the five-hour and weekly graphs
read as one instrument. Change them there, not at a call site.

- **Points are thinned against the viewport before drawing**, by 2D pixel
  distance, so a sample that would land on top of its predecessor is not drawn.
  This lives in the renderer, not the ledger: how many pixels a run occupies is a
  fact about the panel width, not about the data, and `core/sampleRules.ts` has
  already compressed each flat run to an anchor and a bookend on disk. Measuring
  in two dimensions is what keeps brief value changes — a step is far up the y
  axis even when it is a short way along x.
- **Axis ticks are supplied explicitly** from `core/ticks.ts`. Left to itself, a
  Chart.js linear scale over epoch milliseconds picks round *numbers* and draws
  gridlines at times like 22:16.
- **Graph 2's x axis carries two tick sets.** Midnights draw the gridline and no
  text; noons draw the weekday and no line, so each label sits in the middle of
  the day it names instead of on the boundary between two days. Suppressing the
  line at a noon tick needs both `grid.color` *and* `grid.tickColor` scripted —
  `tickColor` paints the short stub outside the axis and does not follow
  `color`.
- **The marker labels are drawn outside the plot**, in a strip claimed with
  `layout.padding.top`. That padding sits outside *every* box Chart.js fits, the
  legend included — so the band only stays empty while graph 2's legend is at
  `position: 'bottom'`. Move the legend back to the top and it lands in the
  strip, under the labels. Drawing them inside the plot is what the band
  replaces: five points of headroom above 100% is about ten pixels, so an
  in-plot label covered any series above ~92%.
- **Anything drawn straight onto the canvas must set its own text state.** The
  2D context arrives however Chart.js last left it, and that differs per chart:
  graph 2 draws a legend before the datasets and leaves `textBaseline = 'middle'`
  behind, while graph 1 has no legend and leaves `'alphabetic'`. Inheriting it
  dropped the marker labels onto the plot edge on one graph and not the other.
  Set `font`, `textAlign` *and* `textBaseline` every time. Note also that
  `var(--…)` is **not** valid in the canvas `font` shorthand — the assignment is
  rejected silently and the old font stays — so resolve the theme variable in JS
  and hand the canvas a plain family list.
- **Chart.js sizes are CSS pixels, not device pixels.** The canvas backing store
  is scaled by `devicePixelRatio`, so on a HiDPI display everything is drawn
  larger than its number — but uniformly, so relative sizes still hold.
- **Scriptable option callbacks must not narrow their context type.** Chart.js
  types `dataset.data` as `(number | Point | null)[]`; declaring a parameter
  narrower than that fails to typecheck against the scriptable-option signature.
  Take `unknown[]` and narrow inside the function.

---

## 8. Tests

```bash
npm run test:unit    # tsc -p ./ && mocha
```

Plain mocha — no VS Code, no network, no display. That works because of the rule
in section 2, and `architecture.test.ts` exists to keep it working. That file
also asserts the auth layer has no write or refresh path — renewal is asking
Claude Code's own CLI to do it, from `src/vscode/claudeCliRefresher.ts`, and
never something this codebase performs — that
`dashboardPanel.ts` subscribes before assigning HTML (losing the `ready` message
leaves the panel blank — this shipped once), and that every write goes through
`atomicWrite`.

Note `test:unit` runs `tsc -p ./` only, so it does **not** rebuild the webview
bundle. Tests passing tells you nothing about whether the chart on screen is
current.

### Never test auth against a copy of the credentials file

Claude Code **rotates the refresh token on every refresh**, so two files holding
the same one is not a fixture — it is a countdown. Whichever copy gets redeemed
first retires the token in the other, and the loser is a login that can no longer
be renewed. Pointing `HOME`/`USERPROFILE` at a copied `.credentials.json` looks
like isolation and is not: it isolates the files, not the server, and the way it
fails is the developer being signed out of Claude Code entirely.

Two things follow. Edit `expiresAt` **in place** when you need a stale credential,
so only one live copy ever exists. And do not read `refreshTokenExpiresAt` to
decide whether rotation happened — it is anchored to the original grant and moves
by about a millisecond across a rotation, so it reports "unchanged" while the
token beside it is replaced. Compare the token value.

---

## 9. Local environment

Machine-specific setup — where your Node actually lives, how to put it on PATH in
a shell your version manager has not shimmed, local storage paths — lives in:

```
docs/LOCAL.md      (gitignored)
```

It is deliberately not committed: those paths differ per machine, per user and
per version manager, so a shared copy would be wrong for everyone but its author.
If it is missing, create it and record whatever you had to work out, typically:

- the absolute path to the pinned Node install, and a copy-paste line that
  prepends it to `PATH` in whichever shells you actually use here
- where this machine keeps the extension's `globalStorageUri` ledger files
- anything else that is true of your box and nobody else's

---

## 10. Manual testing: scenarios

Some states cannot be reached by using the extension. They depend on where `now`
sits relative to a reset boundary — a pool that lapsed three hours ago, a weekly
cycle three cycles stale, a ledger with nothing in it. Waiting for one is not a
test plan, and the mock harness could not express the first of them at all until
`Frame.fiveResetMin` was allowed to be null.

A **scenario** is a fixture that carries both halves: the frames to replay *and*
where to pin the clock. Pinning is the part that makes it work — every view here
is a function of `now`, so moving the clock moves the Now marker, the frame
roll-forward, the countdown and `meta.now` together, and the graph can never
disagree with the bar beside it about when it is.

### Running one

Launch **Run Extension (test scenarios)**, then run **Claude Usage: Load Test
Scenario** from the palette.

**Before you load one, you are not looking at a scenario.** Every development
host mocks its poller, and with no `CUG_MOCK_FIXTURE` set this one replays the
committed `fixtures/mock-usage.json` — the general development fixture, whose
job is dead zones, rollover and a session crossing midnight. That is what a
fresh launch shows. Its `preLaunchTask` clears the host's ledger first, because
that fixture is anchored to local midnight of the *previous* day: launch on two
different days without the wipe and you get two weekly cycles a day apart,
drawn over each other. Every fixture here declares exactly one weekly reset, so
two reset walls a day apart is always contamination, never a short cycle.

Pick from the list; switching wipes the ledger,
replays the new script and re-pins the clock, so you can step through the whole
set in one window. The command exists only under `CUG_TEST_MODE=1` and only in
development, and its ledger lives in `.vscode-test-host/` (gitignored, disposable
— it is deleted on every switch).

### What each one should show

| Scenario | Graph 1 | Graph 2 | Status bar |
| --- | --- | --- | --- |
| Live session | line 09:00→11:00, `Reset 14:00` wall ahead of Now | normal line, Now mid-cycle | `41% 3h 0m · …` |
| Lapsed 5-hour pool | line stops ~05:37, red `Reset 05:40` wall, **empty gap**, dashed Now at 08:37 | line runs all the way to Now | **`idle · …`**, no countdown on the pool |
| Quiet day, data on record | today framed, labelled and **blank**, Now on the axis, **no placeholder**; page back one day for the session | normal | `idle · …` |
| Weekly cycle three cycles stale | a day with no sessions | frame aligned to the recorded phase, Now inside, no line, **no placeholder**, and a single **`Expected reset`** wall — the only projected wall anywhere; page back three for the recorded wall and the data | `idle · …` |
| Nothing recorded | "No session data recorded yet." | "No weekly data recorded yet." | `idle · —` |

Three rules are the point of the set: a placeholder appears **only** when that
kind has zero records; Now is **always** on the axis of a live page; and a solid
reset wall is **always** a boundary some file recorded — never one the frame's own
arithmetic produced. Navigation is seven days a step regardless of what any cycle
did, and the recorded boundary supplies only the phase.

### Adding one

Copy the nearest file in `fixtures/scenarios/`. Offsets are minutes from local
midnight of the day *before* the run — the anchor `MockUsagePoller` derives — so
`1440` is today's midnight and `2100` is today at 11:00. A null `fiveResetMin`
means the API reported no five-hour window; a frame with every value null makes
the engine write nothing at all.

`scenarios.test.ts` drives every file through the real engine and asserts the
claim its row above makes, so a scenario cannot quietly stop demonstrating what
it is named for. It also rejects frames that run backwards or past `nowMin`,
which is the mistake this kind of arithmetic actually makes. **That is why the
manual pass is worth doing**: the states are already asserted, so what your eyes
are adding is whether the picture is legible — not whether the data is right.

### What this does not cover

Nothing here renders. The suite runs in a terminal with no VS Code and no DOM, so
it proves the *inputs* to the chart and stops at the paint call.

The join between the two is the gap that rule-per-half testing leaves: a selector
can return a sensible frame and `charts.ts` can correctly drop a marker outside
it, with neither half wrong and the result a live chart carrying no Now line. So
that rule lives in `core/markers.ts`, and `markers.test.ts` composes it with the
real selectors — a marker is asserted to survive as far as being drawn.

What is still eye-only is the drawing itself: Chart.js painting, and the label
placement in `charts.ts`, which measures text on a canvas and cannot be
meaningfully faked. `dashboard.js` is a bundle, so remember section 6 — a green
suite says nothing about whether the bundle on screen is current.

---

## 11. Releasing

The order, once; the reasoning for each part is below.

1. `npm version <x.y.z> --no-git-tag-version` — bump before packaging, since the
   version is baked into the vsix filename and into what the Marketplace accepts.
   The flag suppresses npm's *commit as well as* its tag, despite the name: left
   to itself npm commits the two version files alone and tags that commit, which
   would put `v<x.y.z>` on a tree containing neither the changelog nor the code.
   The tag is made by hand at step 5 instead. Editing the version by hand is not
   the same thing — it leaves `package-lock.json` behind, and `npm install
   --package-lock-only` is the repair.
2. Add that version's entry to `CHANGELOG.md`. It is the listing's Changelog tab,
   so it is release notes for strangers rather than a commit summary.
3. `npm run test:unit`, then `npm run package`.
4. Install the vsix and reload — section 5. Shipping one nobody has run is how a
   stale bundle or a broken activation reaches the Marketplace, where the version
   cannot be replaced.
5. Commit the bump and the changelog together, and tag that commit.
6. Push, tag included.
7. Upload, by one of the two routes below.
8. Bump straight away to the *next* version with a `-dev` suffix, so that no
   local build can be mistaken for the published one — section 5.

Step 8 starts at the next **patch** — `1.1.1-dev` once `1.1.0` is out — because a
patch predicts nothing, and raise it as the work settles: `1.2.0-dev` once a
feature has landed rather than a fix. Every real release outranks it whichever
you end up shipping, since a version beats the same version carrying a prerelease
tag:

```
1.1.0  <  1.1.1-dev  <  1.1.1  <  1.2.0  <  2.0.0
```

So step 1 of the next release is dropping the suffix rather than incrementing,
and an installed dev build is superseded by whatever supersedes it in fact.
`vsce` validates the version with plain `semver.valid`, so a suffix packages
without complaint — a `-dev` version is never the one uploaded, so whether the
Marketplace would accept one has never had to be answered.

`npm run package` writes `claude-usage-graph-<version>.vsix`, and
`vscode:prepublish` runs the full compile first, so the vsix cannot carry a stale
bundle. Getting it onto the Marketplace is a separate step with two routes:

- **By hand** at `marketplace.visualstudio.com/manage` — the extension's `⋯`
  menu, then **Update**, and drop the vsix in. Needs only the Microsoft account
  that owns the publisher.
- **`vsce publish`**, which needs either a PAT scoped **Marketplace: Manage** and
  **All accessible organizations**, or `--azure-credential` after `az login`. A
  PAT can only be minted from inside an Azure DevOps organization — there is no
  organization-less token page — which is the reason the manual route is worth
  knowing.

**A published version is immutable.** The Marketplace refuses a second upload of
the same version number, and deleting a version does not release it for reuse:
bump the patch instead. Deleting the *extension* is worse — its name is then
permanently reserved and cannot be republished even by the same publisher.

Versions are three-part semver; `1.0` is rejected. Bump with
`npm version <v> --no-git-tag-version`, not `vsce publish <v>`, which runs
`npm version` with a commit and a tag of its own. Tag the commit a version
shipped from — that pins what a listing actually contains, which no amount of
`git log` recovers afterwards, and it is why history must not be rewritten once
a version is public.

The listing is assembled from files this repo already has: `CHANGELOG.md`
becomes its Changelog tab, and `repository`, `homepage` and `bugs.url` become the
Repository, Homepage and Issues links in its Resources panel. `repository`
carries a second job — rewriting the README's relative links and images to
absolute URLs — described at the top of `README.md`.

`media/icon.png` is generated by `scripts/make-icon.mjs`; edit the script and
re-run it rather than touching the PNG.
