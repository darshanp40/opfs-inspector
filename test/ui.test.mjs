// The panel, driven like a person would, against ops.js in the same page.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { startServer } from './server.mjs';
import { engines } from './browsers.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile as readDisk, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server;
let origin;
let dbBase64; // a database with table t (250 rows) and view v
let bigOld; // a 1 MB database whose names start with "old"
let bigNew; // the same database after a commit renamed every row to "new"
let walMid; // WAL mode: {db, wal} with every row renamed to "mid" in the -wal file
let walRestarted; // after a checkpoint and a new -wal file that renames the last row
before(async () => ({ server, origin } = await startServer()));
before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ui-db-'));
  const file = join(dir, 'app.db');
  const db = new DatabaseSync(file);
  db.exec('create table t (id integer primary key, name text, score real, data blob); create view v as select id from t where id <= 10');
  const insert = db.prepare('insert into t (name, score, data) values (?, ?, ?)');
  insert.run('<img src=x onerror="document.title=1">', 1.5, new Uint8Array([1, 2, 3]));
  for (let i = 2; i <= 250; i++) insert.run(`row ${i}`, i / 2, null);
  db.close();
  dbBase64 = (await readDisk(file)).toString('base64');
  const big = new DatabaseSync(join(dir, 'big.db'));
  big.exec('create table t (id integer primary key, name text)');
  const add = big.prepare('insert into t (name) values (?)');
  for (let i = 0; i < 3000; i++) add.run(`old ${'x'.repeat(300)}`);
  bigOld = (await readDisk(join(dir, 'big.db'))).toString('base64');
  big.exec(`update t set name = 'new ' || substr(name, 5)`);
  big.close();
  bigNew = (await readDisk(join(dir, 'big.db'))).toString('base64');
  assert.equal(bigOld.length, bigNew.length);
  // Files are read while the connection is open, so the -wal file stays.
  const walFile = join(dir, 'wal.db');
  const w = new DatabaseSync(walFile);
  w.exec('pragma journal_mode = wal; pragma wal_autocheckpoint = 0; create table t (id integer primary key, name text)');
  const put = w.prepare('insert into t (name) values (?)');
  for (let i = 0; i < 3000; i++) put.run(`old ${'x'.repeat(300)}`);
  w.exec('pragma wal_checkpoint(truncate)');
  w.exec(`update t set name = 'mid ' || substr(name, 5)`);
  const files = async () => ({ db: (await readDisk(walFile)).toString('base64'), wal: (await readDisk(`${walFile}-wal`)).toString('base64') });
  walMid = await files();
  w.exec('pragma wal_checkpoint(passive)');
  // The next commit starts the -wal file again, in place, with new salts.
  w.exec(`update t set name = 'new ' || substr(name, 5) where id = 3000`);
  walRestarted = await files();
  w.close();
  assert.equal(walMid.wal.length, walRestarted.wal.length);
  await rm(dir, { recursive: true });
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// WebKit's OPFS does not work in Playwright, see ops.test.mjs.
for (const engine of engines.filter((e) => e.name !== 'webkit')) {
  describe(`panel in ${engine.name}`, { timeout: 120_000 }, () => {
    let browser;
    let page;
    const row = (path) => page.locator(`.row[data-path="${path}"]`);
    const status = () => page.locator('#status');

    before(async () => {
      browser = await engine.type.launch();
      // axe needs a page from a context it can open more pages in.
      page = await (await browser.newContext()).newPage();
      await page.goto(`${origin}/panel.html?harness`);
      await page.locator('.row[data-path=""]').waitFor();
    });
    after(() => browser.close());

    async function answer(button, value) {
      await page.click(button);
      const input = page.locator('#card-body form input');
      await input.fill(value);
      await page.locator('#card-body form button[type=submit]').click();
    }

    // Runs formatJson in the page, so each engine's JSON.parse messages are covered.
    const format = (text, options) => page.evaluate(async ({ text, options }) => {
      const { formatJson } = await import('/panel/format.js');
      try {
        return formatJson(text, options);
      } catch (error) {
        return `${error.name}: ${error.message}`;
      }
    }, { text, options });

    it('formatJson indents and sorts keys at every level, keeping array order', async () => {
      assert.equal(await format('{"b":1,"a":[3,1]}', { indent: 2, sortKeys: true }), '{\n  "a": [\n    3,\n    1\n  ],\n  "b": 1\n}');
    });

    it('formatJson keeps numbers exactly as written', async () => {
      assert.equal(await format('[12345678901234567890,1.0]', { indent: '\t', sortKeys: false }), '[\n\t12345678901234567890,\n\t1.0\n]');
    });

    it('formatJson throws a SyntaxError with the line and column', async () => {
      assert.match(await format('{\n  "a": 1,\n}', { indent: 2 }), /^SyntaxError: .*line 3, column 1/);
      assert.match(await format('{"a": ', { indent: 2 }), /^SyntaxError: .*line 1, column 7/);
    });

    it('footer shows usage', async () => {
      await page.waitForFunction(() => document.getElementById('usage').textContent);
      assert.match(await page.locator('#usage').textContent(), /of/);
    });

    it('creates a folder and a file inside it', async () => {
      await row('').click();
      await answer('#new-folder', 'notes');
      await row('notes').waitFor();
      await row('notes').click();
      await answer('#new-file', 'todo.txt');
      await row('notes/todo.txt').waitFor();
      assert.match(await status().textContent(), /Created todo\.txt/);
    });

    it('edits and saves a text file', async () => {
      await row('notes/todo.txt').click();
      const editor = page.locator('.cm-content');
      await editor.fill('buy milk');
      assert.equal(await page.getByRole('button', { name: 'Save' }).isDisabled(), false);
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('Saved'));
      const text = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('notes');
        return (await (await dir.getFileHandle('todo.txt')).getFile()).text();
      });
      assert.equal(text, 'buy milk');
      assert.match(await row('notes/todo.txt').locator('.size').textContent(), /8 B/);
    });

    it('blocks leaving a file with unsaved changes', async () => {
      await page.locator('.cm-content').fill('changed');
      await row('notes').click();
      assert.match(await status().textContent(), /Save or discard/);
      await page.getByRole('button', { name: 'Discard changes' }).click();
    });

    it('renames the file', async () => {
      await row('notes/todo.txt').click();
      await answer('#rename', 'done.txt');
      await row('notes/done.txt').waitFor();
      assert.equal(await row('notes/todo.txt').count(), 0);
    });

    it('clicking a path part selects that folder', async () => {
      await row('notes/done.txt').click();
      await page.locator('#crumbs button', { hasText: 'notes' }).click();
      await page.waitForFunction(() => document.querySelector('.row[data-path="notes"]').classList.contains('selected'));
    });

    it('a crumb keeps focus after it is used', async () => {
      await row('notes/done.txt').click();
      await page.locator('#crumbs button', { hasText: 'notes' }).focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.row[data-path="notes"]').classList.contains('selected'));
      assert.deepEqual(await page.evaluate(() => [document.activeElement.parentElement.id, document.activeElement.textContent]), ['crumbs', 'notes']);
    });

    it('opens an SVG file in the editor and saves it', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const writable = await (await root.getFileHandle('dot.svg', { create: true })).createWritable();
        await writable.write('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        await writable.close();
      });
      await page.click('#refresh');
      await row('dot.svg').click();
      await page.locator('#card-head', { hasText: 'dot.svg' }).waitFor();
      assert.deepEqual(await page.locator('#card-tabs [role=tab]').allTextContents(), ['Editor', 'Details']);
      await page.locator('.cm-content').fill('<svg/>');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('Saved dot.svg'));
      const text = await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('dot.svg')).getFile()).text());
      assert.equal(text, '<svg/>');
    });

    it('JSON file shows highlighted tokens', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const writable = await (await root.getFileHandle('data.json', { create: true })).createWritable();
        await writable.write('{"name": "x", "n": 1}');
        await writable.close();
      });
      await page.click('#refresh');
      await row('data.json').click();
      await page.locator('.cm-editor').waitFor({ state: 'visible' });
      await page.locator('.cm-content span[class*="tok-"]').first().waitFor();
      assert.equal(await page.locator('.cm-content').getAttribute('aria-label'), 'Contents of data.json');
    });

    it('rows have type icons', async () => {
      const rows = await page.locator('.row').count();
      assert.ok(rows > 1);
      assert.equal(await page.locator('.row svg').count(), rows);
    });

    it('tables list and first page of rows', async () => {
      await putDb(page);
      await page.click('#refresh');
      await row('app.db').click();
      await page.locator('.badge', { hasText: 'SQLite database' }).waitFor();
      assert.deepEqual(await page.locator('#card-tabs [role=tab]').allTextContents(), ['Table', 'Query', 'Details']);
      await page.locator('.grid tbody tr').first().waitFor();
      assert.deepEqual(await page.locator('.sql-view select option').allTextContents(), ['t', 'v (view)']);
      assert.deepEqual(await page.locator('.grid th .type').allTextContents(), ['INTEGER', 'TEXT', 'REAL', 'BLOB']);
      assert.equal(await page.locator('.grid tbody tr').count(), 100);
      assert.match(await page.locator('.sql-view .count').textContent(), /Rows 1–100 of 250/);
      // Site values are text, never markup.
      const first = await page.locator('.grid tbody tr').first().locator('td').allTextContents();
      assert.deepEqual(first.slice(0, 3), ['1', '<img src=x onerror="document.title=1">', '1.5']);
      assert.match(first[3], /^BLOB, 3/);
      assert.equal(await page.locator('#card-body img').count(), 0);
      assert.match(await page.locator('.snap').textContent(), /Snapshot taken/);
    });

    it('Next shows rows 101 to 200', async () => {
      await page.getByRole('button', { name: 'Next' }).click();
      await page.locator('.sql-view .count', { hasText: 'Rows 101–200 of 250' }).waitFor();
      assert.equal(await page.locator('.grid tbody tr').first().locator('td').first().textContent(), '101');
      assert.equal(await page.getByRole('button', { name: 'Previous' }).isDisabled(), false);
    });

    it('query select works, and a write is refused', async () => {
      const run = async (sql) => {
        await page.locator('.query-editor .cm-content').fill(sql);
        await page.locator('.query-editor .cm-content').press('ControlOrMeta+Enter');
        await page.locator('.sql-result').filter({ hasNotText: 'Running' }).waitFor();
      };
      const result = () => page.locator('.sql-result').textContent();
      await page.getByRole('tab', { name: 'Query' }).click();
      await page.locator('.query-editor .cm-content').waitFor();
      await run('select count(*) from t');
      await page.locator('.sql-result .grid td', { hasText: '250' }).waitFor();
      await run('delete from t');
      await page.locator('.sql-result .note.error').waitFor();
      assert.match(await result(), /readonly|query_only/);
      await run('select 1; select 2');
      await page.locator('.sql-result .note.error', { hasText: 'Run one statement at a time.' }).waitFor();
      await page.getByRole('button', { name: 'Reload snapshot' }).click();
      await page.locator('.snap', { hasText: 'Snapshot taken' }).waitFor();
      await run('select count(*) from t');
      await page.locator('.sql-result .grid td', { hasText: '250' }).waitFor();
      await page.getByRole('tab', { name: 'Table' }).click();
      await page.locator('.sql-view .count', { hasText: /of 250/ }).waitFor();
    });

    it('deletes a folder after asking', async () => {
      await row('notes').click();
      await page.click('#delete');
      await page.locator('#card-body button.danger', { hasText: 'Delete' }).click();
      await page.waitForFunction(() => !document.querySelector('.row[data-path="notes"]'));
      assert.match(await status().textContent(), /Deleted notes/);
    });

    it('lists Storage Buckets in the storage picker', async (t) => {
      if (engine.name !== 'chromium') return t.skip('only Chromium has Storage Buckets');
      await page.evaluate(async () => {
        const dir = await (await navigator.storageBuckets.open('app-db')).getDirectory();
        await dir.getFileHandle('bucket.db', { create: true });
      });
      await page.click('#refresh');
      await page.selectOption('#area', 'bucket:app-db');
      await row('bucket.db').waitFor();
    });

    it('dark theme', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload();
      await row('').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    });

    // A page in its own context, so its files do not mix with the other tests.
    async function freshPage(names, folder = '') {
      const p = await (await browser.newContext()).newPage();
      await p.goto(`${origin}/panel.html?harness`);
      await p.evaluate(async ({ names, folder }) => {
        let dir = await navigator.storage.getDirectory();
        for (const part of folder.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create: true });
        for (let i = 0; i < names.length; i += 500) {
          await Promise.all(names.slice(i, i + 500).map((n) => (n.endsWith('/') ? dir.getDirectoryHandle(n.slice(0, -1), { create: true }) : dir.getFileHandle(n, { create: true }))));
        }
      }, { names, folder });
      return p;
    }
    // Writes the fixture database into the root of a page's OPFS.
    const putDb = (p, name = 'app.db') => p.evaluate(async ({ name, b64 }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const writable = await (await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true })).createWritable();
      await writable.write(bytes);
      await writable.close();
    }, { name, b64: dbBase64 });
    const manyNames = (n) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(5, '0')}.txt`);
    const focused = (p) => p.evaluate(() => document.activeElement.dataset.path);

    it('arrow keys move focus, Right expands, Left collapses', async () => {
      const p = await freshPage(['a/', 'b/', 'c.txt']);
      await p.evaluate(async () => (await (await navigator.storage.getDirectory()).getDirectoryHandle('a')).getFileHandle('inner.txt', { create: true }));
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('c.txt').waitFor();
      assert.equal(await p.getAttribute('#tree', 'aria-multiselectable'), 'true');
      await r('').click();
      await p.keyboard.press('ArrowDown');
      assert.equal(await focused(p), 'a');
      assert.equal(await p.locator('#tree [tabindex="0"]').count(), 1);
      await p.keyboard.press('ArrowRight');
      await r('a/inner.txt').waitFor();
      assert.equal(await r('a').getAttribute('aria-expanded'), 'true');
      assert.equal(await focused(p), 'a');
      assert.deepEqual(await Promise.all(['', 'a', 'a/inner.txt'].map((path) => r(path).getAttribute('aria-level'))), ['1', '2', '3']);
      await p.keyboard.press('ArrowRight');
      assert.equal(await focused(p), 'a/inner.txt');
      await p.keyboard.press('ArrowLeft');
      assert.equal(await focused(p), 'a');
      await p.keyboard.press('ArrowLeft');
      await p.waitForFunction(() => !document.querySelector('.row[data-path="a/inner.txt"]'));
      assert.equal(await r('a').getAttribute('aria-expanded'), 'false');
      await p.keyboard.press('End');
      assert.equal(await focused(p), 'c.txt');
      await p.keyboard.press('Home');
      assert.equal(await focused(p), '');
      await p.keyboard.press('b');
      assert.equal(await focused(p), 'b');
      await p.keyboard.press('Enter');
      await p.locator('#card-head', { hasText: 'b' }).waitFor();
      assert.equal(await r('b').getAttribute('aria-selected'), 'true');
      await p.context().close();
    });

    it('Ctrl/Cmd+click adds, Shift+click selects a range, Ctrl/Cmd+A selects all in view', async () => {
      const p = await freshPage(['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      const count = () => p.locator('#tree [aria-selected="true"]').count();
      await r('f1.txt').click();
      await r('f3.txt').click({ modifiers: ['ControlOrMeta'] });
      assert.equal(await count(), 2);
      await r('f5.txt').click({ modifiers: ['Shift'] });
      assert.equal(await count(), 3);
      await p.keyboard.press('ControlOrMeta+a');
      assert.equal(await count(), 5);
      assert.match(await p.locator('#status').textContent(), /5 items selected/);
      await p.context().close();
    });

    it('10,000 files', async () => {
      const p = await freshPage(manyNames(10_000), 'big');
      await p.reload();
      await p.locator('.row[data-path="big"]').click();
      const start = Date.now();
      await p.keyboard.press('ArrowRight');
      await p.locator('.row[data-path="big/f00000.txt"]').waitFor();
      const took = Date.now() - start;
      console.log(`# ${engine.name}: 10,000-file folder drew its first row in ${took} ms`);
      // Firefox reads each file's size slowly (about 0.5 ms each), so it gets a looser guard.
      const limit = engine.name === 'firefox' ? 10_000 : 1500;
      assert.ok(took < limit, `${took} ms`);
      assert.ok((await p.locator('.row').count()) < 200);
      await p.keyboard.press('End');
      assert.equal(await p.evaluate(() => document.activeElement.querySelector('.name').textContent), 'f09999.txt');
      // Shift+End also scrolls the focused row into view.
      await p.keyboard.press('Home');
      await p.keyboard.press('Shift+End');
      assert.equal(await focused(p), 'big/f09999.txt');
      assert.ok(await p.evaluate(() => {
        const row = document.activeElement.getBoundingClientRect();
        const tree = document.getElementById('tree').getBoundingClientRect();
        return row.top >= tree.top && row.bottom <= tree.bottom;
      }), 'last row is inside the tree viewport');
      await p.context().close();
    });

    it('rows fill the tree when it grows', async () => {
      const p = await freshPage(manyNames(500));
      await p.setViewportSize({ width: 1000, height: 220 });
      await p.reload();
      await p.locator('.row[data-path="f00000.txt"]').waitFor();
      await p.setViewportSize({ width: 1000, height: 1400 });
      // The last drawn row reaches the bottom of the visible tree, with no scroll.
      await p.waitForFunction(() => {
        const tree = document.getElementById('tree');
        const rows = [...tree.querySelectorAll('.row')];
        return tree.clientHeight > 1000 && Math.max(...rows.map((r) => r.offsetTop + r.offsetHeight)) >= tree.scrollTop + tree.clientHeight;
      }, null, { timeout: 2000 });
      await p.context().close();
    });

    it('typing a capital letter jumps without selecting a range', async () => {
      const p = await freshPage(['a.txt', 'Report.txt', 'z.txt']);
      await p.reload();
      await p.locator('.row[data-path="a.txt"]').click();
      await p.keyboard.press('Shift+R');
      assert.equal(await focused(p), 'Report.txt');
      assert.equal(await p.locator('#tree [aria-selected="true"]').count(), 1);
      await p.context().close();
    });

    it('collapsing a folder drops its hidden rows from the selection', async () => {
      const p = await freshPage(['x.txt', 'y.txt'], 'd');
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('d').click();
      await p.keyboard.press('ArrowRight');
      await r('d/x.txt').click();
      await r('d/y.txt').click({ modifiers: ['ControlOrMeta'] });
      assert.match(await p.locator('#status').textContent(), /2 items selected/);
      await r('d').locator('.twisty').click();
      await p.waitForFunction(() => !document.querySelector('.row[data-path="d/x.txt"]'));
      assert.doesNotMatch(await p.locator('#status').textContent(), /items selected/);
      await r('d').locator('.twisty').click();
      await r('d/x.txt').waitFor();
      assert.equal(await p.locator('#tree [aria-selected="true"]').count(), 0);
      await p.context().close();
    });

    it('a Shift range never selects the root', async () => {
      const p = await freshPage(['f1.txt', 'f2.txt']);
      await p.reload();
      await p.locator('.row[data-path="f2.txt"]').click();
      await p.keyboard.press('Shift+Home');
      assert.equal(await focused(p), '');
      assert.equal(await p.locator('.row[data-path=""]').getAttribute('aria-selected'), 'false');
      assert.equal(await p.locator('#tree [aria-selected="true"]').count(), 2);
      await p.context().close();
    });

    it('panel opens fast', async (t) => {
      if (engine.name !== 'chromium') return t.skip('timed in Chromium only');
      const p = await freshPage(manyNames(1000));
      // Time from navigation start to the first row, taken in the page.
      await p.addInitScript(() => {
        new MutationObserver((_, observer) => {
          if (!document.querySelector('.row')) return;
          window.firstRow = performance.now();
          observer.disconnect();
        }).observe(document, { childList: true, subtree: true });
      });
      const times = [];
      for (let i = 0; i < 3; i++) {
        await p.goto(`${origin}/panel.html?harness`);
        await p.waitForFunction(() => window.firstRow);
        times.push(await p.evaluate(() => window.firstRow));
      }
      const median = times.sort((a, b) => a - b)[1];
      console.log(`# chromium: first row after ${times.map(Math.round).join(', ')} ms`);
      assert.ok(median < 300, `${median} ms`);
      await p.context().close();
    });

    it('right-click a row opens a menu with Rename, Duplicate, Delete and their shortcut hints', async () => {
      const p = await freshPage(['a.txt']);
      await p.reload();
      await p.locator('.row[data-path="a.txt"]').click({ button: 'right' });
      await p.locator('[role=menu]').waitFor();
      const items = p.locator('[role=menu] [role=menuitem]');
      const text = await items.allTextContents();
      for (const [label, keys] of [['Rename', /F2/], ['Duplicate', /D$/], ['Delete', /⌦|Delete/]]) {
        assert.match(text.find((t) => t.startsWith(label)) || '', keys, label);
      }
      // Arrow keys, Escape and focus coming back to the tree.
      assert.equal(await p.evaluate(() => document.activeElement.getAttribute('role')), 'menuitem');
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Escape');
      assert.equal(await p.locator('[role=menu]').count(), 0);
      assert.equal(await focused(p), 'a.txt');
      // Enter runs the item.
      await p.locator('.row[data-path="a.txt"]').click({ button: 'right' });
      await p.locator('[role=menuitem]', { hasText: 'Duplicate' }).click();
      await p.locator('.row[data-path="a copy.txt"]').waitFor();
      assert.match(await p.locator('#status').textContent(), /Duplicated as a copy\.txt/);
      assert.equal(await p.locator('.row[data-path="a copy.txt"]').getAttribute('aria-selected'), 'true');
      await p.context().close();
    });

    it('F2 starts rename; Mod+D duplicates; Delete asks first', async () => {
      const p = await freshPage(['a.txt']);
      await p.reload();
      await p.locator('.row[data-path="a.txt"]').click();
      await p.locator('#card-tabs [role=tab]').first().waitFor();
      await p.keyboard.press('F2');
      await p.locator('#card-body form input').waitFor();
      await p.locator('#card-body form button', { hasText: 'Cancel' }).click();
      assert.equal(await focused(p), 'a.txt');
      await p.keyboard.press('ControlOrMeta+d');
      await p.locator('.row[data-path="a copy.txt"]').waitFor();
      await p.keyboard.press('Delete');
      await p.locator('#card-body .actions', { hasText: 'Delete a copy.txt?' }).waitFor();
      await p.context().close();
    });

    it('Alt+R refreshes, Mod+S saves in the editor and downloads from the tree, Mod+A selects text in the editor', async () => {
      const p = await freshPage(['n.txt']);
      await p.reload();
      await p.locator('.row[data-path="n.txt"]').click();
      const editor = p.locator('.cm-content');
      await editor.fill('hello');
      await editor.press('ControlOrMeta+a');
      assert.equal(await p.evaluate(() => getSelection().toString()), 'hello');
      assert.equal(await p.locator('#tree [aria-selected="true"]').count(), 1);
      await editor.press('ControlOrMeta+s');
      await p.waitForFunction(() => document.getElementById('status').textContent.includes('Saved'));
      await p.locator('.row[data-path="n.txt"]').focus();
      const [download] = await Promise.all([p.waitForEvent('download'), p.keyboard.press('ControlOrMeta+s')]);
      assert.equal(download.suggestedFilename(), 'n.txt');
      await p.evaluate(async () => (await navigator.storage.getDirectory()).getFileHandle('later.txt', { create: true }));
      await p.keyboard.press('Alt+r');
      await p.locator('.row[data-path="later.txt"]').waitFor();
      await p.context().close();
    });

    it('? lists at least 20 shortcuts', async () => {
      const p = await freshPage([]);
      await p.reload();
      await p.locator('.row[data-path=""]').click();
      await p.keyboard.press('?');
      await p.locator('#help[open]').waitFor();
      assert.ok(await p.locator('#help [role=row]').count() >= 20);
      await p.keyboard.press('Escape');
      assert.equal(await p.locator('#help[open]').count(), 0);
      await p.context().close();
    });

    it("shortcut hints use the platform's modifier", async () => {
      for (const [platform, want, other] of [['MacIntel', '⌘⇧N', 'Ctrl'], ['Win32', 'Ctrl+Shift+N', '⌘']]) {
        const p = await (await browser.newContext()).newPage();
        await p.addInitScript((value) => Object.defineProperty(navigator, 'platform', { get: () => value }), platform);
        await p.goto(`${origin}/panel.html?harness`);
        await p.locator('.row[data-path=""]').click();
        await p.keyboard.press('?');
        await p.locator('#help[open]').waitFor();
        const text = await p.locator('#help').textContent();
        assert.ok(text.includes(want), `${platform}: ${want}`);
        assert.ok(!text.includes(other), `${platform}: no ${other}`);
        assert.ok((await p.getAttribute('#new-folder', 'data-tip')).includes(want));
        await p.context().close();
      }
    });

    it('a toolbar tooltip is visible on hover and focus, and Esc hides it', async () => {
      const p = await freshPage([]);
      await p.reload();
      // The pseudo-element must be generated, shown and sized.
      const tip = () => p.evaluate(() => {
        const after = getComputedStyle(document.getElementById('new-file'), '::after');
        const shown = after.display !== 'none' && after.visibility === 'visible' && Number(after.opacity) > 0
          && after.content !== 'none' && after.content !== 'normal' && parseFloat(after.width) > 0;
        return shown ? after.content : 'hidden';
      });
      // Firefox reports the unresolved attr(data-tip).
      const TIP = /Create a file in the selected folder|attr\(data-tip\)/;
      assert.equal(await tip(), 'hidden');
      await p.hover('#new-file');
      assert.match(await tip(), TIP);
      await p.keyboard.press('Escape');
      assert.equal(await tip(), 'hidden');
      await p.mouse.move(400, 300);
      await p.focus('#refresh');
      await p.keyboard.press('Tab');
      await p.keyboard.press('Tab');
      await p.keyboard.press('Shift+Tab');
      await p.keyboard.press('Shift+Tab');
      await p.keyboard.press('Tab');
      assert.equal(await p.evaluate(() => document.activeElement.id), 'new-file');
      assert.match(await tip(), TIP);
      await p.mouse.move(300, 300);
      assert.match(await tip(), TIP, 'stays while focused');
      await p.keyboard.press('Escape');
      assert.equal(await tip(), 'hidden');
      await p.context().close();
    });

    it('Alt/letters: another layout\'s key does not run a command', async () => {
      const p = await freshPage(['a.txt', 'b.txt']);
      await p.reload();
      await p.locator('.row[data-path="a.txt"]').click();
      await p.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'q', code: 'KeyA', ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform), bubbles: true, cancelable: true,
      })));
      assert.equal(await p.locator('#tree [aria-selected="true"]').count(), 1);
      await p.context().close();
    });

    it('tree keys typed into the rename box or the editor run nothing', async () => {
      const p = await freshPage(['a.txt', 'b.txt']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('a.txt').click();
      await p.locator('#card-tabs [role=tab]').first().waitFor();
      await p.keyboard.press('F2');
      const input = p.locator('#card-body form input');
      await input.fill('x');
      for (const key of ['?', 'Backspace', 'Delete', 'ControlOrMeta+a', 'ControlOrMeta+d', 'ControlOrMeta+Backspace']) await input.press(key);
      assert.equal(await p.locator('#help[open]').count(), 0);
      assert.equal(await p.locator('#card-body .actions', { hasText: 'Delete' }).count(), 0);
      assert.equal(await p.locator('#tree [aria-selected="true"]').count(), 1);
      await p.locator('#card-body form button', { hasText: 'Cancel' }).click();
      await p.locator('.row[data-path="a.txt"]').click();
      const editor = p.locator('.cm-content');
      await editor.fill('abc');
      for (const key of ['?', 'Backspace', 'Delete', 'ControlOrMeta+a', 'ControlOrMeta+d', 'ControlOrMeta+Backspace']) await editor.press(key);
      assert.equal(await p.locator('#help[open]').count(), 0);
      assert.equal(await p.locator('#card-body .actions', { hasText: 'Delete' }).count(), 0);
      assert.equal(await p.locator('#tree .row').count(), 3);
      assert.equal(await p.locator('#tree [aria-selected="true"]').count(), 1);
      await p.context().close();
    });

    it('Mod+Shift+Z in the editor discards edits', async () => {
      const p = await freshPage(['a.txt']);
      await p.reload();
      await p.locator('.row[data-path="a.txt"]').click();
      const editor = p.locator('.cm-content');
      await editor.fill('changed');
      assert.equal(await p.evaluate(() => document.querySelector('[data-cmd=discard]').disabled), false);
      await editor.press('ControlOrMeta+Shift+z');
      assert.equal(await editor.textContent(), '');
      assert.equal(await p.evaluate(() => document.querySelector('[data-cmd=discard]').disabled), true);
      await p.locator('.row[data-path="a.txt"]').click();
      assert.doesNotMatch(await p.locator('#status').textContent(), /Save or discard/);
      await p.context().close();
    });

    it('Mod+Shift+F formats a JSON file with the settings and marks it dirty', async () => {
      const p = await freshPage([]);
      await p.evaluate(async () => {
        localStorage.setItem('opfs-inspector:settings', JSON.stringify({ jsonIndent: 4, sortKeys: true }));
        const w = await (await (await navigator.storage.getDirectory()).getFileHandle('a.json', { create: true })).createWritable();
        await w.write('{"b":1,"a":2}');
        await w.close();
      });
      await p.reload();
      await p.locator('.row[data-path="a.json"]').click();
      const editor = p.locator('.cm-content');
      await editor.click();
      await editor.press('ControlOrMeta+Shift+f');
      await p.waitForFunction(() => document.getElementById('status').textContent.includes('Formatted'));
      assert.equal(await editor.innerText(), '{\n    "a": 2,\n    "b": 1\n}');
      assert.equal(await p.evaluate(() => document.querySelector('[data-cmd=save]').disabled), false);
      await p.context().close();
    });

    it('invalid JSON shows the line and column in #status and leaves the text', async () => {
      const p = await freshPage([]);
      await p.evaluate(async () => {
        const w = await (await (await navigator.storage.getDirectory()).getFileHandle('bad.json', { create: true })).createWritable();
        await w.write('{\n  "a": 1,\n}');
        await w.close();
      });
      await p.reload();
      await p.locator('.row[data-path="bad.json"]').click();
      const editor = p.locator('.cm-content');
      await editor.click();
      await editor.press('ControlOrMeta+Shift+f');
      await p.waitForFunction(() => /line 3, column 1/.test(document.getElementById('status').textContent));
      assert.equal(await editor.innerText(), '{\n  "a": 1,\n}');
      assert.equal(await p.evaluate(() => document.querySelector('[data-cmd=save]').disabled), true);
      await p.context().close();
    });

    it('Format JSON is offered only for a JSON file', async () => {
      const p = await freshPage(['a.txt']);
      await p.reload();
      await p.locator('.row[data-path="a.txt"]').click();
      await p.locator('.cm-editor').waitFor();
      assert.equal(await p.locator('[data-cmd="format-json"]').count(), 0);
      await p.context().close();
    });

    it('a held database still opens', async () => {
      const p = await freshPage([]);
      await putDb(p);
      // A worker in the page holds the file, as an app using SQLite would.
      await p.evaluate(() => new Promise((resolve, reject) => {
        const code = `onmessage = async () => {
          const file = await (await navigator.storage.getDirectory()).getFileHandle('app.db');
          self.handle = await file.createSyncAccessHandle();
          postMessage('held');
        };`;
        window.holder = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        window.holder.onmessage = () => resolve();
        window.holder.onerror = (e) => reject(new Error(e.message));
        window.holder.postMessage(0);
      }));
      await p.click('#refresh');
      await p.locator('.row[data-path="app.db"]').click();
      await p.locator('.sql-view .count', { hasText: 'Rows 1–100 of 250' }).waitFor();
      await p.context().close();
    });

    it('a database that changes during copy', async () => {
      const p = await freshPage([]);
      await putDb(p);
      await p.reload();
      // After the card's first read, every read says the file changed.
      await p.evaluate(() => {
        const t = window.opfsTransport;
        const call = t.call;
        let n = 0;
        t.call = async (op, args) => {
          const reply = await call(op, args);
          if (op === 'read' && args.path === 'app.db' && reply.ok && n++ > 0) reply.value.lastModified += n;
          return reply;
        };
      });
      await p.locator('.row[data-path="app.db"]').click();
      await p.locator('.snap .note.error', { hasText: 'kept changing' }).waitFor();
      await p.context().close();
    });

    // A worker writes files in place through sync access handles, as SQLite
    // does. Chromium keeps their size and lastModified the same. before and
    // after map file names to base64. With firstPage, page 1 of app.db and a
    // hot -journal are written before the copy starts. The rest is written
    // after the panel reads the first 512 KB part of app.db, or, with
    // firstPage, first looks at the -journal file.
    async function tornCopy({ before, after, firstPage = false, first }) {
      const p = await freshPage([]);
      await p.evaluate(async (files) => {
        const root = await navigator.storage.getDirectory();
        for (const [name, b64] of Object.entries(files)) {
          const w = await (await root.getFileHandle(name, { create: true })).createWritable();
          await w.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
          await w.close();
        }
      }, before);
      await p.reload();
      await p.evaluate(({ after, firstPage }) => new Promise((resolve, reject) => {
        const code = `onmessage = async ({ data }) => {
          const root = await navigator.storage.getDirectory();
          if (data.files) {
            self.files = data.files;
            self.handles = {};
            for (const name of Object.keys(data.files)) self.handles[name] = await (await root.getFileHandle(name)).createSyncAccessHandle();
            if (data.firstPage) {
              self.handles['app.db'].write(self.files['app.db'].subarray(0, 4096), { at: 0 });
              self.handles['app.db'].flush();
              self.journal = await (await root.getFileHandle('app.db-journal', { create: true })).createSyncAccessHandle();
              self.journal.write(new Uint8Array([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7, 0, 0, 0, 1]), { at: 0 });
              self.journal.flush();
            }
          } else {
            for (const [name, bytes] of Object.entries(self.files)) {
              self.handles[name].write(bytes, { at: 0 });
              self.handles[name].flush();
            }
            if (self.journal) {
              self.journal.close();
              await root.removeEntry('app.db-journal');
            }
          }
          postMessage('done');
        };`;
        const writer = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        writer.onerror = (e) => reject(new Error(e.message));
        window.writeRest = () => new Promise((done) => {
          writer.onmessage = () => done();
          writer.postMessage({});
        });
        writer.onmessage = () => resolve();
        const files = Object.fromEntries(Object.entries(after).map(([name, b64]) => [name, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]));
        writer.postMessage({ files, firstPage });
      }), { after, firstPage });
      await p.evaluate((firstPage) => {
        const t = window.opfsTransport;
        const call = t.call;
        let pending = true;
        t.call = async (op, args) => {
          const reply = await call(op, args);
          const firstPart = op === 'read' && args.path === 'app.db' && args.length === 512 * 1024;
          if (pending && (firstPart || (firstPage && String(args && args.path).endsWith('-journal')))) {
            pending = false;
            await window.writeRest();
          }
          return reply;
        };
      }, firstPage);
      await p.locator('.row[data-path="app.db"]').click();
      await p.locator('.grid tbody tr, .sql-view .note.error, .snap .note.error').first().waitFor();
      assert.deepEqual(await p.locator('.note.error').allTextContents(), []);
      assert.match(await p.locator('.grid tbody tr:first-child td:nth-child(2)').textContent(), first);
      await p.context().close();
    }

    it('a database rewritten in place during the copy is copied again', () => tornCopy({
      before: { 'app.db': bigOld }, after: { 'app.db': bigNew }, first: /^new /,
    }));

    it('a database part-way through a commit is copied again', () => tornCopy({
      before: { 'app.db': bigOld }, after: { 'app.db': bigNew }, firstPage: true, first: /^new /,
    }));

    // A checkpoint copies "mid" into the database during the copy, then the
    // -wal file starts again, so it no longer holds the pages to repair.
    it('a -wal file that starts again during the copy is copied again', () => tornCopy({
      before: { 'app.db': walMid.db, 'app.db-wal': walMid.wal },
      after: { 'app.db': walRestarted.db, 'app.db-wal': walRestarted.wal },
      first: /^mid /,
    }));

    it('sqlite bundle and wasm load only on first open', async () => {
      const p = await freshPage(['a.txt']);
      await putDb(p);
      const requests = [];
      p.on('request', (req) => requests.push(req.url()));
      await p.reload();
      await p.locator('.row[data-path="a.txt"]').click();
      await p.locator('.cm-editor').waitFor();
      assert.deepEqual(requests.filter((u) => /sqlite|sql-wasm/.test(u)), []);
      await p.locator('.row[data-path="app.db"]').click();
      await p.locator('.grid tbody tr').first().waitFor();
      assert.ok(requests.some((u) => /\/build\/sqlite\.js$/.test(u)), 'worker bundle');
      assert.ok(requests.some((u) => /\/build\/sql-wasm\.wasm$/.test(u)), 'wasm');
      await p.context().close();
    });

    it('editor bundle loads only when a text file opens', async () => {
      const p = await freshPage(['d/', 'a.txt']);
      const requests = [];
      p.on('request', (req) => requests.push(req.url()));
      await p.reload();
      await p.locator('.row[data-path="d"]').click();
      await p.locator('#card-tabs [role=tab]').first().waitFor();
      assert.deepEqual(requests.filter((u) => /editor/.test(u)), []);
      await p.locator('.row[data-path="a.txt"]').click();
      await p.locator('.cm-editor').waitFor();
      assert.ok(requests.some((u) => /editor/.test(u)));
      await p.context().close();
    });

    it('the editor font size follows the setting', async () => {
      const p = await freshPage(['a.txt']);
      await p.reload();
      await p.locator('.row[data-path="a.txt"]').click();
      await p.locator('.cm-editor').waitFor();
      assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontSize), '12px');
      await p.click('#settings');
      await p.getByLabel('Editor font size').fill('20');
      await p.getByLabel('Editor font size').dispatchEvent('change');
      assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.cm-content')).fontSize), '20px');
      await p.context().close();
    });

    it('tab keys and collapse-all keep unsaved edits and move focus', async () => {
      const p = await freshPage(['d/', 'a.txt']);
      await p.evaluate(async () => (await (await navigator.storage.getDirectory()).getDirectoryHandle('d')).getFileHandle('in.txt', { create: true }));
      await p.reload();
      await p.locator('.row[data-path="d"]').click();
      await p.keyboard.press('ArrowRight');
      await p.locator('.row[data-path="d/in.txt"]').click();
      const editor = p.locator('.cm-content');
      await editor.fill('keep me');
      await editor.press('ControlOrMeta+Alt+ArrowRight');
      assert.equal(await p.evaluate(() => document.activeElement.getAttribute('role')), 'tab');
      assert.equal(await p.evaluate(() => document.activeElement.getAttribute('aria-selected')), 'true');
      await p.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
      await p.keyboard.press('ControlOrMeta+Shift+ArrowLeft');
      await p.locator('.row[data-path="d/in.txt"]').waitFor({ state: 'detached' });
      assert.equal(await editor.innerText(), 'keep me');
      assert.equal(await p.evaluate(() => document.querySelector('[data-cmd=save]').disabled), false);
      await p.context().close();
    });

    it('the menu closes on outside click, scroll and resize', async () => {
      const p = await freshPage(manyNames(200));
      await p.reload();
      const open = async () => {
        await p.locator('.row[data-path="f00001.txt"]').click({ button: 'right' });
        await p.locator('[role=menu]').waitFor();
      };
      await open();
      await p.locator('#card').click();
      await p.locator('[role=menu]').waitFor({ state: 'detached' });
      await open();
      await p.evaluate(() => { document.getElementById('tree').scrollTop += 50; });
      await p.locator('[role=menu]').waitFor({ state: 'detached' });
      await open();
      await p.setViewportSize({ width: 700, height: 500 });
      await p.locator('[role=menu]').waitFor({ state: 'detached' });
      await p.context().close();
    });

    it('a focused menu item has an outline in forced colors', async () => {
      const p = await freshPage(['a.txt']);
      await p.emulateMedia({ forcedColors: 'active' });
      await p.reload();
      await p.locator('.row[data-path="a.txt"]').click({ button: 'right' });
      await p.locator('[role=menu]').waitFor();
      assert.notEqual(await p.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
      await p.context().close();
    });

    const opfsFiles = (p) => p.evaluate(async () => {
      const out = [];
      const walk = async (dir, prefix) => {
        for await (const h of dir.values()) {
          out.push(prefix + h.name + (h.kind === 'directory' ? '/' : ''));
          if (h.kind === 'directory') await walk(h, `${prefix}${h.name}/`);
        }
      };
      await walk(await navigator.storage.getDirectory(), '');
      return out.sort();
    });

    it('duplicate makes "a copy.txt"', async () => {
      const p = await freshPage(['a.txt', 'b.txt']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('a.txt').click();
      await p.keyboard.press('ControlOrMeta+d');
      await r('a copy.txt').waitFor();
      // Several selected: each is duplicated.
      await r('a.txt').click();
      await r('b.txt').click({ modifiers: ['ControlOrMeta'] });
      await p.keyboard.press('ControlOrMeta+d');
      await r('b copy.txt').waitFor();
      await r('a copy 2.txt').waitFor();
      assert.match(await p.locator('#status').textContent(), /Duplicated 2 items/);
      await p.context().close();
    });

    it('drag a.txt onto folder y moves it', async () => {
      const p = await freshPage(['a.txt', 'y/']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('a.txt').dragTo(r('y'));
      await p.waitForFunction(() => /Moved a\.txt/.test(document.getElementById('status').textContent));
      assert.deepEqual(await opfsFiles(p), ['y/', 'y/a.txt']);
      await p.context().close();
    });

    it('dragging a folder onto its own child is refused and nothing moves', async () => {
      const p = await freshPage(['c/', 'q/'], 'p');
      await p.emulateMedia({ forcedColors: 'active' });
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('p').click();
      await p.keyboard.press('ArrowRight');
      await r('p/c').waitFor();
      await r('p').hover();
      await p.mouse.down();
      await r('').hover();
      await r('p/c').hover();
      await r('p/c').hover({ position: { x: 20, y: 5 } });
      // The refused row is marked, and the mark shows in forced colors.
      await p.waitForFunction(() => document.querySelector('.row[data-path="p/c"]').classList.contains('drop-refused'));
      assert.notEqual(await r('p/c').evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
      await p.mouse.up();
      await p.waitForFunction(() => document.getElementById('status').textContent === 'A folder cannot be moved into itself.');
      assert.deepEqual(await opfsFiles(p), ['p/', 'p/c/', 'p/q/']);
      await p.context().close();
    });

    it('a drop target is highlighted in forced colors', async () => {
      const p = await freshPage(['a.txt', 'y/']);
      await p.emulateMedia({ forcedColors: 'active' });
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('a.txt').hover();
      await p.mouse.down();
      await r('y').hover();
      await r('y').hover({ position: { x: 20, y: 5 } });
      await p.waitForFunction(() => document.querySelector('.row[data-path="y"]').classList.contains('drop-target'));
      assert.notEqual(await r('y').evaluate((el) => getComputedStyle(el).outlineStyle), 'none');
      await p.mouse.up();
      await p.context().close();
    });

    it('drop two files from the computer', async () => {
      const p = await freshPage(['clash.txt'], 'y');
      await p.reload();
      await p.locator('.row[data-path="y"]').waitFor();
      await p.evaluate(() => {
        const dt = new DataTransfer();
        for (const name of ['one.txt', 'two.txt', 'clash.txt']) dt.items.add(new File([name], name));
        const row = document.querySelector('.row[data-path="y"]');
        for (const type of ['dragenter', 'dragover', 'drop']) row.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await p.locator('.row[data-path="y/two.txt"]').waitFor();
      await p.locator('.row[data-path="y/one.txt"]').waitFor();
      assert.match(await p.locator('#status').textContent(), /Uploaded 2 files\. Skipped clash\.txt/);
      await p.context().close();
    });

    it('dropping a folder from the computer keeps its structure', async () => {
      const p = await freshPage([]);
      await p.reload();
      await p.locator('.row[data-path=""]').click();
      await p.evaluate(() => {
        // Stand-ins for the entries a real drop gives. readEntries hands out one batch, then none.
        const file = (name) => ({ name, isFile: true, file: (ok) => ok(new File([name], name)) });
        const dir = (name, children) => ({
          name, isDirectory: true,
          createReader: () => { let left = children; return { readEntries: (ok) => { ok(left); left = []; } }; },
        });
        const tree = dir('top', [file('a.txt'), dir('inner', [file('b.txt')]), dir('empty', [])]);
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
          value: { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => tree }] },
        });
        document.getElementById('tree').dispatchEvent(event);
      });
      await p.waitForFunction(() => /Uploaded 2 files/.test(document.getElementById('status').textContent));
      assert.deepEqual(await opfsFiles(p), ['top/', 'top/a.txt', 'top/empty/', 'top/inner/', 'top/inner/b.txt']);
      await p.context().close();
    });

    it('dragging a file onto its own folder says it is already there', async () => {
      const p = await freshPage(['a.txt'], 'y');
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('y').click();
      await p.keyboard.press('ArrowRight');
      await r('y/a.txt').hover();
      await p.mouse.down();
      await r('y').hover();
      await r('y').hover({ position: { x: 20, y: 5 } });
      await p.mouse.up();
      await p.waitForFunction(() => document.getElementById('status').textContent === 'It is already in that folder.');
      assert.deepEqual(await opfsFiles(p), ['y/', 'y/a.txt']);
      await p.context().close();
    });

    it('an upload that stops part way shows what was written', async () => {
      const p = await freshPage([]);
      await p.reload();
      await p.locator('.row[data-path=""]').click();
      await p.evaluate(() => {
        const file = (name) => ({ name, isFile: true, file: (ok) => ok(new File([name], name)) });
        const bad = { name: 'bad.txt', isFile: true, file: (ok, no) => no(new Error('Could not read bad.txt.')) };
        const children = [file('a.txt'), bad];
        const top = { name: 'top', isDirectory: true, createReader: () => { let left = children; return { readEntries: (ok) => { ok(left); left = []; } }; } };
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => top }] } });
        document.getElementById('tree').dispatchEvent(event);
      });
      await p.waitForFunction(() => /Uploaded 1 file, then stopped: Could not read bad\.txt\./.test(document.getElementById('status').textContent));
      assert.match(await p.getAttribute('#status', 'class'), /error/);
      await p.locator('.row[data-path="top"]').waitFor();
      assert.deepEqual(await opfsFiles(p), ['top/', 'top/a.txt']);
      await p.context().close();
    });

    it('without write support, drops and moves are refused with a message', async () => {
      const p = await (await browser.newContext()).newPage();
      // The harness answers "areas" with canWrite false.
      await p.addInitScript(() => {
        let real;
        Object.defineProperty(window, 'opfsTransport', {
          get: () => real && {
            call: async (op, args) => {
              const reply = await real.call(op, args);
              return op === 'areas' ? { ...reply, value: { ...reply.value, canWrite: false } } : reply;
            },
          },
          set: (value) => { real = value; },
        });
      });
      await p.goto(`${origin}/panel.html?harness`);
      await p.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        await root.getFileHandle('a.txt', { create: true });
        await root.getDirectoryHandle('y', { create: true });
      });
      await p.click('#refresh');
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('a.txt').click();
      assert.equal(await p.locator('#move').isDisabled(), true);
      await r('a.txt').hover();
      await p.mouse.down();
      await r('y').hover();
      await r('y').hover({ position: { x: 20, y: 5 } });
      await p.mouse.up();
      await p.waitForFunction(() => document.getElementById('status').textContent === 'This browser cannot change files from a page.');
      await p.evaluate(() => { document.getElementById('status').textContent = ''; });
      await p.evaluate(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['1'], 'one.txt'));
        const row = document.querySelector('.row[data-path="y"]');
        for (const type of ['dragenter', 'dragover', 'drop']) row.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      });
      await p.waitForFunction(() => document.getElementById('status').textContent === 'This browser cannot change files from a page.');
      assert.deepEqual(await opfsFiles(p), ['a.txt', 'y/']);
      await p.context().close();
    });

    it('Alt+M moves the selected files to a typed folder', async () => {
      const p = await freshPage(['a.txt', 'b.txt', 'c.txt', 'y/']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('a.txt').click();
      await r('b.txt').click({ modifiers: ['ControlOrMeta'] });
      await p.keyboard.press('Alt+m');
      await p.locator('#card-body form input').fill('/y/');
      await p.locator('#card-body form button[type=submit]').click();
      await p.waitForFunction(() => /Moved 2 items/.test(document.getElementById('status').textContent));
      assert.deepEqual(await opfsFiles(p), ['c.txt', 'y/', 'y/a.txt', 'y/b.txt']);
      await p.context().close();
    });

    it('Move to refuses a folder into its own child', async () => {
      const p = await freshPage(['c/'], 'p');
      await p.reload();
      await p.locator('.row[data-path="p"]').click();
      await p.keyboard.press('Alt+m');
      await p.locator('#card-body form input').fill('p/c');
      await p.locator('#card-body form button[type=submit]').click();
      await p.waitForFunction(() => document.getElementById('status').textContent === 'A folder cannot be moved into itself.');
      assert.deepEqual(await opfsFiles(p), ['p/', 'p/c/']);
      await p.context().close();
    });

    it('an answered prompt never drops unsaved edits, and only one prompt is open', async () => {
      const p = await freshPage(['a.txt', 'b.txt']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('a.txt').click();
      await p.click('#delete');
      await p.click('#delete');
      assert.equal(await p.locator('#card-body .prompt').count(), 1);
      await r('b.txt').click();
      await p.locator('#card-head', { hasText: 'b.txt' }).waitFor();
      await p.locator('.cm-content').fill('keep me');
      await p.locator('#card-body button.danger', { hasText: 'Delete' }).click();
      assert.match(await p.locator('#status').textContent(), /Save or discard/);
      assert.equal(await p.locator('.cm-content').innerText(), 'keep me');
      assert.deepEqual(await opfsFiles(p), ['a.txt', 'b.txt']);
      await p.context().close();
    });

    it('select 3 and Delete removes all after one confirm', async () => {
      const p = await freshPage(['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('f1.txt').click();
      await r('f3.txt').click({ modifiers: ['Shift'] });
      await p.keyboard.press('Delete');
      await p.locator('#card-body .actions', { hasText: 'Delete 3 items?' }).waitFor();
      await p.locator('#card-body button.danger', { hasText: 'Delete' }).click();
      await p.waitForFunction(() => /Deleted 3 items/.test(document.getElementById('status').textContent));
      assert.deepEqual(await opfsFiles(p), ['f4.txt']);
      await p.context().close();
    });

    it('a bulk delete reports the items it could not delete', async () => {
      const p = await freshPage(['f1.txt', 'f2.txt']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('f1.txt').click();
      await r('f2.txt').click({ modifiers: ['Shift'] });
      await p.keyboard.press('Delete');
      await p.locator('#card-body .actions', { hasText: 'Delete 2 items?' }).waitFor();
      await p.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry('f2.txt'));
      await p.locator('#card-body button.danger', { hasText: 'Delete' }).click();
      await p.waitForFunction(() => /Deleted 1 of 2\. f2\.txt:/.test(document.getElementById('status').textContent));
      await p.context().close();
    });

    it('Delete acts on the highlighted row, not the one last clicked', async () => {
      const p = await freshPage(['a.txt', 'b.txt']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('a.txt').click();
      await r('b.txt').click({ modifiers: ['ControlOrMeta'] });
      await r('b.txt').click({ modifiers: ['ControlOrMeta'] });
      assert.equal(await p.locator('#tree [aria-selected="true"]').count(), 1);
      await p.keyboard.press('Delete');
      await p.locator('#card-body .actions', { hasText: 'Delete a.txt?' }).waitFor();
      await p.context().close();
    });

    it('Rename is off with several selected', async () => {
      const p = await freshPage(['a.txt', 'b.txt']);
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('a.txt').click();
      await r('b.txt').click({ modifiers: ['ControlOrMeta'] });
      assert.equal(await p.locator('#rename').isDisabled(), true);
      await p.context().close();
    });

    it('download of a selection is a zip containing the paths', async () => {
      const p = await freshPage(['a.txt', 'd/', 'b.txt']);
      const requests = [];
      p.on('request', (req) => requests.push(req.url()));
      await p.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('d');
        const w = await (await dir.getFileHandle('in.txt', { create: true })).createWritable();
        await w.write('inside');
        await w.close();
      });
      await p.reload();
      const r = (path) => p.locator(`.row[data-path="${path}"]`);
      await r('d').click();
      await r('a.txt').click({ modifiers: ['ControlOrMeta'] });
      assert.deepEqual(requests.filter((u) => /zip/.test(u)), [], 'zip code loads only for a zip');
      const [download] = await Promise.all([p.waitForEvent('download'), p.click('#download')]);
      assert.equal(download.suggestedFilename(), `${new URL(origin).hostname}.zip`);
      const { unzipSync } = await import('fflate');
      const { readFile } = await import('node:fs/promises');
      const files = unzipSync(new Uint8Array(await readFile(await download.path())));
      assert.deepEqual(Object.keys(files).sort(), ['a.txt', 'd/', 'd/in.txt']);
      assert.equal(new TextDecoder().decode(files['d/in.txt']), 'inside');
      assert.ok(requests.some((u) => /zip/.test(u)));
      await p.context().close();
    });

    it('zip bundle is not loaded until a zip is made', async () => {
      const p = await freshPage(['x.txt'], 'd');
      const requests = [];
      p.on('request', (req) => requests.push(req.url()));
      await p.reload();
      await p.locator('.row[data-path="d"]').click();
      await p.keyboard.press('ArrowRight');
      await p.locator('.row[data-path="d/x.txt"]').click();
      // One file downloads as it is, with no zip.
      const [one] = await Promise.all([p.waitForEvent('download'), p.click('#download')]);
      assert.equal(one.suggestedFilename(), 'x.txt');
      assert.deepEqual(requests.filter((u) => /zip/.test(u)), []);
      await p.locator('.row[data-path="d"]').click();
      const [folder] = await Promise.all([p.waitForEvent('download'), p.click('#download')]);
      assert.equal(folder.suggestedFilename(), 'd.zip');
      assert.ok(requests.some((u) => /zip/.test(u)));
      await p.context().close();
    });

    it('a download over 5 MB shows its progress', async () => {
      const p = await freshPage([]);
      await p.evaluate(async () => {
        const w = await (await (await navigator.storage.getDirectory()).getFileHandle('big.bin', { create: true })).createWritable();
        await w.write(new Uint8Array(6 * 1024 * 1024));
        await w.close();
      });
      await p.click('#refresh');
      await p.locator('.row[data-path="big.bin"]').waitFor();
      await p.evaluate(() => {
        window.seen = [];
        new MutationObserver(() => window.seen.push(document.getElementById('status').textContent))
          .observe(document.getElementById('status'), { childList: true, characterData: true, subtree: true });
      });
      await p.locator('.row[data-path="big.bin"]').click();
      const [download] = await Promise.all([p.waitForEvent('download'), p.click('#download')]);
      assert.equal(download.suggestedFilename(), 'big.bin');
      const seen = await p.evaluate(() => window.seen);
      assert.ok(seen.includes('Reading big.bin: 512 KB of 6.0 MB'), seen.join(' | '));
      await p.context().close();
    });

    it('folder size own and recursive match the fixture', async (t) => {
      const p = await freshPage([]);
      await p.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const d = await root.getDirectoryHandle('d', { create: true });
        const s = await d.getDirectoryHandle('s', { create: true });
        for (const [dir, name, text] of [[d, 'a', 'abc'], [s, 'b', 'hello']]) {
          const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await w.write(text);
          await w.close();
        }
      });
      await p.click('#refresh');
      await p.locator('.row[data-path="d"]').click();
      const result = () => p.locator('#card-body .size-result').innerText();
      await p.getByRole('button', { name: 'Calculate size', exact: true }).click();
      await p.locator('#card-body .size-result').waitFor();
      assert.match(await result(), /3 B \(3 bytes\)\s+Files\s+1\s+Folders\s+1/);
      await p.getByRole('button', { name: 'Calculate with subfolders' }).click();
      await p.waitForFunction(() => /8 bytes/.test(document.querySelector('#card-body .size-result')?.textContent || ''));
      assert.match(await result(), /8 B \(8 bytes\)\s+Files\s+2\s+Folders\s+1/);
      // Cancel: a result that arrives later is not drawn.
      await p.evaluate(() => {
        const t = window.opfsTransport;
        const real = t.call;
        t.call = async (op, args) => {
          const reply = await real(op, args);
          if (op === 'dirSize') await new Promise((r) => setTimeout(r, 400));
          return reply;
        };
      });
      await p.getByRole('button', { name: 'Calculate size', exact: true }).click();
      await p.getByRole('button', { name: 'Cancel' }).click();
      await p.waitForTimeout(800);
      assert.equal(await p.locator('#card-body .size-result').count(), 0);
      assert.match(await p.locator('#status').textContent(), /Cancelled/);
      // Mod+I runs it.
      await p.locator('.row[data-path="d"]').focus();
      await p.keyboard.press(process.platform === 'darwin' ? 'Meta+i' : 'Control+i');
      await p.locator('#card-body .size-result').waitFor();
      await p.context().close();
    });

    it('settings persist across reload', async () => {
      const p = await freshPage([]);
      await p.click('#settings');
      await p.locator('#settings-dialog[open]').waitFor();
      assert.equal(await p.evaluate(() => document.activeElement.closest('#settings-dialog') !== null), true);
      await p.getByLabel('JSON indent').selectOption('4');
      await p.getByLabel('Sort keys').check();
      await p.getByLabel('Folder size').selectOption('recursive');
      await p.getByLabel('Editor font size').fill('16');
      await p.getByLabel('Editor font size').dispatchEvent('change');
      assert.match(await p.locator('#settings-status').textContent(), /Editor font size saved/);
      await p.keyboard.press('Escape');
      await p.locator('#settings-dialog[open]').waitFor({ state: 'detached' }).catch(() => {});
      assert.equal(await p.evaluate(() => document.activeElement.id), 'settings');
      await p.reload();
      await p.locator('.row[data-path=""]').waitFor();
      await p.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
      await p.locator('#settings-dialog[open]').waitFor();
      assert.equal(await p.getByLabel('JSON indent').inputValue(), '4');
      assert.equal(await p.getByLabel('Sort keys').isChecked(), true);
      assert.equal(await p.getByLabel('Folder size').inputValue(), 'recursive');
      assert.equal(await p.getByLabel('Editor font size').inputValue(), '16');
      await p.context().close();
    });

    it('storage details lists each bucket', async (t) => {
      if (engine.name !== 'chromium') return t.skip('only Chromium has Storage Buckets');
      const p = await freshPage([]);
      await p.evaluate(async () => { await navigator.storageBuckets.open('app-db'); });
      await p.click('#refresh');
      await p.waitForFunction(() => [...document.querySelectorAll('#area option')].some((o) => o.value === 'bucket:app-db'));
      await p.click('#storage-details');
      await p.locator('#storage-dialog[open]').waitFor();
      await p.locator('#storage-dialog tbody tr', { hasText: 'app-db' }).waitFor();
      assert.ok(await p.locator('#storage-dialog tbody tr').count() >= 2);
      assert.match(await p.locator('#storage-dialog tbody tr').first().textContent(), /of/);
      await p.context().close();
    });

    it('a setting that is not folder size leaves a running calculation alone', async () => {
      const p = await freshPage(['d/']);
      await p.evaluate(() => {
        const t = window.opfsTransport;
        const real = t.call;
        t.call = async (op, args) => {
          const reply = await real(op, args);
          if (op === 'dirSize') await new Promise((r) => setTimeout(r, 600));
          return reply;
        };
      });
      await p.click('#refresh');
      await p.locator('.row[data-path="d"]').click();
      await p.getByRole('button', { name: 'Calculate size', exact: true }).click();
      await p.click('#settings');
      await p.getByLabel('Sort keys').check();
      await p.keyboard.press('Escape');
      await p.locator('#card-body .size-result').waitFor();
      // Leaving the folder drops the calculation and its message.
      await p.getByRole('button', { name: 'Calculate size', exact: true }).click();
      await p.locator('.row[data-path=""]').click();
      assert.doesNotMatch(await p.locator('#status').textContent(), /Calculating/);
      await p.context().close();
    });

    it('a late storage answer does not draw over a newer one', async () => {
      const p = await freshPage([]);
      await p.evaluate(() => {
        const t = window.opfsTransport;
        const real = t.call;
        let first = true;
        t.call = async (op, args) => {
          if (op !== 'estimate' || !first) return real(op, args);
          first = false;
          await new Promise((r) => setTimeout(r, 800));
          return { ok: true, value: { usage: 111, quota: 1e9 } };
        };
      });
      await p.click('#storage-details');
      await p.keyboard.press('Escape');
      await p.click('#storage-details');
      await p.locator('#storage-status', { hasText: 'loaded' }).waitFor();
      await p.waitForTimeout(1000);
      assert.doesNotMatch(await p.locator('#storage-dialog tbody').textContent(), /111 B/);
      await p.context().close();
    });

    // A 3x2 PNG written into the site's storage.
    const putPng = (name) => page.evaluate(async (name) => {
      const canvas = new OffscreenCanvas(3, 2);
      canvas.getContext('2d').fillRect(0, 0, 3, 2);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const root = await navigator.storage.getDirectory();
      const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
      await writable.write(blob);
      await writable.close();
    }, name);

    it('png shows its pixel size', async () => {
      await putPng('three.png');
      await page.reload();
      await row('three.png').click();
      await page.locator('.image-port img').waitFor();
      await page.waitForFunction(() => document.querySelector('.image-port img').naturalWidth === 3);
      assert.match(await page.locator('.image-view .note').textContent(), /3 × 2 px/);
    });

    it('rotate turns it 90 degrees', async () => {
      await page.getByRole('button', { name: 'Rotate' }).click();
      assert.match(await page.locator('.image-port img').evaluate((img) => img.style.transform), /rotate\(90deg\)/);
      await page.locator('.image-port').focus();
      await page.keyboard.press('r');
      assert.match(await page.locator('.image-port img').evaluate((img) => img.style.transform), /rotate\(180deg\)/);
      await page.keyboard.press('+');
      assert.match(await page.locator('.image-view .note').textContent(), /\d+%/);
    });

    it('svg with a script does not run it', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const writable = await (await root.getFileHandle('evil.svg', { create: true })).createWritable();
        await writable.write('<svg xmlns="http://www.w3.org/2000/svg" onload="window.top.__pwned=1"><script>window.top.__pwned=1</script></svg>');
        await writable.close();
      });
      await page.reload();
      await row('evil.svg').click();
      await page.locator('.image-port img').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.__pwned), undefined);
    });

    const putText = (name, text) => page.evaluate(async ([name, text]) => {
      const root = await navigator.storage.getDirectory();
      const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    }, [name, text]);

    it('headings and lists render', async () => {
      await putText('notes.md', '# Title\n\n## Sub\n\n- one\n- two\n\n[site](https://example.com)');
      await page.reload();
      await row('notes.md').click();
      await page.locator('#card-body .markdown h1').waitFor();
      assert.equal(await page.locator('#card-body .markdown h2').textContent(), 'Sub');
      assert.equal(await page.locator('#card-body .markdown li').count(), 2);
      assert.equal(await page.locator('#card-tabs [aria-selected=true]').textContent(), 'Preview');
      const link = page.locator('#card-body .markdown a');
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    });

    it('preview shows unsaved editor text', async () => {
      await page.getByRole('tab', { name: 'Editor' }).click();
      await page.locator('.cm-content').waitFor();
      await page.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('# Draft');
      await page.getByRole('tab', { name: 'Preview' }).click();
      await page.waitForFunction(() => document.querySelector('#card-body .markdown h1')?.textContent === 'Draft');
      await page.getByRole('tab', { name: 'Editor' }).click();
      await page.locator('[data-cmd=discard]').click();
    });

    it('hostile markdown is inert', async () => {
      await putText('evil.md', [
        '<script>window.top.__pwned=1</script>',
        '<img src=x onerror="window.top.__pwned=1">',
        '[x](javascript:window.top.__pwned=1)',
        '<iframe src="https://example.com"></iframe>',
        '<a href="JaVaScRiPt:alert(1)" onclick="window.top.__pwned=1">y</a>',
        '<p style="color:red" onmouseover="window.top.__pwned=1">z</p>',
      ].join('\n\n'));
      await page.reload();
      await row('evil.md').click();
      await page.locator('#card-body .markdown').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.__pwned), undefined);
      const bad = await page.evaluate(() => {
        const body = document.getElementById('card-body');
        const attrs = [...body.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => /^on/.test(n) || n === 'style');
        return {
          tags: body.querySelectorAll('script, iframe').length,
          attrs,
          hrefs: [...body.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /^javascript:/i.test(h)),
        };
      });
      assert.deepEqual(bad, { tags: 0, attrs: [], hrefs: [] });
    });

    it('markdown images make no request', async () => {
      await putText('pic.md', 'Look: ![a cat](https://example.com/cat.png) and <img src="https://example.com/b.png" alt="dog">');
      const requests = [];
      page.on('request', (r) => { if (r.url().startsWith('https://example.com/')) requests.push(r.url()); });
      await page.reload();
      await row('pic.md').click();
      await page.locator('#card-body .markdown').waitFor();
      await page.waitForTimeout(500);
      assert.deepEqual(requests, []);
      assert.equal(await page.locator('#card-body .markdown img').count(), 0);
      assert.match(await page.locator('#card-body .markdown').textContent(), /a cat/);
    });

    it('markdown makes no request through any attribute', async () => {
      const url = (n) => `${origin}/fetched/${n}`;
      await putText('urls.md', [
        `<table background="${url('table')}"><tr><th background="${url('th')}">a</th><td background="${url('td')}">b</td></tr></table>`,
        `<input type="image" src="${url('input')}" alt="i">`,
        `<video poster="${url('poster')}"></video><audio src="${url('audio')}"></audio>`,
        `<picture><source srcset="${url('source')}"><img srcset="${url('srcset')}" alt="s"></picture>`,
        `<div style="background:url(${url('style')})">d</div><style>@import url(${url('import')});</style>`,
        `<svg><image href="${url('svg')}" xlink:href="${url('xlink')}"></image></svg>`,
        `<object data="${url('object')}"></object><embed src="${url('embed')}"><iframe src="${url('iframe')}"></iframe>`,
        `<link rel="stylesheet" href="${url('link')}"><link rel="prefetch" href="${url('prefetch')}">`,
        `<form action="${url('form')}"><button formaction="${url('formaction')}">f</button></form>`,
        `<a ping="${url('ping')}" href="https://example.com">p</a>`,
        `<body background="${url('body')}"><meta http-equiv="refresh" content="0;url=${url('meta')}">`,
      ].join('\n\n'));
      const requests = [];
      page.on('request', (r) => { if (r.url().includes('/fetched/')) requests.push(r.url()); });
      await page.reload();
      await row('urls.md').click();
      await page.locator('#card-body .markdown table').waitFor();
      await page.waitForTimeout(500);
      assert.deepEqual(requests, []);
      const kept = await page.evaluate(() => [...document.querySelectorAll('#card-body .markdown *')]
        .flatMap((e) => [...e.attributes].map((a) => a.name))
        .filter((n) => ['background', 'src', 'srcset', 'poster', 'action', 'formaction', 'ping', 'style', 'xlink:href', 'data'].includes(n)));
      assert.deepEqual(kept, []);
    });

    it('markdown cannot take over panel commands or ids', async () => {
      await putText('hijack.md', '<a data-cmd="save" href="https://example.com">save</a>\n\n<div id="tab-0" class="primary" data-x="1">p</div>');
      await page.reload();
      await row('hijack.md').click();
      await page.locator('#card-body .markdown div').waitFor();
      const attrs = await page.evaluate(() => [...document.querySelectorAll('#card-body .markdown *')]
        .flatMap((e) => [...e.attributes].map((a) => a.name))
        .filter((n) => n === 'id' || n === 'class' || n.startsWith('data-')));
      assert.deepEqual(attrs, []);
      assert.equal(await page.locator('[id="tab-0"]').count(), 1);
      // Even a command button inside the preview is not the panel's own.
      await page.evaluate(() => {
        const fake = document.createElement('button');
        fake.dataset.cmd = 'save';
        fake.onclick = () => { window.__hijacked = true; };
        document.querySelector('#card-body .markdown').prepend(fake);
      });
      await page.getByRole('tab', { name: 'Editor' }).click();
      await page.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.type('# Mine');
      await page.keyboard.press('ControlOrMeta+s');
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('Saved'));
      assert.equal(await page.evaluate(() => window.__hijacked), undefined);
    });

    it('axe finds no serious violations', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle('readme.md', { create: true });
        const writable = await file.createWritable();
        await writable.write('# Hello');
        await writable.close();
        await root.getDirectoryHandle('empty', { create: true });
      });
      await putPng('three.png');
      const modes = [{ colorScheme: 'light' }, { colorScheme: 'dark' }, { colorScheme: 'light', forcedColors: 'active' }];
      for (const media of modes) {
        await page.emulateMedia({ forcedColors: 'none', ...media });
        await page.reload();
        await row('empty').click();
        await row('empty').press('ArrowRight');
        await page.locator('#tree .empty').waitFor();
        for (const path of ['readme.md', 'app.db', 'empty', 'three.png']) {
          await row(path).click();
          await page.locator('#card-tabs [role=tab]').first().waitFor();
          if (path === 'readme.md') await page.locator('#card-body .markdown h1').waitFor();
          if (path === 'three.png') await page.waitForFunction(() => document.querySelector('.image-port img')?.naturalWidth === 3);
          if (path === 'app.db') await page.locator('.grid tbody tr').first().waitFor();
          await page.waitForFunction(() => /of|not available/.test(document.getElementById('usage').textContent));
          const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
          assert.deepEqual(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`), [], `${JSON.stringify(media)} ${path}`);
        }
        const scan = async (name) => {
          const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
          assert.deepEqual(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`), [], `${JSON.stringify(media)} ${name}`);
        };
        await row('app.db').click();
        await page.getByRole('tab', { name: 'Query' }).click();
        await page.locator('.query-editor .cm-content').press('ControlOrMeta+Enter');
        await page.locator('.sql-result .grid').waitFor();
        await scan('sqlite query');
        await row('readme.md').click({ button: 'right' });
        await page.locator('[role=menu]').waitFor();
        await scan('context menu');
        await page.keyboard.press('Escape');
        await row('readme.md').press('?');
        await page.locator('#help[open]').waitFor();
        await scan('help');
        await page.keyboard.press('Escape');
        await page.click('#settings');
        await page.locator('#settings-dialog[open]').waitFor();
        await scan('settings');
        await page.keyboard.press('Escape');
        await page.click('#storage-details');
        await page.locator('#storage-dialog[open]').waitFor();
        await page.locator('#storage-dialog tbody tr').first().waitFor();
        await scan('storage details');
        await page.keyboard.press('Escape');
      }
    });
  });
}
