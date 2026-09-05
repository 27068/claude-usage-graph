// SPDX-License-Identifier: AGPL-3.0-only

import type { IClock } from './interfaces';
import type { Millis } from './types';

export class SystemClock implements IClock {
  now(): Millis {
    return Date.now();
  }
}

/**
 * A clock that can be pinned to a fixed instant and released again.
 *
 * Every view in this extension is a function of `now`, which is what makes the
 * interesting states unreachable by waiting: a pool that lapsed three hours ago,
 * a weekly cycle three weeks stale. Pinning the clock moves all of them at once
 * and keeps them consistent — the Now marker, the frame roll-forward, the status
 * bar countdown and the engine's own `meta.now` all read this one source, so
 * there is no way for the graph and the bar beside it to disagree about when it
 * is.
 *
 * Pinned rather than offset-and-running on purpose: a frozen instant is what a
 * screenshot and a second look ten minutes later have in common. Development
 * only; the composition root builds a `SystemClock` unless a scenario is loaded.
 */
export class ScenarioClock implements IClock {
  private pinned: Millis | undefined;

  now(): Millis {
    return this.pinned ?? Date.now();
  }

  /** Pass undefined to hand the clock back to real time. */
  pin(at: Millis | undefined): void {
    this.pinned = at;
  }

  get isPinned(): boolean {
    return this.pinned !== undefined;
  }
}
