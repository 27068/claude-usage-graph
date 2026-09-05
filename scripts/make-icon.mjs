// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Renders media/icon.png, the Marketplace and extension-list icon.
 *
 * Everything is drawn from signed distance fields at 4x and box-downsampled,
 * which is what keeps the staircase clean at the 32px and 16px sizes VS Code
 * actually shows it at — the Marketplace is the only place it appears at 128.
 *
 * Hand-rolled rather than pulled from a canvas library: one PNG, no runtime
 * dependency, and zlib is in the standard library.
 *
 *   node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 128;
const SS = 4; // supersample factor
const W = SIZE * SS;

/** The staircase, in 128-space with y down: flats where you idle, risers where you spend. */
const STEPS = [
  [16, 102],
  [40, 102],
  [40, 80],
  [64, 80],
  [64, 56],
  [92, 56],
  [92, 30],
  [106, 30],
];
const BASELINE = 102;
const WALL_X = 112;

const CORAL = [0xef, 0x8c, 0x64];
const RESET = [0xe5, 0x48, 0x4d];

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(px - cx) - hx;
  const dy = Math.abs(py - cy) - hy;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/** Height of the staircase at x, or null where it has not started or has ended. */
function stairAt(x) {
  if (x < STEPS[0][0] || x > STEPS[STEPS.length - 1][0]) return null;
  let y = STEPS[0][1];
  for (const [sx, sy] of STEPS) {
    if (sx <= x) y = sy;
  }
  return y;
}

const px = new Float64Array(W * W * 4);

for (let iy = 0; iy < W; iy++) {
  for (let ix = 0; ix < W; ix++) {
    // Sample at pixel centres, in 128-space.
    const x = (ix + 0.5) / SS;
    const y = (iy + 0.5) / SS;

    // Backdrop: a vertical gradient, so the icon reads as a surface rather than a swatch.
    const t = y / SIZE;
    let r = 0x33 + (0x1c - 0x33) * t;
    let g = 0x33 + (0x1c - 0x33) * t;
    let b = 0x3b + (0x21 - 0x3b) * t;
    let a = 1;

    const over = (cr, cg, cb, ca) => {
      if (ca <= 0) return;
      r = cr * ca + r * (1 - ca);
      g = cg * ca + g * (1 - ca);
      b = cb * ca + b * (1 - ca);
      a = ca + a * (1 - ca);
    };

    // Area under the line, brightest where it meets the line.
    const stair = stairAt(x);
    if (stair !== null && y >= stair && y <= BASELINE) {
      const depth = (y - stair) / Math.max(BASELINE - stair, 1);
      over(...CORAL, 0.30 * (1 - depth) + 0.07);
    }

    // Baseline: gives the fill an edge to sit on instead of fading into the backdrop.
    over(0x5a, 0x5a, 0x66, clamp01(0.75 - Math.abs(y - BASELINE - 0.5) * 1.6));

    // The line itself.
    let d = Infinity;
    for (let i = 1; i < STEPS.length; i++) {
      d = Math.min(d, sdSegment(x, y, ...STEPS[i - 1], ...STEPS[i]));
    }
    over(...CORAL, clamp01(5.0 - d));

    // The reset wall the live window runs into.
    over(...RESET, 0.95 * clamp01(2.0 - sdSegment(x, y, WALL_X, 18, WALL_X, 108)));

    // Clip to the rounded square last, so every layer above is trimmed by it.
    a *= clamp01(0.5 - sdRoundRect(x, y, 0, 0, SIZE, SIZE, 22) * SS);

    const o = (iy * W + ix) * 4;
    px[o] = r;
    px[o + 1] = g;
    px[o + 2] = b;
    px[o + 3] = a * 255;
  }
}

// Box-downsample. Premultiplied, or the transparent corners drag the edge dark.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const o = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        const pa = px[o + 3] / 255;
        r += px[o] * pa;
        g += px[o + 1] * pa;
        b += px[o + 2] * pa;
        a += pa;
      }
    }
    const n = SS * SS;
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = a > 0 ? Math.round(r / a) : 0;
    raw[o + 1] = a > 0 ? Math.round(g / a) : 0;
    raw[o + 2] = a > 0 ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round((a / n) * 255);
  }
}

const CRC = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = -1;
  for (const byte of body) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeInt32BE(c ^ -1);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // truecolour with alpha
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
