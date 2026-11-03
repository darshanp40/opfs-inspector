// Bundles the panel into build/, minified and with no source maps. Page code in
// src/ is not bundled.
import { build } from 'esbuild';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

await rm('build', { recursive: true, force: true });
await mkdir('build');

// The SQLite worker is a bundle of its own, so it shares no chunk with the panel.
const WORKER = 'sqlite.entry.js';
const entries = (await readdir('panel')).filter((f) => f === 'main.js' || (f.endsWith('.entry.js') && f !== WORKER));
const result = await build({
  entryPoints: Object.fromEntries(entries.map((f) => [f === 'main.js' ? 'panel' : f.replace(/\.entry\.js$/, ''), `panel/${f}`])),
  outdir: 'build',
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  metafile: true,
  logLevel: 'warning',
});
const worker = await build({
  entryPoints: { sqlite: `panel/${WORKER}` },
  outdir: 'build',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  metafile: true,
  logLevel: 'warning',
});

const wasm = 'node_modules/sql.js/dist/sql-wasm.wasm';
if (existsSync(wasm)) await copyFile(wasm, 'build/sql-wasm.wasm');

// One licence entry for each bundled package under node_modules.
const packages = new Set();
for (const file of [...Object.keys(result.metafile.inputs), ...Object.keys(worker.metafile.inputs)]) {
  const m = file.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (m) packages.add(m[1]);
}
let notices = 'Third-party code bundled into build/.\n';
for (const name of [...packages].sort()) {
  const dir = `node_modules/${name}`;
  const pkg = JSON.parse(await readFile(`${dir}/package.json`, 'utf8'));
  const licence = (await readdir(dir)).find((f) => /^licen[cs]e/i.test(f));
  notices += `\n---- ${name} ${pkg.version} (${pkg.license || 'see below'}) ----\n`;
  if (licence) notices += `${await readFile(`${dir}/${licence}`, 'utf8')}\n`;
}
await writeFile('build/THIRD_PARTY.txt', notices);
