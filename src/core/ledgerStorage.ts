// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import * as path from 'path';
import { atomicWrite } from './atomicWrite';
import type { ILedgerStorage, ILogger } from './interfaces';
import { MutexRegistry } from './mutex';
import { isLedgerFileName, namesForOverlap, namesForStartRange } from './fileNames';
import type { LedgerFile, LedgerKind, Millis } from './types';

const DIRECTORY: Record<LedgerKind, string> = {
  five_hour: 'sessions',
  seven_day: 'weeks',
};

/** The suffix `read` appends when it sets a damaged file aside. */
const QUARANTINE_PATTERN = /\.corrupt-(\d+)$/;

/**
 * One file per session / per weekly cycle, each written atomically.
 *
 * The critical section spans read-modify-write rather than just the write.
 * Serializing only the write would still let two overlapping ticks both read the
 * same array, mutate their own copies, and have the second clobber the first.
 */
export class FileLedgerStorage implements ILedgerStorage {
  private readonly locks = new MutexRegistry();

  constructor(
    private readonly root: string,
    private readonly logger: ILogger,
  ) {}

  async ensureLayout(): Promise<void> {
    await fs.mkdir(path.join(this.root, DIRECTORY.five_hour), { recursive: true });
    await fs.mkdir(path.join(this.root, DIRECTORY.seven_day), { recursive: true });
  }

  async list(kind: LedgerKind): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.directoryFor(kind));
    } catch (error) {
      if (isMissing(error)) {
        return [];
      }
      throw error;
    }
    // Names are UTC basic format, so lexicographic order is chronological.
    return entries.filter(isLedgerFileName).sort();
  }

  /**
   * Clear out quarantined files that have outlived the retention window.
   *
   * `read` renames a damaged file to `<name>.corrupt-<millis>` so it survives
   * for a hand recovery, and that name no longer matches `isLedgerFileName` —
   * which means `list` cannot see it and nothing was ever deleting it. Left
   * alone they accumulate for the life of the install.
   *
   * The instant is taken from the suffix rather than from the file's mtime,
   * because a rename does not change mtime on every filesystem and the suffix
   * is written by us at the moment of quarantine.
   */
  async sweepQuarantined(olderThan: Millis): Promise<number> {
    let removed = 0;
    for (const kind of Object.keys(DIRECTORY) as LedgerKind[]) {
      let entries: string[];
      try {
        entries = await fs.readdir(this.directoryFor(kind));
      } catch (error) {
        if (isMissing(error)) {
          continue;
        }
        throw error;
      }

      for (const name of entries) {
        const quarantinedAt = QUARANTINE_PATTERN.exec(name);
        if (quarantinedAt === null || Number(quarantinedAt[1]) >= olderThan) {
          continue;
        }
        try {
          await fs.unlink(path.join(this.directoryFor(kind), name));
          removed += 1;
        } catch (error) {
          if (!isMissing(error)) {
            this.logger.warn(`Could not delete quarantined ${name}: ${String(error)}`);
          }
        }
      }
    }
    return removed;
  }

  async read(kind: LedgerKind, name: string): Promise<LedgerFile | undefined> {
    return this.locks.runExclusive(this.pathFor(kind, name), () =>
      this.readUnlocked(kind, name),
    );
  }

  /**
   * The oldest file on record, which is where paging backwards has to stop.
   *
   * Names sort chronologically, so this is the first one — but it walks forward
   * rather than reading `names[0]` and giving up, because a file can be deleted
   * or quarantined between the listing and the read. The loop stops at the first
   * one that comes back, so the ordinary cost is a listing and a single read.
   */
  async oldest(kind: LedgerKind): Promise<LedgerFile | undefined> {
    for (const name of await this.list(kind)) {
      const file = await this.read(kind, name);
      if (file !== undefined) {
        return file;
      }
    }
    return undefined;
  }

  /**
   * A page of history, resolved from the listing rather than from the cache.
   *
   * This is the query the dashboard will page by, and it is deliberately at the
   * storage layer: it depends on the directory and nothing else, so it is
   * unaffected by `LedgerCache` ceasing to be a mirror. The bound is proved in
   * `namesForStartRange`; the filter below is the half that makes a loose bound
   * harmless, and must not be dropped on the grounds that the names looked
   * right.
   *
   * Sequentially, because a page is three files at a day and one at a cycle, and
   * `read` takes a per-path lock anyway. If a range ever spans thousands of
   * files, that is the thing to reconsider — not this loop.
   */
  async readRange(kind: LedgerKind, from: Millis, to: Millis): Promise<LedgerFile[]> {
    const names = namesForStartRange(await this.list(kind), from, to);
    const files: LedgerFile[] = [];
    for (const name of names) {
      const file = await this.read(kind, name);
      if (file === undefined) {
        // Deleted or quarantined between the listing and the read.
        continue;
      }
      if (file.startAt < from || file.startAt >= to) {
        continue;
      }
      files.push(file);
    }
    return files;
  }

  /**
   * The same page, by intersection rather than by start.
   *
   * The header test is deliberately inclusive at both ends — a cycle whose reset
   * lands exactly on the frame's left edge is kept, because the calendar draws a
   * wall there and losing it would silently drop a reset the API reported. One
   * extra file, at most, and it is filtered out again by the selector if it has
   * nothing inside the frame.
   */
  async readOverlapping(kind: LedgerKind, from: Millis, to: Millis): Promise<LedgerFile[]> {
    const names = namesForOverlap(await this.list(kind), from, to);
    const files: LedgerFile[] = [];
    for (const name of names) {
      const file = await this.read(kind, name);
      if (file === undefined) {
        continue;
      }
      if (file.resetAt < from || file.startAt > to) {
        continue;
      }
      files.push(file);
    }
    return files;
  }

  async commit(
    kind: LedgerKind,
    name: string,
    seed: () => LedgerFile,
    mutate: (file: LedgerFile) => void,
  ): Promise<LedgerFile> {
    const target = this.pathFor(kind, name);
    return this.locks.runExclusive(target, async () => {
      const file = (await this.readUnlocked(kind, name)) ?? seed();
      mutate(file);
      await atomicWrite(target, JSON.stringify(file));
      return file;
    });
  }

  async remove(kind: LedgerKind, name: string): Promise<void> {
    const target = this.pathFor(kind, name);
    await this.locks.runExclusive(target, async () => {
      try {
        await fs.unlink(target);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
    });
  }

  private directoryFor(kind: LedgerKind): string {
    return path.join(this.root, DIRECTORY[kind]);
  }

  private pathFor(kind: LedgerKind, name: string): string {
    return path.join(this.directoryFor(kind), name);
  }

  /** Caller must hold the lock for this path. */
  private async readUnlocked(kind: LedgerKind, name: string): Promise<LedgerFile | undefined> {
    const target = this.pathFor(kind, name);
    let raw: string;
    try {
      raw = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isLedgerFile(parsed)) {
        throw new Error('shape does not match a ledger file');
      }
      return parsed;
    } catch (error) {
      // One bad byte must never brick the extension. Move the damaged file aside
      // so it is recoverable by hand, and carry on as though it were absent.
      const quarantine = `${target}.corrupt-${Date.now()}`;
      this.logger.error(
        `Ledger file ${name} is unreadable (${String(error)}); moved to ${path.basename(quarantine)}`,
      );
      try {
        await fs.rename(target, quarantine);
      } catch (renameError) {
        this.logger.error(`Could not quarantine ${name}: ${String(renameError)}`);
      }
      return undefined;
    }
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isLedgerFile(value: unknown): value is LedgerFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<LedgerFile>;
  return (
    candidate.v === 1 &&
    (candidate.kind === 'five_hour' || candidate.kind === 'seven_day') &&
    typeof candidate.startAt === 'number' &&
    typeof candidate.resetAt === 'number' &&
    Array.isArray(candidate.cols) &&
    Array.isArray(candidate.samples)
  );
}
