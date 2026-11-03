// Makes the README and store screenshots in docs/. Run: node scripts/screenshots.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { startServer } from '../test/server.mjs';

// Real SQLite files, made in Node, so the viewer shows real rows.
function database(sql, rows) {
  const dir = mkdtempSync(join(tmpdir(), 'shots-'));
  const db = new DatabaseSync(join(dir, 'x.db'));
  db.exec(sql);
  rows(db);
  db.close();
  const bytes = readFileSync(join(dir, 'x.db')).toString('base64');
  rmSync(dir, { recursive: true });
  return bytes;
}
const drafts = database('create table drafts (id integer primary key, title text, words integer, updated_at text); create index drafts_by_date on drafts (updated_at)', (db) => {
  const titles = ['Trip to Lisbon', 'Weekly plan', 'Garden notes', 'Reading list', 'Bike repair', 'Birthday ideas', 'Budget for May', 'Recipe: lentil soup', 'Talk outline', 'Moving checklist', 'Book club', 'Gift list', 'Interview prep', 'Photo backup', 'Running log'];
  const insert = db.prepare('insert into drafts (title, words, updated_at) values (?, ?, ?)');
  for (let i = 0; i < 42; i++) insert.run(titles[i % titles.length], 120 + ((i * 137) % 900), `2026-10-${String(1 + (i % 28)).padStart(2, '0')} ${String(8 + (i % 12)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`);
});
const search = database('create table terms (term text primary key, hits integer)', (db) => {
  const insert = db.prepare('insert into terms values (?, ?)');
  for (const [i, term] of ['sync', 'draft', 'offline', 'photo', 'note'].entries()) insert.run(term, 10 + i);
});

const { server, origin } = await startServer();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
await page.goto(`${origin}/`);

// Sample files: default storage plus some buckets.
await page.evaluate(async ({ drafts, search }) => {
  const put = async (dir, path, data) => {
    const parts = path.split('/');
    for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true });
    const w = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(data);
    await w.close();
  };
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  // A small picture for the image preview.
  const canvas = new OffscreenCanvas(640, 400);
  const g = canvas.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 400);
  sky.addColorStop(0, '#3a6fd8');
  sky.addColorStop(1, '#9cc4ff');
  g.fillStyle = sky;
  g.fillRect(0, 0, 640, 400);
  g.fillStyle = '#ffd25a';
  g.beginPath();
  g.arc(480, 110, 50, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2f7d4f';
  g.beginPath();
  g.moveTo(0, 400);
  g.lineTo(0, 290);
  g.quadraticCurveTo(200, 200, 360, 300);
  g.quadraticCurveTo(500, 230, 640, 280);
  g.lineTo(640, 400);
  g.fill();

  const root = await navigator.storage.getDirectory();
  await put(root, 'settings/config.json', JSON.stringify({ theme: 'dark', syncEveryMinutes: 5, features: { offline: true, search: true }, accounts: [{ id: 1, name: 'Ana' }, { id: 2, name: 'Ben' }] }, null, 2));
  await put(root, 'settings/notes.md', '# Notes\n\nThings to look at before the **next release**.\n\n- Check the sync log\n- Clear old drafts\n- Move photos to the `media-cache` bucket\n\n## Done\n\n1. Offline mode\n2. Search index\n');
  await put(root, 'media/hills.png', await canvas.convertToBlob({ type: 'image/png' }));
  await put(root, 'search/index.db', bytes(search));
  await put(root, 'cache/thumb-01.bin', new Uint8Array(20480));
  await put(root, 'cache/thumb-02.bin', new Uint8Array(18432));
  await put(root, 'readme.txt', 'Files for the demo site.\n');
  for (const name of ['media-cache', 'offline-db']) {
    await put(await (await navigator.storageBuckets.open(name)).getDirectory(), 'placeholder.txt', 'x');
  }
  await put(await (await navigator.storageBuckets.open('drafts')).getDirectory(), 'drafts.db', bytes(drafts));
}, { drafts, search });

await page.goto(`${origin}/panel.html?harness`);
const row = (path) => page.locator(`.row[data-path="${path}"]`);
await row('settings').waitFor();
for (const dir of ['settings', 'media', 'search']) {
  await row(dir).click();
  await page.keyboard.press('ArrowRight');
  await row(`${dir}/${{ settings: 'config.json', media: 'hills.png', search: 'index.db' }[dir]}`).waitFor();
}

await row('settings/config.json').click();
await page.locator('.cm-content', { hasText: 'syncEveryMinutes' }).waitFor();
await page.screenshot({ path: 'docs/editor.png' });

await row('media/hills.png').click();
await page.waitForFunction(() => document.querySelector('.image-port img')?.naturalWidth === 640);
await page.screenshot({ path: 'docs/image.png' });

await page.selectOption('#area', 'bucket:drafts');
await row('drafts.db').click();
await page.locator('.grid tbody tr').first().waitFor();
await page.screenshot({ path: 'docs/sqlite.png' });

// A native dropdown does not show in screenshots, so draw the open list.
await page.evaluate(() => {
  const select = document.getElementById('area');
  const list = select.cloneNode(true);
  const box = select.getBoundingClientRect();
  list.size = list.options.length;
  list.value = select.value;
  Object.assign(list.style, { position: 'fixed', left: `${Math.min(box.left, innerWidth - 220)}px`, top: `${box.bottom + 4}px`, minWidth: '200px', zIndex: 10, boxShadow: '0 4px 12px rgb(0 0 0 / .2)', padding: '2px' });
  document.body.append(list);
  list.focus();
});
await page.screenshot({ path: 'docs/picker.png' });
await page.evaluate(() => document.querySelector('body > select').remove());

await page.emulateMedia({ colorScheme: 'dark' });
await page.selectOption('#area', 'default');
await row('settings').waitFor();
await row('settings').click();
await page.keyboard.press('ArrowRight');
await row('settings/notes.md').click();
await page.locator('#card-body li', { hasText: 'Check the sync log' }).waitFor();
await page.screenshot({ path: 'docs/dark.png' });

await browser.close();
server.closeAllConnections();
server.close();
