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

  // The auth layer was asserted read-only outright until it had to renew. What
  // follows is narrower and covers the same ground, because each of these three
  // shapes turns a renewal into a silent sign-out: the credential looks healthy
  // for as long as nobody spends it, so the damage surfaces minutes later,
  // somewhere else, with nothing to connect it back. That delay is what no other
  // test can catch, and the reason these are asserted rather than reviewed for.

  it('keeps the credential reader itself read-only', () => {
    // Every poll goes through this file and only some go through the refresher,
    // so a write reachable from the read path would run orders of magnitude more
    // often than one that is not.
    const contents = fs.readFileSync(path.join(ROOT, 'src/auth/credentialReader.ts'), 'utf8');

    assert.ok(!/writeFile|fs\.open|fs\.rename|unlink/.test(contents), 'the reader must not write');
    assert.ok(!/fetch\(/.test(contents), 'the reader must not make network calls');
  });

  it('never lets the refresher write onto the credential file directly', () => {
    // A torn write leaves other processes reading half a credential, and there
    // is no copy to go back to. The temp file is the write, and the rename is
    // what makes it appear whole.
    const contents = fs.readFileSync(path.join(ROOT, 'src/auth/credentialRefresher.ts'), 'utf8');

    assert.ok(contents.includes('fs.rename('), 'the renewed credential must arrive by rename');

    const direct = contents
      .split('\n')
      .filter((line) => /writeFile\(/.test(line) && !/temporary|handle\./.test(line));

    assert.deepStrictEqual(direct, [], `writes outside the temp file: ${direct.join(' / ')}`);

    // One unlink is allowed and it is guarded by `written`: an empty temp file
    // from a request that failed is not a credential and must not be left
    // looking like one. Any other unlink is destroying the only copy of a grant
    // that has already been spent.
    const unlinks = contents.split('\n').filter((line) => /unlink/.test(line));
    assert.strictEqual(unlinks.length, 1, `expected exactly one unlink, found ${unlinks.length}`);
    assert.ok(
      /if \(!written\) \{\s*\n\s*await fs\.unlink\(/.test(contents),
      'the only unlink must be the one guarded by `written`',
    );
  });

  it('never spawns the Claude Code CLI', () => {
    // `claude doctor` renews but does not await its own credential write before
    // exiting, so whether the write lands is decided by how long the rest of the
    // run takes. It waits on `npm -g config get prefix`, and an extension host's
    // inherited PATH has no npm: the lookup fails, the run ends ~300ms sooner,
    // and the refresh token is spent with nothing persisted. The store still
    // reads healthy until something presents the spent token.
    const offenders = sourceFiles('src').filter(
      (file) =>
        !file.includes('test') &&
        /spawn\(|execFile\(\s*['"`]claude|exec\(\s*['"`]claude/.test(
          fs.readFileSync(path.join(ROOT, file), 'utf8'),
        ),
    );

    assert.deepStrictEqual(offenders, [], `these start a child process: ${offenders.join(', ')}`);
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
