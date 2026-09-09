# Design decisions

Why parts of this are built the way they are, and what was rejected on the way.

Separate from `DEVELOPING.md` because it answers a different question. That file
is for *how do I build, run and verify this*; this one is for *why is it like
this, and can I change it*. The two get read at different moments, and this
material only ever grows.

**What belongs here.** An alternative someone would otherwise re-propose, and the
measurement or mechanism that decides it. Not a history of what was tried, and
not anything recoverable from the code — a decision earns a place here only if
the code cannot state it, which usually means it is about something the code
deliberately does *not* do.

---

## 1. Storage

Both of these look obviously right until measured, which is why the numbers are
here rather than in a commit message.

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

## 2. Token renewal

`src/auth/credentialRefresher.ts` redeems Claude Code's refresh token against its
OAuth token endpoint and writes the new pair back to `~/.claude/.credentials.json`.

**Why not let the CLI renew instead.** It would keep this codebase out of the
credential store entirely, which is why it keeps looking like the better design.

- **`claude doctor` renews; `claude auth status` only reports what is on disk.**
  So `doctor` is the only candidate.
- **It does not await its own credential write before exiting.** The redemption
  is issued and the process ends, so whether the write lands is decided by
  nothing but how long the rest of the run happens to take.
- **What makes a run long enough is an accident.** `doctor` shells out to
  `npm -g config get prefix` and waits for it, and that lookup is what gives the
  pending write the time it needs.
- **An extension host has no npm.** It inherits the `PATH` VS Code was launched
  with rather than a shell's, so the lookup fails immediately, the run ends about
  300 ms sooner, and the write never happens. Node is not the variable: a
  directory holding one batch file that sleeps a second, with no node anywhere on
  `PATH`, renews and persists correctly.
- **The damage is silent and arrives late.** The refresh token has been spent,
  the replacement is lost, and the file still holds the spent token looking
  healthy. Nothing is wrong until the next ordinary use presents it, is refused,
  and Claude Code blanks the store — a sign-out minutes later, with nothing
  reported when it actually broke.
- **Redeeming the grant here fails the other way.** A refusal spends nothing and
  writes nothing. `architecture.test.ts` fails the build on a spawn, since
  nothing else in the suite could catch a reintroduction.

**Why the reader cannot write or reach the network, separately.** Every poll
reads the credential; only an expired one renews. Keeping the common path
incapable of writing means no ordinary tick can disturb a login.

**Why the renewal is renamed into place rather than written onto the file.**
Other processes read this file continuously, so a torn write leaves them parsing
half a credential with nothing to fall back on. The temp file therefore *is* the
write, and once a token is in it, it holds the only copy of a grant already
spent — so a failure past that point keeps it and logs its path, and renaming it
over `.credentials.json` is the recovery.

**Why the ordering in `refresh()` looks fussy.** The gap between the server
issuing a pair and that pair reaching disk is the only interval where a crash
costs a login, so the read, parse and temp file happen before the request and the
rename and read-back after the flush. Judge changes to that file by what they add
between those two points.

macOS is left to Claude Code: the credential is in the keychain, so there is
nothing for a rename to target.

**The two endpoints demand opposite user agents, and sharing one breaks
renewal.** `api.anthropic.com` throttles anything that does not identify as
Claude Code. `platform.claude.com` refuses that same agent at Cloudflare's edge
with a 429 and no request id, so the redemption never reaches the application —
it reads as rate limiting and is not. Four agents, one invalid token, three
seconds apart:

| Agent | Result |
| --- | --- |
| `claude-usage-graph/1.1.0` | 400 `invalid_grant`, reached the app |
| none | 400 `invalid_grant`, reached the app |
| `claude-code/2.1.266` | 429, blocked at the edge |
| `Mozilla/5.0` | 429, blocked at the edge |

It behaves as a blocklist. Both refusals are agents claiming to be something they
are not, and the real CLI never sends a Claude Code agent to that host — its
redemptions go out as `anthropic-sdk-typescript/<version> userOAuthProvider`, so
a rule blocking the other one can only catch impersonators. The SDK string works
and ignores the version, since an invented one was accepted, but it claims to be
Anthropic's own client. Ours is accepted, so **we impersonate only where nothing
honest works, which is the usage endpoint and not this one.** Being nameable
means being blockable, and that is the trade taken deliberately: a block we can
read beats silent breakage.

No stub can catch any of this, and the unit suite here is entirely stubbed, so
green tests say nothing about whether a redemption is accepted. Run
`node scripts/probe-token-endpoint.mjs` instead: its refresh token is invalid, so
it spends nothing and can rotate nothing, and one request separates "reached the
application" from "refused at the edge". Do that before trusting any change to
the request.

**The refresh token's own expiry does not extend when it rotates.** The response
carries `refresh_token_expires_in`, and it lands within seconds of the value
already stored — it is anchored to the original grant, so a rotation buys a new
access token and no more runway. That value is stored rather than carried
forward: the reader decides "renewable" against it, and a field the server is
willing to state should never be inferred.

Both expiries arrive as durations rather than instants, which is RFC 6749 making
a client with a wrong clock work at the cost of putting the round trip into every
answer. They are therefore measured from *before* the request, so each rotation
errs towards expiring early. Early costs one premature renewal; late means
presenting a token the server has already retired.

**Renewal is timed to finish before Claude Code would start.** Its token provider
renews in the background once a token has under 120 seconds left, and
synchronously under 30 — on use, never on a timer. That band is the only window
where both of us can redeem the same refresh token at once, and a server that
treats reuse as theft answers by revoking the family and signing the user out.
So the reader's skew is one poll interval plus that band plus a minute of slack,
and the arithmetic is asserted rather than described.

**Two things here cannot be tested without risking the thing being tested.**
Neither is a reason to change anything; both are reasons not to be surprised.

- **Refresh-token reuse detection.** If the server treats a spent token as theft
  and revokes the whole family, a collision signs the user out. Standard practice
  is a plain refusal, and concurrent redemptions have been observed not to
  collide, which is consistent with a reuse grace window — but proving it means
  presenting a spent token deliberately. The timing above exists so we never do.
- **A timed-out request is "unknown", not "failed".** Aborting is client-side and
  does not stop the server processing the request, so a rotation may have
  happened that we never saw. The replacement is then lost and the file holds a
  retired token — the same outcome as the CLI bug, by a different route.
  Observed latency is 190–333 ms against a 30-second bound, so anything reaching
  the timeout is already far outside normal.

**Predicting when this fires**, which is the only way to plan a test around it.
An access token lasts eight hours from the moment it was issued, and nothing
moves that: Claude Code checks the expiry before building a grant and returns
early while the token is good, so using it heavily keeps the token busy rather
than fresh. The credential file's modification time plus eight hours is
therefore the deadline, readable without touching the token itself. Being idle
across that minute is what leaves the renewal to this extension — an active
Claude Code will get there first, and legitimately.

---

## 3. Where the credential lives

Claude Code selects a credential store by platform, in both the CLI and
Anthropic's VS Code extension:

- **macOS** — the keychain.
- **Windows** — Credential Manager, named `windows-credman`, behind a
  server-controlled feature flag and forceable with
  `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1`.
- **Otherwise** — `~/.claude/.credentials.json`.

Exactly one store holds the credential at a time. The file is only a read
fallback, and the write path enforces the rest: a successful write to the primary
deletes the file, and a fallback write to the file deletes the primary. So the
same refresh token is never live in two places, and nothing here can retire a
token another store still relies on.

What this extension can do with each is not the same, and that asymmetry is the
whole of the platform behaviour:

| Store | Read | Renew |
| --- | --- | --- |
| File | yes | yes |
| macOS keychain | yes, via `security` | no — writing it is not implemented |
| Windows Credential Manager | no | no |

So macOS charts normally and reports `stale-token` when the token expires,
waiting for Claude Code to renew — which is an action the reader can take.
Credential Manager is the case with no action at all: the file *disappears* the
first time Claude Code writes after the flag turns on, and neither signing in nor
using Claude Code brings it back, because both write to the same store.

That is why `unreadable-store` exists rather than reusing `no-credentials`.
Reporting a sign-out there would send somebody round a loop with no exit.
`~/.claude.json` is what separates them: it records the account with no token in
it, so it survives wherever the credential went. It cannot say whether that login
is still current — the expiry is inside the credential nobody here can read — so
the message claims only that the figures are unavailable, and why.

Reading the store needs Bun's secrets API, which is how the Bun-compiled CLI
reaches it and why Anthropic's own VS Code extension falls back to the file under
Node. Supporting it here means a native `CredRead` in an extension with no
dependencies. `cmdkey /list` showing no Claude entry means the flag is off for
that machine.

### Holding our own credential instead

The escape from all of the above, and not currently worth taking: run our own
OAuth grant and keep the token in `context.secrets`, rather than reading Claude
Code's.

The store is the easy half — VS Code's secret storage is encrypted,
cross-platform, and indifferent to what Claude Code does. The hard half is the
grant, which means an authorization code flow with PKCE and a client id. There is
no registered client to use for subscription scopes, and reusing Claude Code's is
impersonating their OAuth client: a policy problem rather than a technical one,
and the kind that breaks without warning.

What makes it tempting is that the failure mode inverts. Every constraint in
section 2 exists because the credential is not ours. Our own grant is independent,
so rotating it cannot retire Claude Code's, and the worst case of any bug drops
from "signed out of Claude Code" to "sign in to this extension again".

What it costs is the thing the extension leads with: no setup at all, and no
credentials of its own. If it is ever needed, the version to build is the hybrid —
keep reading Claude Code's credential as the default and offer a sign-in only
where the store comes back unreadable, so nobody who does not need it is ever
asked.
