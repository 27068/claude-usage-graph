# Claude Usage Graph — agent notes

Read this before running commands or editing. It is short on purpose. Open
`docs/DEVELOPING.md` for the architecture tour (section 2), the file map
(section 3) or the chart internals (section 7), and `docs/DECISIONS.md` before
proposing a different design — it holds the alternatives already rejected and
what decided them.

Nothing in this file is specific to one machine. Those details live in
`docs/LOCAL.md`, which is gitignored and imported here — read the imported
content rather than asking the user for paths.

@docs/LOCAL.md

If that import resolved to nothing, this is a fresh clone and `docs/LOCAL.md`
does not exist yet. Work the paths out, then write the file; `docs/DEVELOPING.md`
section 9 says what belongs in it.

---

## Before running any command

This project builds on the Node version pinned in `.node-version`. Confirm the
toolchain resolves before you lean on it; if `node` or `npm` is not found, the
import above has the fix for this machine. A command that cannot find a tool has
not established that the tool is absent — resolve it from the import rather than
reporting it missing or offering to install it.

## Before reporting a UI change as done

The webview is an esbuild bundle. Editing `src/webview/client/*.ts` changes
nothing on screen until `media/dashboard.js` is regenerated:

- After touching `src/webview/`, run **`npm run compile`** — not `npm run watch`,
  which never rebuilds the bundle. Never edit `media/dashboard.js`: generated,
  gitignored.
- Confirm it landed by grepping the minified bundle for the shape of it (section
  6) before editing the source a second time. Minification strips comments, so a
  comment-only edit is not greppable and compiling is the check.
- Do not assume F5, and do not assume this is webview-only. **Any** `src/` edit,
  host code included, reaches the screen through `~/.vscode/extensions/`, which a
  repo-local compile does not touch — verify against that copy, never `out/`.
  Section 5 has the package-install-reload sequence; skipping any of it leaves a
  stale install, which looks exactly like a change that failed.
- The user must reload the window to see it. Say so.

## Verify before claiming

- `npm run test:unit` is the suite. It does **not** rebuild the webview, so a
  green run says nothing about the chart on screen.
- `npm run package` builds the vsix and runs the full compile first.
- Report what the command actually printed. A visual change you have not seen
  rendered is "built and verified in the bundle", not "confirmed working".

## Committing

Finishing a unit of work — one bug, one feature, anything with a clean seam
around it — includes committing it. Do it in the same turn, without being asked,
and only once the section above has actually passed: commit what you have run,
not what you have typed.

Work lands on `dev`. `main` is what has been released and moves only at a
release — `docs/DEVELOPING.md` section 11. So every commit you write is on a
branch that is safe to rewrite, and every commit on `main` is one that is not.

- **Never push `main`.** Pushing `dev` is backup and needs no asking; `main` is
  the user's call, at a release, every time.
- **Amend the commit it belongs to, which is often not the last one.** A fix or
  a doc update for bug 1 goes into bug 1's commit even with bug 2 sitting on top
  of it. What decides the commit is which unit the change serves, never which is
  most recent; only a change that opens a new unit earns a new commit. History
  should read as one commit per unit of work, not as the route you took to it.
- Reaching back is `git commit --fixup=<sha>` then `git rebase --autosquash
  <sha>~1`. No `-i`: autosquash needs none, which matters because the Bash tool
  refuses interactive rebase. On `dev` this costs nothing, which is what the
  branch is for — expect to need it, because "finished" is a judgement that is
  sometimes wrong and the discovery usually arrives after the commit.

## Repo conventions

- `src/core/` must never import `vscode`. `architecture.test.ts` enforces it. If
  you need a platform capability in core, add an interface to
  `src/core/interfaces.ts` and an adapter in `src/vscode/`.
- `README.md` can carry relative links and images **only** because
  `package.json` has a `repository` field: `vsce package` rewrites them to
  absolute URLs from it, and hard-fails on both without it. Removing that field
  breaks packaging, and `--allow-missing-repository` does not cover images.
- `docs/` and `src/` are excluded from the vsix via `.vscodeignore`.
- A test earns its place only if it can fail while every other test passes. The
  same fixture asserted more weakly, or a second example of one code path, only
  renames a case the suite has — `docs/DEVELOPING.md` section 8 for cutting one.
- Comments explain *why*, in the present tense, and never restate the code. **A
  comment is not a changelog**: no "used to", no "no longer", no what-was-tried,
  no gains a past change won — state the constraint that holds today. A rejected
  alternative earns a line only where someone would re-propose it, as the reason
  it loses rather than as a story.

## Keeping these docs current

Part of finishing a task, not a separate chore. Do it in the same turn, without
being asked, and mention in one line what you changed.

**Admission test** — record something only if all four hold. Most findings fail
this, and that is the point:

1. It cost real time to discover — a failed command, a wrong assumption, a
   surprise in how the tooling behaves.
2. It is not recoverable from the code, `package.json` or `git log` in a minute.
3. It will still be true next month, and true for someone other than you.
4. It is not already written down somewhere in these four files.

How a function works, what a change did, why a bug happened: all out. That is
what the code and its comments are for.

**One fact, one file.** Never the same thing in two. Route on *portability
first*, audience second:

- **Would it be false on someone else's clone?** Then `docs/LOCAL.md`, whoever
  reads it. Installed paths, which shell is preferred, where storage resolves —
  a local fact is a local fact whether a person or an agent needs it. This is the
  test that catches most mistakes: "node is not on PATH" reads like a rule but is
  a claim about one machine, so it belongs here, not in a committed file.
- Otherwise, is it *why* rather than *how* — an alternative someone would
  re-propose, and what rules it out? Then `docs/DECISIONS.md`. A decision earns a
  place there only if the code cannot state it, which usually means it is about
  something the code deliberately does not do.
- Otherwise, if it explains the project — `docs/DEVELOPING.md`.
- Otherwise, if it changes how an agent behaves — this file.

Keep committed files true of a fresh clone anywhere. When a rule needs a local
detail to act on, state the portable half here and let the import supply the rest.

**Budget.** Every line here loads each session and is paid for repeatedly, so
keep it tight — but the line count is a prompt to compress, never a reason to
drop something worth knowing. Rewrite a line rather than adding one beside it,
and move mechanism to `docs/DEVELOPING.md` behind a pointer. Once what remains
all earns its place, raise the target instead of cutting to meet it. ~160 today.

**Evict in the same pass.** Before relying on anything written here, check it is
still true — the file, flag or script still exists. If it is wrong, correct or
delete it rather than hedging it. Delete on sight: workarounds for fixed bugs,
paths that moved, renamed scripts, advice contradicted by the current code.
Removing a stale line needs no permission; just say you removed it.

**Style.** State the fact and its consequence in one or two sentences. No dates,
no changelog entries, no "as of", no attribution, no notes about what used to be
true. Never invent a frequency or a quantity to make a point land — "gets
proposed about once a year", in a repo weeks old, is the shape of it.

## Tooling notes

- The Bash tool's working directory **persists between calls**. A `cd` in one
  call affects the next. Prefer absolute paths, or `cd` to the repo root first.
- Large heredocs into `bash` are unreliable for prose containing quotes and
  backticks. For multi-line file content use the Write tool, not `cat <<EOF`.
- Use one shell consistently for `npm`/`vsce` within a session; mixing shells
  loses the `PATH` you just set. Which shell is preferred here is in the import.
