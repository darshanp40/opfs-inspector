// Makes the README screenshots in docs/. Run: node scripts/screenshots.mjs
import { chromium } from 'playwright';
import { startServer } from '../test/server.mjs';

const { server, origin } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
await page.goto(`${origin}/`);

// Sample files: default storage plus one bucket.
await page.evaluate(async () => {
  const put = async (dir, path, data) => {
    const parts = path.split('/');
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true });
    const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(data);
    await w.close();
  };
  const sqlite = (size) => {
    const bytes = new Uint8Array(size);
    bytes.set(new TextEncoder().encode('SQLite format 3\0'));
    for (let i = 16; i < size; i++) bytes[i] = (i * 31) % 251;
    return bytes;
  };
  const root = await navigator.storage.getDirectory();
  await put(root, 'settings/config.json', JSON.stringify({ theme: 'dark', syncEveryMinutes: 5, features: { offline: true, search: true } }, null, 2));
  await put(root, 'settings/notes.md', '# Notes\n\n- Check the sync log\n- Clear old drafts\n');
  await put(root, 'search/index.db', sqlite(98304));
  await put(root, 'cache/thumb-01.bin', new Uint8Array(20480));
  await put(root, 'cache/thumb-02.bin', new Uint8Array(18432));
  await put(root, 'readme.txt', 'Files for the demo site.\n');
  const bucket = await navigator.storageBuckets.open('drafts');
  await put(await bucket.getDirectory(), 'drafts.db', sqlite(262144));
  await put(await bucket.getDirectory(), 'drafts.db-wal', new Uint8Array(32768));
});

await page.goto(`${origin}/panel.html?harness`);
const row = (path) => page.locator(`.row[data-path="${path}"]`);
await row('settings').waitFor();
for (const dir of ['settings', 'search']) {
  await row(dir).dblclick();
  await row(`${dir}/${dir === 'settings' ? 'config.json' : 'index.db'}`).waitFor();
}

await row('settings/config.json').click();
await page.locator('textarea.editor').waitFor();
await page.screenshot({ path: 'docs/editor.png' });

await page.selectOption('#area', 'bucket:drafts');
await row('drafts.db').click();
await page.locator('pre.hex').waitFor();
await page.screenshot({ path: 'docs/bucket.png' });

await page.emulateMedia({ colorScheme: 'dark' });
await page.reload();
await row('settings').dblclick();
await row('settings/notes.md').click();
await page.locator('textarea.editor').waitFor();
await page.screenshot({ path: 'docs/dark.png' });

await browser.close();
server.closeAllConnections();
server.close();
