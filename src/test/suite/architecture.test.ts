// SPDX-License-Identifier: AGPL-3.0-only

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** out/test/suite -> project root */
const ROOT = path.join(__dirname, '..', '..', '..');

function sourceFiles(directory: string): string[] {
  const absolute = path.join(ROOT, directory);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(path.join(directory, entry.name))
        : entry.name.endsWith('.ts')
          ? [path.join(directory, entry.name)]
          : [],
    );
}

/**
 * The rule the whole design rests on.
 *
 * `core/` never importing vscode is what keeps the persistent engine
 * independent of the UI *and* what lets this entire suite run in a bare
 * terminal — no VS Code download, no display, no network. It is easy to break
 * with one convenient import, so it is asserted rather than trusted.
 */
describe('architecture', () => {
  it('keeps src/core free of any vscode import', () => {
    const offenders = sourceFiles('src/core').filter((file) =>
      /from ['"]vscode['"]|require\(['"]vscode['"]\)/.test(
        fs.readFileSync(path.join(ROOT, file), 'utf8'),
      ),
    );

    assert.deepStrictEqual(
      offenders,
      [],
      `core must stay vscode-free; these import it: ${offenders.join(', ')}`,
    );
  });

  it('keeps the credential reader vscode-free too, so it stays unit-testable', () => {
    const offenders = sourceFiles('src/auth').filter((file) =>
      /from ['"]vscode['"]/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')),
    );

    assert.deepStrictEqual(offenders, []);
  });

  it('has no refresh or write path anywhere in the auth layer', () => {
    // The read-only guarantee is the reason no token rotation race is possible.
    // Anything that POSTs to a token endpoint would silently reintroduce it.
    for (const file of sourceFiles('src/auth')) {
      const contents = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(
        !/oauth\/token|grant_type|refresh_token=/.test(contents),
        `${file} appears to contain a token refresh path`,
      );
      assert.ok(
        !/fs\.writeFile|writeFileSync/.test(contents),
        `${file} appears to write to disk`,
      );
    }
  });

  it('subscribes to webview messages before handing it any HTML', () => {
    // Assigning `html` starts the page loading, and the client posts `ready` as
    // soon as it is up. Registering the listener afterwards races that message;
    // losing it means `hydrate` never fires and the panel sits empty until the
    // next poll. This shipped once — hence the guard.
    const source = fs.readFileSync(path.join(ROOT, 'src/vscode/dashboardPanel.ts'), 'utf8');
    const listener = source.indexOf('onDidReceiveMessage');
    const html = source.indexOf('webview.html =');

    assert.ok(listener !== -1 && html !== -1, 'expected both the listener and the html assignment');
    assert.ok(
      listener < html,
      'onDidReceiveMessage must be registered before webview.html is assigned',
    );
  });

  it('routes every write onto a shared path through the atomic helper', () => {
    // Renaming onto an existing path throws EPERM on Windows when two processes
    // contend — precisely what several VS Code windows sharing poll.lease do.
    // Renaming to a fresh unique path (quarantining a corrupt file) is exempt,
    // because nothing can be holding the destination.
    for (const file of ['src/core/ledgerStorage.ts', 'src/core/pollSchedule.ts']) {
      const contents = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(contents.includes('atomicWrite'), `${file} should write via atomicWrite`);

      const unguarded = contents
        .split('\n')
        .filter((line) => /fs\.rename\(/.test(line) && !/quarantine/.test(line));

      assert.deepStrictEqual(
        unguarded,
        [],
        `${file} renames onto a possibly-existing path: ${unguarded.join(' / ')}`,
      );
    }
  });
});
