// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A promise-chain mutex: each task is appended to a tail promise, so tasks run
 * strictly in submission order no matter how long each one takes.
 *
 * Two details carry the whole design:
 *
 *  - `this.tail.then(fn, fn)` runs the next task whether the predecessor
 *    fulfilled *or* rejected. Using only the fulfil handler would let one failed
 *    write stall every subsequent write for the life of the process.
 *  - `this.tail` is assigned a *separately swallowed* chain. The value returned
 *    to the caller still rejects with the genuine error, but the queue itself
 *    can never carry a rejection forward and strand later tasks.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/**
 * One mutex per key. A poll writes a session file and a week file on the same
 * tick; those are independent paths, so they should proceed in parallel while
 * each stays serialized against itself.
 */
export class MutexRegistry {
  private readonly locks = new Map<string, Mutex>();

  for(key: string): Mutex {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }
    return lock;
  }

  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.for(key).runExclusive(fn);
  }
}
