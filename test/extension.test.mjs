// Loads the unpacked extension into Chromium and Edge and works on a real
// page's files through the background script and the injected agent.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './server.mjs';

const extensionDir = fileURLToPath(new URL('..', import.meta.url));
const wanted = process.env.ENGINES ? process.env.ENGINES.split(',') : ['chromium', 'msedge'];

let server;
let origin;
before(async () => ({ server, origin } = await startServer()));
after(() => {
  server.closeAllConnections();
  server.close();
});

for (const channel of ['chromium', 'msedge'].filter((c) => wanted.includes(c))) {
  describe(`extension in ${channel}`, { timeout: 120_000 }, () => {
    let context;
    let profile;
    let site;
    let panel;

    before(async () => {
      profile = mkdtempSync(join(tmpdir(), 'opfs-inspector-'));
      context = await chromium.launchPersistentContext(profile, {
        channel,
        headless: true,
        args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
      });
      let worker = context.serviceWorkers()[0];
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
      const extensionId = new URL(worker.url()).host;

      site = await context.newPage();
      await site.goto(`${origin}/test/site.html`);
      await site.evaluate(() => window.ready);
      const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url })).at(0)?.id, `${origin}/test/site.html`);
      assert.ok(tabId, 'the site tab is found');

      // The panel can also run in a tab, pointed at the page by its tab id.
      panel = await context.newPage();
      await panel.goto(`chrome-extension://${extensionId}/panel.html?tabId=${tabId}`);
    });
    after(async () => {
      await context?.close();
      rmSync(profile, { recursive: true, force: true });
    });

    it('lists the page\'s files and its bucket', async () => {
      await panel.locator('.row[data-path="notes.txt"]').waitFor();
      assert.match(await panel.locator('#origin').textContent(), new RegExp(origin.replace(/[.:/]/g, '\\$&')));
      const options = await panel.locator('#area option').allTextContents();
      assert.deepEqual(options, ['Default storage', 'Bucket: app-db']);
    });

    it('edits a file of the page', async () => {
      await panel.locator('.row[data-path="notes.txt"]').click();
      const editor = panel.locator('textarea.editor');
      assert.equal(await editor.inputValue(), 'from the site');
      await editor.fill('edited in the panel');
      await panel.getByRole('button', { name: 'Save' }).click();
      await panel.waitForFunction(() => document.getElementById('status').textContent.includes('Saved'));
      const text = await site.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        return (await (await root.getFileHandle('notes.txt')).getFile()).text();
      });
      assert.equal(text, 'edited in the panel');
    });

    it('opens the bucket', async () => {
      await panel.selectOption('#area', 'bucket:app-db');
      await panel.locator('.row[data-path="main.db"]').waitFor();
    });

    it('works again after the page reloads', async () => {
      await site.reload();
      await site.evaluate(() => window.ready);
      await panel.selectOption('#area', 'default');
      await panel.click('#refresh');
      await panel.locator('.row[data-path="notes.txt"]').waitFor();
      assert.equal(await panel.locator('#status').textContent(), '');
    });

    it('adds nothing to the page itself', async () => {
      assert.equal(await site.evaluate(() => typeof globalThis.__opfsInspector), 'undefined');
    });
  });
}
