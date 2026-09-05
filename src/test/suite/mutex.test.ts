// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import { Mutex, MutexRegistry } from '../../core/mutex';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Mutex', () => {
  it('runs tasks in submission order regardless of their duration', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    // Descending durations: without serialization these finish 3, 2, 1.
    const first = mutex.runExclusive(async () => {
      await delay(30);
      order.push(1);
    });
    const second = mutex.runExclusive(async () => {
      await delay(20);
      order.push(2);
    });
    const third = mutex.runExclusive(async () => {
      await delay(1);
      order.push(3);
    });

    await Promise.all([first, second, third]);
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it('never overlaps two tasks', async () => {
    const mutex = new Mutex();
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        mutex.runExclusive(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(2);
          active -= 1;
        }),
      ),
    );

    assert.strictEqual(maxActive, 1, 'two tasks were in flight at once');
  });

  it('does not let a rejected task stall the queue behind it', async () => {
    const mutex = new Mutex();

    // Queued *while the failure is still in flight* — the poisoning scenario.
    const failing = mutex.runExclusive(async () => {
      await delay(10);
      throw new Error('boom');
    });
    const queued = mutex.runExclusive(async () => 'after');

    assert.strictEqual(await queued, 'after');
    await assert.rejects(failing, /boom/);
  });

  it('still surfaces the genuine rejection to the caller', async () => {
    const mutex = new Mutex();
    await assert.rejects(
      mutex.runExclusive(async () => {
        throw new TypeError('specific failure');
      }),
      (error: Error) => error instanceof TypeError && error.message === 'specific failure',
    );
  });

  it('survives a long run of alternating failures and successes', async () => {
    const mutex = new Mutex();
    const results: string[] = [];

    const tasks = Array.from({ length: 20 }, (_unused, index) =>
      mutex
        .runExclusive(async () => {
          if (index % 2 === 0) {
            throw new Error(`fail-${index}`);
          }
          return `ok-${index}`;
        })
        .then(
          (value) => results.push(value),
          () => results.push(`caught-${index}`),
        ),
    );

    await Promise.all(tasks);
    assert.strictEqual(results.length, 20, 'a task never settled');
    assert.strictEqual(results[19], 'ok-19', 'the last task did not run');
  });
});

describe('MutexRegistry', () => {
  it('returns a stable lock per key and distinct locks across keys', () => {
    const registry = new MutexRegistry();
    assert.strictEqual(registry.for('a'), registry.for('a'));
    assert.notStrictEqual(registry.for('a'), registry.for('b'));
  });

  it('lets independent keys proceed in parallel', async () => {
    const registry = new MutexRegistry();
    const order: string[] = [];

    // 'a' is slow; 'b' must not wait behind it.
    const slow = registry.runExclusive('a', async () => {
      await delay(30);
      order.push('a');
    });
    const fast = registry.runExclusive('b', async () => {
      await delay(1);
      order.push('b');
    });

    await Promise.all([slow, fast]);
    assert.deepStrictEqual(order, ['b', 'a']);
  });
});
