// Makes the store images in store/. Run: node scripts/store-images.mjs
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const icon = `data:image/png;base64,${(await readFile('icons/icon-128.png')).toString('base64')}`;
const browser = await chromium.launch();

async function shot(path, width, height, body) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<body style="margin:0;width:${width}px;height:${height}px;display:flex;align-items:center;justify-content:center;gap:20px;background:#1f2a44;color:#fff;font:600 30px system-ui,sans-serif">${body}</body>`);
  await page.screenshot({ path });
  await page.close();
}

await shot('store/promo-440x280.png', 440, 280,
  `<img src="${icon}" width="96"><div>OPFS Inspector<div style="font:400 15px system-ui;opacity:.8;margin-top:6px">Files and Storage Buckets<br>in DevTools</div></div>`);
await shot('store/logo-300x300.png', 300, 300, `<img src="${icon}" width="220">`);
await browser.close();
