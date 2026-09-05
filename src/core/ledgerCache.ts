// SPDX-License-Identifier: AGPL-3.0-only

import type { ILedgerStorage } from './interfaces';
import type { LedgerFile, LedgerKind, LedgerPatch, LedgerRef, Millis } from './types';

const KINDS: readonly LedgerKind[] = ['five_hour', 'seven_day'];

/** The live file of a kind, with the name it is stored under. */
interface Held {
  name: string;
  file: LedgerFile;
}

/**
 * The window still being written to, per kind, and the patch of what has moved.
 *
 * It is deliberately **not** a mirror of the ledger directory: a mirror has to
 * be filled, so startup would open and parse every file in the retention window
 * before anything could paint — per-file overhead rather than bytes moved, at
 * 0.1 ms a file on a warm SSD and tens of milliseconds each on a redirected or
 * network-mounted config directory, scaling with how much history the user keeps.
 *
 * History is immutable once a window has closed, so a page of it is read
 * straight from storage on demand and needs no coherence with anything held
 * here. What is left is the residue that cannot be served that way:
 *
 * - the live file is the one thing that *changes*, so a follower window has to
 *   re-read it to learn what the polling window wrote;
 * - `meta` and the status bar want the newest file of each kind and nothing
 *   else;
 * - the patch protocol needs somewhere to accumulate what moved between
 *   publishes.
 *
 * Memory and the number of files opened are therefore O(1) at any retention, on
 * startup and on every tick alike.
 *
 * ### Removals are announced, never inferred
 *
 * The files eviction drops are precisely the ones this does not hold, so a diff
 * of the listing would come back empty and a panel would keep drawing files that
 * are gone. So whoever deletes a file calls `announceRemoved` — `Evictor` and
 * `clearLedger`, the only two things that delete — and `reload` reports only the
 * one file it can still speak for.
 */
export class LedgerCache {
  private readonly live: Record<LedgerKind, Held | undefined> = {
    five_hour: undefined,
    seven_day: undefined,
  };

  /** Keyed by `${kind}/${name}`, so a file cannot appear twice in one patch. */
  private readonly changed = new Map<string, LedgerFile>();
  private readonly removed = new Map<string, LedgerRef>();

  constructor(private readonly storage: ILedgerStorage) {}

  /**
   * Refresh from disk: one directory listing and one read per kind.
   *
   * `UsageEngine.commit` names a file for the window currently open, so the only
   * file it can still be writing to is the newest — and `list` returns names in
   * UTC basic format, where lexicographic order *is* chronological, so that file
   * is simply the last name. Everything before it belongs to a closed window and
   * cannot change, which is why none of it is opened here and why a page pulled
   * from storage never needs invalidating.
   *
   * **This assumes nothing else rewrites a closed file, and that assumption is
   * the price of the cheap tick.** What holds it up:
   *
   * - the engine only ever writes the open window;
   * - `clearLedger` and `Evictor` remove rather than rewrite, and both announce
   *   what they removed;
   * - the scenario runner, the one other thing that touches ledger files, needs
   *   `CUG_TEST_MODE=1`, and the only launch configuration setting it also sets
   *   `CUG_STORAGE_ROOT` — so it always works on a root no other window shares.
   *
   * What would break it is a poll whose `resetAt` moved *backwards* past the
   * minute `normalize.readTimestamp` quantizes to, and stayed there: the first
   * such write lands on a new name and is caught as an addition, but later
   * writes would be missed and that file would stay stale until the window
   * restarts. Never observed. The fix if it ever is: stat every file and read
   * what moved, at the cost of O(files) syscalls a tick where this is O(1).
   *
   * The fingerprint is the second half. The newest file is re-read every tick
   * whether or not anything wrote to it, so something has to decide whether the
   * bytes that came back are worth announcing — otherwise every follower tick
   * would republish the live session and the live week for nothing.
   */
  async reload(): Promise<void> {
    for (const kind of KINDS) {
      const names = await this.storage.list(kind);
      const held = this.live[kind];
      // Sorted chronologically, so the open window is the last name.
      const name = names[names.length - 1];

      // The one removal this can speak for, because it is about a file the cache
      // *holds* rather than a diff over the directory. At an ordinary rollover
      // the held file is merely no longer the newest — still on disk, and not to
      // be announced — so the listing has to say it is gone, not just not live.
      if (held !== undefined && held.name !== name && !names.includes(held.name)) {
        this.markRemoved(kind, held.name, held.file.startAt);
        this.live[kind] = undefined;
      }

      if (name === undefined) {
        this.live[kind] = undefined;
        continue;
      }

      const file = await this.storage.read(kind, name);
      if (file === undefined) {
        // Deleted or quarantined between the listing and the read. Whoever
        // deleted it announced it; a quarantine is announced by the next sweep.
        this.live[kind] = undefined;
        continue;
      }

      const before = this.live[kind];
      const moved =
        before === undefined ||
        before.name !== name ||
        fingerprint(before.file) !== fingerprint(file);
      if (moved) {
        this.markChanged(kind, name, file);
      }
      this.live[kind] = { name, file };
    }
  }

  /**
   * Record the file a commit just wrote.
   *
   * The live slot keeps whichever name sorts later, so a poll whose `resetAt`
   * moved backwards cannot install a stale window as the current one — the same
   * hazard `reload` documents, and the same resolution. The patch is unguarded:
   * the client asked for that file and applies its own ordering rule to it.
   */
  put(kind: LedgerKind, name: string, file: LedgerFile): void {
    this.markChanged(kind, name, file);
    const held = this.live[kind];
    if (held === undefined || name >= held.name) {
      this.live[kind] = { name, file };
    }
  }

  /**
   * Announce a file that has been deleted from disk.
   *
   * Called by whoever did the deleting, because nothing else can know: a cache
   * holding one file per kind cannot derive removals from a listing.
   *
   * `startAt` comes from the caller rather than from anything held here, and both
   * callers take it from the file's own header — the name chooses what to open,
   * the header says what it was.
   */
  announceRemoved(kind: LedgerKind, name: string, startAt: Millis): void {
    this.markRemoved(kind, name, startAt);
    if (this.live[kind]?.name === name) {
      this.live[kind] = undefined;
    }
  }

  /**
   * Take everything that has moved since the last call, leaving the patch empty.
   *
   * Drained on every publish rather than only when a panel is listening: a patch
   * nobody consumes is discarded, whereas one that accumulated while no panel
   * existed would be replayed onto a client that had already hydrated past it.
   */
  drainPatch(): LedgerPatch {
    const patch: LedgerPatch = {
      changed: [...this.changed.values()],
      removed: [...this.removed.values()],
    };
    this.changed.clear();
    this.removed.clear();
    return patch;
  }

  /**
   * The newest file of a kind: the window still open, or the last one to close.
   *
   * It is what `meta` takes the reset countdowns from, what the status bar
   * draws, and what a hydrating panel is handed so it can work out which page to
   * ask for. Held rather than derived, so it costs a property read.
   */
  newest(kind: LedgerKind): LedgerFile | undefined {
    return this.live[kind]?.file;
  }

  private markChanged(kind: LedgerKind, name: string, file: LedgerFile): void {
    const key = `${kind}/${name}`;
    this.removed.delete(key);
    this.changed.set(key, file);
  }

  private markRemoved(kind: LedgerKind, name: string, startAt: Millis): void {
    const key = `${kind}/${name}`;
    this.changed.delete(key);
    this.removed.set(key, { kind, startAt });
  }
}

/**
 * Cheap proxy for "this file differs from the one we already held".
 *
 * `applySample` only ever appends rows or slides the final row's timestamp, so
 * the row count paired with that timestamp moves on every real change and never
 * on a re-read of unchanged bytes.
 *
 * Content-based rather than mtime-based on purpose: the one file this is asked
 * about is re-read every tick regardless, so its bytes are already in hand and a
 * stat would be a syscall spent re-deriving what they say.
 */
function fingerprint(file: LedgerFile): string {
  const last = file.samples[file.samples.length - 1];
  return `${file.samples.length}:${last === undefined ? '' : last[0]}`;
}
