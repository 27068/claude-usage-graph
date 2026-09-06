// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bundles the webview, stamping into it the moment it was built.
 *
 * The stamp is injected here rather than read off the file afterwards because
 * installing a vsix resets mtimes to extraction time. That reports a fresh build
 * for a bundle that was never rebuilt — which is the mistake section 4 of
 * `docs/DEVELOPING.md` exists to warn about, so a stamp that cannot see it would
 * be worse than none.
 *
 * The panel shows it only for a version carrying a prerelease suffix, so a
 * Marketplace build never displays one.
 */

import { build } from 'esbuild';

const builtAt = new Date().toISOString();

await build({
  entryPoints: ['src/webview/client/main.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'media/dashboard.js',
  define: { __BUILD_TIME__: JSON.stringify(builtAt) },
});

console.log(`media/dashboard.js  built ${builtAt}`);
