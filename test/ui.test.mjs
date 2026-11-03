// The panel, driven like a person would, against ops.js in the same page.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { startServer } from './server.mjs';
import { engines } from './browsers.mjs';

let server;
let origin;
before(async () => ({ server, origin } = await startServer()));
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
      const editor = page.locator('textarea.editor');
      await editor.fill('buy milk');
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
      await page.locator('textarea.editor').fill('changed');
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
      await page.locator('textarea.editor').fill('<svg/>');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('Saved dot.svg'));
      const text = await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('dot.svg')).getFile()).text());
      assert.equal(text, '<svg/>');
    });

    it('rows have type icons', async () => {
      const rows = await page.locator('.row').count();
      assert.ok(rows > 1);
      assert.equal(await page.locator('.row svg').count(), rows);
    });

    it('shows a SQLite file as a database with a byte preview', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle('app.db', { create: true });
        const writable = await file.createWritable();
        const bytes = new Uint8Array(8192);
        bytes.set(new TextEncoder().encode('SQLite format 3\u0000'));
        await writable.write(bytes);
        await writable.close();
      });
      await page.click('#refresh');
      await row('app.db').click();
      await page.locator('.badge', { hasText: 'SQLite database' }).waitFor();
      assert.match(await page.locator('pre.hex').textContent(), /SQLite format 3/);
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

    it('axe finds no serious violations', async () => {
      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle('readme.md', { create: true });
        const writable = await file.createWritable();
        await writable.write('# Hello');
        await writable.close();
        await root.getDirectoryHandle('empty', { create: true });
      });
      const modes = [{ colorScheme: 'light' }, { colorScheme: 'dark' }, { colorScheme: 'light', forcedColors: 'active' }];
      for (const media of modes) {
        await page.emulateMedia({ forcedColors: 'none', ...media });
        await page.reload();
        await row('empty').click();
        await row('empty').press('ArrowRight');
        await page.locator('#tree .empty').waitFor();
        for (const path of ['readme.md', 'app.db', 'empty']) {
          await row(path).click();
          await page.locator('#card-tabs [role=tab]').first().waitFor();
          await page.waitForFunction(() => /of|not available/.test(document.getElementById('usage').textContent));
          const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
          assert.deepEqual(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`), [], `${JSON.stringify(media)} ${path}`);
        }
      }
    });
  });
}
