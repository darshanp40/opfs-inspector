// The operations layer, in Chromium, Firefox and WebKit.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';
import { engines } from './browsers.mjs';

let server;
let origin;
before(async () => ({ server, origin } = await startServer()));
after(() => {
  server.closeAllConnections();
  server.close();
});

// Playwright's WebKit has no working OPFS in its private session, so a
// browser whose OPFS fails here is skipped with the reason.
async function opfsProblem(engine) {
  const { server: probeServer, origin: probeOrigin } = await startServer();
  const browser = await engine.type.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${probeOrigin}/`);
    return await page.evaluate(() => navigator.storage.getDirectory().then(() => null, (e) => `${e.name}: ${e.message}`));
  } finally {
    await browser.close();
    probeServer.closeAllConnections();
    probeServer.close();
  }
}

const problems = new Map();
for (const engine of engines) problems.set(engine.name, await opfsProblem(engine));

for (const engine of engines) {
  const problem = problems.get(engine.name);
  const skip = problem ? `OPFS does not work in this ${engine.name} build: ${problem}` : false;
  describe(engine.name, { timeout: 120_000, skip }, () => {
    let browser;
    let page;
    const run = (op, args) => page.evaluate(([o, a]) => globalThis.__opfsInspector.run(o, a), [op, args]);
    const ok = async (op, args) => {
      const reply = await run(op, args);
      assert.equal(reply.ok, true, `${op} failed: ${reply.error}`);
      return reply.value;
    };
    const area = { kind: 'default' };
    let canWrite;

    before(async () => {
      browser = await engine.type.launch();
      page = await browser.newPage();
      await page.goto(`${origin}/`);
      canWrite = (await ok('areas')).canWrite;
    });
    after(() => browser.close());

    it('lists the default area', async () => {
      const info = await ok('areas');
      assert.equal(info.areas[0].id, 'default');
      assert.equal(info.origin, origin);
      assert.equal(info.hasBuckets, engine.name === 'chromium');
    });

    it('creates folders and files, and lists one level with sizes', async () => {
      await ok('createFolder', { area, path: 'docs' });
      await ok('createFolder', { area, path: 'docs/deep' });
      await ok('createFile', { area, path: 'docs/a.txt' });
      await ok('createFile', { area, path: 'docs/deep/b.txt' });
      const list = await ok('list', { area, path: 'docs' });
      assert.deepEqual(list.map((e) => [e.name, e.kind]), [['deep', 'directory'], ['a.txt', 'file']]);
      assert.equal(list[1].size, 0);
      assert.equal(list[0].size, undefined, 'a folder has no size, and its contents are not read');
    });

    it('refuses an existing name and invalid names', async () => {
      const dup = await run('createFile', { area, path: 'docs/a.txt' });
      assert.match(dup.error, /already exists/);
      const bad = await run('createFolder', { area, path: 'docs/..' });
      assert.equal(bad.ok, false);
    });

    it('writes and reads text', { skip: false }, async (t) => {
      if (!canWrite) return t.skip('this browser cannot write from a page');
      await ok('writeText', { area, path: 'docs/a.txt', text: 'hello ünïcode' });
      const read = await ok('read', { area, path: 'docs/a.txt' });
      const bytes = Uint8Array.from(Buffer.from(read.data, 'base64'));
      assert.equal(new TextDecoder().decode(bytes), 'hello ünïcode');
      assert.equal(read.size, bytes.length);
    });

    it('writes a file in chunks and reads it back in chunks', async (t) => {
      if (!canWrite) return t.skip('this browser cannot write from a page');
      const data = Buffer.alloc(1_300_000);
      for (let i = 0; i < data.length; i++) data[i] = i % 251;
      const chunk = 512 * 1024;
      for (let offset = 0; offset < data.length; offset += chunk) {
        await ok('writeChunk', { area, path: 'docs/big.bin', data: data.subarray(offset, offset + chunk).toString('base64'), offset });
      }
      const parts = [];
      for (let offset = 0; offset < data.length; offset += chunk) {
        parts.push(Buffer.from((await ok('read', { area, path: 'docs/big.bin', offset, length: chunk })).data, 'base64'));
      }
      assert.ok(Buffer.concat(parts).equals(data));
    });

    it('renames a file and a folder', async () => {
      await ok('rename', { area, path: 'docs/a.txt', newName: 'renamed.txt' });
      await ok('rename', { area, path: 'docs/deep', newName: 'deeper' });
      const list = await ok('list', { area, path: 'docs' });
      assert.ok(list.some((e) => e.name === 'renamed.txt'));
      assert.ok(!list.some((e) => e.name === 'a.txt'));
      const inner = await ok('list', { area, path: 'docs/deeper' });
      assert.deepEqual(inner.map((e) => e.name), ['b.txt']);
      if (canWrite) {
        const read = await ok('read', { area, path: 'docs/renamed.txt' });
        assert.equal(Buffer.from(read.data, 'base64').toString(), 'hello ünïcode');
      }
    });

    it('refuses to rename onto an existing name', async () => {
      await ok('createFile', { area, path: 'docs/other.txt' });
      const reply = await run('rename', { area, path: 'docs/other.txt', newName: 'renamed.txt' });
      assert.match(reply.error, /already exists/);
    });

    it('deletes a file and a folder with its contents', async () => {
      await ok('remove', { area, path: 'docs/other.txt' });
      await ok('remove', { area, path: 'docs/deeper' });
      const names = (await ok('list', { area, path: 'docs' })).map((e) => e.name);
      assert.ok(!names.includes('other.txt'));
      assert.ok(!names.includes('deeper'));
    });

    it('explains a missing path', async () => {
      const reply = await run('list', { area, path: 'nope' });
      assert.equal(reply.ok, false);
      assert.match(reply.error, /no longer exists/);
    });

    it('explains a file that a worker holds open', async (t) => {
      if (!canWrite) return t.skip('this browser cannot write from a page');
      await page.evaluate(() => new Promise((resolve, reject) => {
        const code = `onmessage = async () => {
          const root = await navigator.storage.getDirectory();
          const file = await root.getFileHandle('held.db', { create: true });
          self.handle = await file.createSyncAccessHandle();
          postMessage('held');
        };`;
        const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
        worker.onmessage = () => resolve();
        worker.onerror = (e) => reject(new Error(e.message));
        worker.postMessage('go');
        globalThis.holder = worker;
      }));
      const reply = await run('writeText', { area, path: 'held.db', text: 'x' });
      assert.equal(reply.ok, false);
      assert.match(reply.error, /in use/);
      await page.evaluate(() => globalThis.holder.terminate());
    });

    it('lists and opens storage buckets, without creating missing ones', async (t) => {
      if (engine.name !== 'chromium') return t.skip('only Chromium has Storage Buckets');
      await page.evaluate(async () => {
        const bucket = await navigator.storageBuckets.open('app-db');
        const dir = await bucket.getDirectory();
        await dir.getFileHandle('in-bucket.db', { create: true });
      });
      const info = await ok('areas');
      const entry = info.areas.find((a) => a.id === 'bucket:app-db');
      assert.ok(entry);
      const list = await ok('list', { area: entry.area, path: '' });
      assert.deepEqual(list.map((e) => e.name), ['in-bucket.db']);
      const missing = await run('list', { area: { kind: 'bucket', name: 'not-there' }, path: '' });
      assert.equal(missing.ok, false);
      const keys = await page.evaluate(() => navigator.storageBuckets.keys());
      assert.ok(!keys.includes('not-there'), 'a missing bucket must not be created');
    });
  });
}
