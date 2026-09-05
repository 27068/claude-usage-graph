// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';

/**
 * Write a file by writing a temp file and renaming it over the target, so a
 * crash mid-write leaves the previous good file intact rather than a truncated
 * one.
 *
 * The retry loop is not paranoia. On POSIX, rename over an existing path is
 * atomic and always succeeds. On Windows it fails with EPERM/EACCES/EBUSY when
 * another process is renaming onto the same destination, or when an antivirus
 * scanner has the target open for a moment. Several VS Code windows contending
 * for `poll.lease` hit this routinely, so a few short retries turn a hard
 * failure into the atomic write the caller asked for.
 */

const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

let sequence = 0;

export async function atomicWrite(target: string, data: string, attempts = 5): Promise<void> {
  // Unique per writer: two processes must never share a temp path.
  sequence += 1;
  const temporary = `${target}.${process.pid}.${sequence}.tmp`;
  await fs.writeFile(temporary, data, 'utf8');

  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_CODES.has(code) || attempt >= attempts - 1) {
        await unlinkQuietly(temporary);
        throw error;
      }
      await delay(10 * 2 ** attempt);
    }
  }
}

async function unlinkQuietly(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch {
    // Leaving a stray temp file behind is better than masking the real error.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
