// SPDX-License-Identifier: AGPL-3.0-only

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ICredentialRefresher, ICredentialStore, ILogger } from '../core/interfaces';

/**
 * Bound on the attempt, and the reason one is needed at all.
 *
 * `refresh()` is awaited inside the engine's poll claim, so a call that never
 * settles stops this window polling and leaves the others deferring to a turn
 * that is not happening. That holds however well the CLI behaves, which is why
 * the bound lives here rather than in an argument about its exit conditions.
 *
 * The value is sized for a cold start on a slow disk; a connection stalled
 * rather than refused is what it exists to survive.
 */
const TIMEOUT_MS = 30_000;

/**
 * Renews the access token by starting Claude Code and letting it renew its own.
 *
 * `doctor` rather than a bare `claude`, for two reasons that are not
 * interchangeable. It exits on its own, where a bare session stays up as a REPL
 * and has to be killed. And its help states it reads the working directory
 * *without a trust prompt* — a bare session blocks on that prompt in an
 * untrusted directory and then never reaches the renewal, invisibly, because
 * nothing is watching its output.
 *
 * Closing stdin does not substitute for either: a bare `claude` with stdin at
 * `/dev/null` still runs, renews and waits. That is why the timeout below is the
 * only real bound on this, and why it kills a tree rather than a process.
 *
 * `auth status` looks like the obvious candidate and does **not** renew; it
 * reports what is on disk. That was established the hard way. Do not swap it in
 * without re-testing against a genuinely stale credential.
 *
 * **A renewal that fails clears the credential**, writing empty tokens and a
 * zeroed expiry in place of the ones that were there, and still exits zero
 * reporting no problems. So this is only ever called on a credential already
 * past its expiry, where there was nothing usable left to lose, and the exit
 * code is ignored in favour of re-reading what actually landed on disk.
 *
 * `--bare` is likewise disqualified: its own help says OAuth is never read in
 * that mode, which is precisely the thing being asked for here.
 */
export class ClaudeCliRefresher implements ICredentialRefresher {
  constructor(
    private readonly credentials: ICredentialStore,
    private readonly logger: ILogger,
    private readonly executable: string | undefined = resolveClaude(),
  ) {}

  async refresh(): Promise<boolean> {
    if (this.executable === undefined) {
      this.logger.warn('Cannot renew the token: the claude CLI was not found.');
      return false;
    }

    if (!(await this.run(this.executable))) {
      return false;
    }

    // Neither the exit code nor the CLI's own report answers this — it exits
    // zero having done nothing. Only the credential on disk says, and the state
    // it lands in is logged rather than reduced to a boolean: "still stale"
    // and "now unreadable" are different failures with different causes, and a
    // log that flattens them leaves the next person guessing from timestamps.
    const after = (await this.credentials.read()).state;
    this.logger.info(
      after === 'ok'
        ? 'Claude Code renewed its access token.'
        : `Renewal changed nothing; the credential is still '${after}'.`,
    );
    return after === 'ok';
  }

  private run(executable: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Which binary, how it ended, and how long it took. All three are needed
      // to tell a CLI that never really ran from one that ran and declined to
      // renew, and none of them can be recovered from the outcome afterwards.
      const startedAt = Date.now();
      const child = spawn(executable, ['doctor'], {
        // Home rather than the workspace: nothing about this depends on the
        // project, and a directory the user has never opened in Claude Code is
        // one more thing that could stall.
        cwd: os.homedir(),
        stdio: 'ignore',
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        killTree(child);
        this.logger.warn(`The claude CLI did not finish within ${TIMEOUT_MS / 1000}s.`);
        resolve(false);
      }, TIMEOUT_MS);

      child.once('error', (error) => {
        clearTimeout(timer);
        this.logger.warn(`Could not start the claude CLI: ${String(error)}`);
        resolve(false);
      });

      child.once('close', (code) => {
        clearTimeout(timer);
        this.logger.info(`${executable} doctor exited ${code} after ${Date.now() - startedAt}ms`);
        resolve(true);
      });
    });
  }
}

/**
 * Terminate the CLI and, on Windows, whatever it started.
 *
 * Reached only from the timeout, which is to say only when the CLI is already
 * doing something unaccounted for — so it is not the moment to assume it started
 * nothing. `child.kill()` on Windows ends that one process and orphans its
 * children; `taskkill /T` walks the tree, which is what makes the timeout an
 * actual bound rather than a partial one. Elsewhere this kills the process
 * alone: spawning detached purely to gain a process group would outlive the
 * extension host in the far commoner case where nothing goes wrong.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  child.kill('SIGKILL');
}

/**
 * Where the CLI is, without trusting the extension host's `PATH`.
 *
 * That PATH is the one VS Code was launched with, not the user's shell PATH, so
 * a version manager that injects itself from a shell profile is invisible here.
 * The native installer's fixed location is checked first for that reason; the
 * bare name is a fallback for installs that are genuinely on the inherited PATH,
 * and `spawn` reports its absence through the error event rather than throwing.
 */
function resolveClaude(): string | undefined {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const installed = path.join(os.homedir(), '.local', 'bin', name);
  return fs.existsSync(installed) ? installed : name;
}
