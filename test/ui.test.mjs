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
      const editor = p.locator('textarea.editor');
      await editor.fill('hello');
      await editor.press('ControlOrMeta+a');
      assert.equal(await p.evaluate(() => document.activeElement.selectionEnd - document.activeElement.selectionStart), 5);
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
      const editor = p.locator('textarea.editor');
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
      const editor = p.locator('textarea.editor');
      await editor.fill('changed');
      assert.equal(await p.evaluate(() => document.querySelector('[data-cmd=discard]').disabled), false);
      await editor.press('ControlOrMeta+Shift+z');
      assert.equal(await editor.inputValue(), '');
      assert.equal(await p.evaluate(() => document.querySelector('[data-cmd=discard]').disabled), true);
      await p.locator('.row[data-path="a.txt"]').click();
      assert.doesNotMatch(await p.locator('#status').textContent(), /Save or discard/);
      await p.context().close();
    });

    it('tab keys and collapse-all keep unsaved edits and move focus', async () => {
      const p = await freshPage(['d/', 'a.txt']);
      await p.evaluate(async () => (await (await navigator.storage.getDirectory()).getDirectoryHandle('d')).getFileHandle('in.txt', { create: true }));
      await p.reload();
      await p.locator('.row[data-path="d"]').click();
      await p.keyboard.press('ArrowRight');
      await p.locator('.row[data-path="d/in.txt"]').click();
      const editor = p.locator('textarea.editor');
      await editor.fill('keep me');
      await editor.press('ControlOrMeta+Alt+ArrowRight');
      assert.equal(await p.evaluate(() => document.activeElement.getAttribute('role')), 'tab');
      assert.equal(await p.evaluate(() => document.activeElement.getAttribute('aria-selected')), 'true');
      await p.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
      await p.keyboard.press('ControlOrMeta+Shift+ArrowLeft');
      await p.locator('.row[data-path="d/in.txt"]').waitFor({ state: 'detached' });
      assert.equal(await editor.inputValue(), 'keep me');
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
      await p.locator('textarea.editor').fill('keep me');
      await p.locator('#card-body button.danger', { hasText: 'Delete' }).click();
      assert.match(await p.locator('#status').textContent(), /Save or discard/);
      assert.equal(await p.locator('textarea.editor').inputValue(), 'keep me');
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
        const scan = async (name) => {
          const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
          assert.deepEqual(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`), [], `${JSON.stringify(media)} ${name}`);
        };
        await row('readme.md').click({ button: 'right' });
        await page.locator('[role=menu]').waitFor();
        await scan('context menu');
        await page.keyboard.press('Escape');
        await row('readme.md').press('?');
        await page.locator('#help[open]').waitFor();
        await scan('help');
        await page.keyboard.press('Escape');
      }
    });
  });
}
