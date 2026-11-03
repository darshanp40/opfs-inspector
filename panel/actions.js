// Toolbar actions: create, rename, duplicate, move, delete, download, upload.
import { call } from './transport.js';
import { els, state, currentArea, setStatus, fail, selectOnly, focusTree } from './state.js';
import { join, parentOf, baseName, formatSize, toBase64 } from './format.js';
import { loadFolder, reloadExpanded, renderTree, updateButtons, showUsage, selectedItems } from './tree.js';
import { showDetail, readAll } from './detail.js';

function targetFolder() {
  const sel = state.selected;
  if (!sel) return '';
  return sel.kind === 'directory' ? sel.path : parentOf(sel.path);
}

// Cancels the open question, if any. Only one is open at a time.
let closePrompt = null;

// Asks for a name at the top of the card. Resolves to null on cancel.
function askName(label, initial = '') {
  if (closePrompt) closePrompt();
  return new Promise((resolve) => {
    const form = document.createElement('form');
    form.className = 'actions prompt';
    const text = document.createElement('label');
    text.textContent = label;
    const input = document.createElement('input');
    input.value = initial;
    input.required = true;
    text.append(' ', input);
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.textContent = 'OK';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    form.append(text, ok, cancel);
    const done = (value) => {
      closePrompt = null;
      form.remove();
      focusTree();
      resolve(value);
    };
    closePrompt = () => done(null);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      done(input.value.trim() || null);
    });
    cancel.addEventListener('click', () => done(null));
    els.cardBody.prepend(form);
    input.focus();
    input.select();
  });
}

function askConfirm(message, action) {
  if (closePrompt) closePrompt();
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'actions prompt';
    const text = document.createElement('span');
    text.textContent = message;
    const yes = document.createElement('button');
    yes.textContent = action;
    yes.className = 'danger';
    const no = document.createElement('button');
    no.textContent = 'Cancel';
    box.append(text, yes, no);
    const done = (value) => {
      closePrompt = null;
      box.remove();
      focusTree();
      resolve(value);
    };
    closePrompt = () => done(false);
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    els.cardBody.prepend(box);
    yes.focus();
  });
}

async function afterChange(message, selectPath, kind) {
  await reloadExpanded();
  // Unsaved edits keep their item on the card.
  if (selectPath !== undefined && !state.dirty) selectOnly(selectPath === null ? null : { path: selectPath, kind });
  renderTree();
  updateButtons();
  showUsage();
  await showDetail();
  setStatus(message, 'ok');
}

export async function create(kind) {
  if (state.dirty) return setStatus('Save or discard your changes first.', 'error');
  const folder = targetFolder();
  const name = await askName(kind === 'file' ? 'New file name' : 'New folder name');
  if (!name) return;
  // The card can change while the question is open.
  if (state.dirty) return setStatus('Save or discard your changes first.', 'error');
  const path = join(folder, name);
  try {
    await call(kind === 'file' ? 'createFile' : 'createFolder', { area: currentArea(), path });
    state.expanded.add(folder);
    await afterChange(`Created ${name}.`, path, kind === 'file' ? 'file' : 'directory');
  } catch (error) {
    fail(error);
  }
}

// What an action works on: the highlighted rows, or else the card's item (such as the root).
export const targets = () => (state.selection.size ? selectedItems() : state.selected ? [state.selected] : []);

const saveFirst = () => setStatus('Save or discard your changes first.', 'error');
const items = (n) => `${n} item${n === 1 ? '' : 's'}`;
const files = (n) => `${n} file${n === 1 ? '' : 's'}`;

// Keeps open folders open after a folder moves from one path to another.
function moveExpanded(from, to) {
  for (const p of [...state.expanded]) {
    if (p === from || p.startsWith(`${from}/`)) {
      state.expanded.delete(p);
      state.expanded.add(to + p.slice(from.length));
    }
  }
}

// Runs op on each item. Resolves to the error messages of the ones that failed.
async function each(list, op) {
  const failed = [];
  for (const item of list) {
    try {
      await op(item);
    } catch (error) {
      failed.push(`${baseName(item.path)}: ${error.message}`);
    }
  }
  return failed;
}

// "Deleted 3 items." or "Deleted 2 of 3. b.txt: why." Failures show as an error.
async function report(verb, list, failed, selectPath) {
  const done = list.length - failed.length;
  const message = !failed.length ? `${verb} ${items(list.length)}.`
    : list.length === 1 ? failed[0] : `${verb} ${done} of ${list.length}. ${failed.join(' ')}`;
  await afterChange(message, selectPath);
  if (failed.length) els.status.className = 'status error';
}

export async function rename() {
  const list = targets();
  if (list.length !== 1 || !list[0].path) return;
  const sel = list[0];
  if (state.dirty) return saveFirst();
  const newName = await askName('New name', baseName(sel.path));
  if (!newName || newName === baseName(sel.path)) return;
  if (state.dirty) return saveFirst();
  try {
    await call('rename', { area: currentArea(), path: sel.path, newName });
    const newPath = join(parentOf(sel.path), newName);
    moveExpanded(sel.path, newPath);
    await afterChange(`Renamed to ${newName}.`, newPath, sel.kind);
  } catch (error) {
    fail(error);
  }
}

export async function duplicate() {
  const list = targets().filter((t) => t.path);
  if (!list.length) return;
  if (state.dirty) return saveFirst();
  let last = null;
  const failed = await each(list, async (item) => {
    ({ path: last } = await call('copy', { area: currentArea(), path: item.path, toDir: parentOf(item.path) }));
  });
  if (list.length === 1 && !failed.length) return afterChange(`Duplicated as ${baseName(last)}.`, last, list[0].kind);
  await report('Duplicated', list, failed);
}

const NO_WRITE = 'This browser cannot change files from a page.';

// Why the items cannot move into folder, or null when they can.
export function moveRefusal(list, folder) {
  if (!state.canWrite) return NO_WRITE;
  if (list.some((d) => d.path === folder || folder.startsWith(`${d.path}/`))) return 'A folder cannot be moved into itself.';
  if (list.some((d) => parentOf(d.path) === folder)) return list.length === 1 ? 'It is already in that folder.' : 'One of the items is already in that folder.';
  return null;
}

// Asks for a folder path, then moves the selected items there.
export async function moveAsk() {
  const list = targets().filter((t) => t.path);
  if (!list.length) return;
  if (state.dirty) return saveFirst();
  const answer = await askName('Move to folder', `/${parentOf(list[0].path)}`);
  if (answer == null) return;
  await moveTo(list, answer.split('/').filter(Boolean).join('/'));
}

// Moves the items into folder.
export async function moveTo(list, folder) {
  if (state.dirty) return saveFirst();
  const why = moveRefusal(list, folder);
  if (why) return setStatus(why, 'error');
  let last = null;
  const failed = await each(list, async (item) => {
    ({ path: last } = await call('move', { area: currentArea(), path: item.path, toDir: folder }));
    moveExpanded(item.path, last);
  });
  state.expanded.add(folder);
  if (list.length === 1 && !failed.length) return afterChange(`Moved ${baseName(last)} to /${folder}.`, last, list[0].kind);
  await report('Moved', list, failed, null);
}

export async function remove() {
  const list = targets().filter((t) => t.path);
  if (!list.length) return;
  if (state.dirty) return saveFirst();
  const one = list[0];
  const what = list.length > 1 ? items(list.length)
    : one.kind === 'directory' ? `the folder ${baseName(one.path)} and everything in it` : baseName(one.path);
  if (!(await askConfirm(`Delete ${what}? This cannot be undone.`, 'Delete'))) return;
  if (state.dirty) return saveFirst();
  const failed = await each(list, async (item) => {
    await call('remove', { area: currentArea(), path: item.path });
    state.expanded.delete(item.path);
  });
  if (list.length === 1 && !failed.length) return afterChange(`Deleted ${baseName(one.path)}.`, null);
  await report('Deleted', list, failed, null);
}

const BIG = 5 * 1024 * 1024;

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Every folder and file under the items, with sizes. Folder paths end in "/".
async function walk(list) {
  const out = [];
  const visit = async (path, kind, size) => {
    if (kind === 'file') return out.push({ path, size });
    if (path) out.push({ path: `${path}/` });
    for (const e of await call('list', { area: currentArea(), path })) {
      if (e.error) throw new Error(`${join(path, e.name)}: ${e.error}`);
      await visit(join(path, e.name), e.kind, e.size);
    }
  };
  for (const item of list) {
    const size = item.kind === 'file' ? (await call('stat', { area: currentArea(), path: item.path })).size : 0;
    await visit(item.path, item.kind, size);
  }
  return out;
}

// One file downloads as it is. Anything else is a zip named after its folder, or the site.
export async function download() {
  const list = targets();
  if (!list.length) return;
  // Shows progress for big downloads only.
  let total = 0;
  let read = 0;
  const progress = (label) => (n) => {
    read += n;
    if (total > BIG) setStatus(`${label}: ${formatSize(read)} of ${formatSize(total)}`);
  };
  try {
    if (list.length === 1 && list[0].kind === 'file') {
      const { path } = list[0];
      total = (await call('stat', { area: currentArea(), path })).size;
      save(new Blob([await readAll(path, total, progress(`Reading ${baseName(path)}`))]), baseName(path));
      return setStatus(`Downloaded ${baseName(path)}.`, 'ok');
    }
    const host = new URL(state.origin).hostname;
    const base = list.every((t) => parentOf(t.path) === parentOf(list[0].path)) ? parentOf(list[0].path) : '';
    const name = `${(list.length === 1 ? baseName(list[0].path) : baseName(base)) || host}.zip`;
    setStatus(`Making ${name}…`);
    const entries = await walk(list);
    total = entries.reduce((sum, e) => sum + (e.size || 0), 0);
    const tick = progress(`Making ${name}`);
    const cut = base ? base.length + 1 : 0;
    const { zipEntries } = await import('./zip.entry.js');
    const blob = await zipEntries((async function* () {
      for (const e of entries) yield { path: e.path.slice(cut), bytes: e.path.endsWith('/') ? new Uint8Array() : await readAll(e.path, e.size, tick) };
    })());
    save(blob, name);
    setStatus(`Downloaded ${name}.`, 'ok');
  } catch (error) {
    fail(error);
  }
}

async function writeFile(path, file) {
  let offset = 0;
  do {
    setStatus(`Uploading ${file.name}: ${formatSize(offset)} of ${formatSize(file.size)}`);
    const bytes = new Uint8Array(await file.slice(offset, offset + state.chunk).arrayBuffer());
    await call('writeChunk', { area: currentArea(), path, data: toBase64(bytes), offset });
    offset += bytes.length;
  } while (offset < file.size);
}

// A File, or a dropped FileSystemEntry. Calls wrote() after each file.
async function put(item, path, wrote) {
  if (item instanceof File || item.isFile) {
    await writeFile(path, item instanceof File ? item : await new Promise((ok, no) => item.file(ok, no)));
    return wrote();
  }
  await call('createFolder', { area: currentArea(), path });
  const reader = item.createReader();
  // readEntries hands out a batch at a time, then an empty one.
  for (;;) {
    const batch = await new Promise((ok, no) => reader.readEntries(ok, no));
    if (!batch.length) return;
    for (const child of batch) await put(child, join(path, child.name), wrote);
  }
}

// Files, or dropped entries, go into folder. Names that exist there are skipped.
export async function upload(list, folder = targetFolder()) {
  if (!state.canWrite) return setStatus(NO_WRITE, 'error');
  const skipped = [];
  let done = 0;
  const skips = () => (skipped.length ? ` Skipped ${skipped.join(', ')}: an item with that name exists.` : '');
  try {
    await loadFolder(folder);
    const existing = new Set(state.children.get(folder).map((e) => e.name));
    for (const item of list) {
      if (existing.has(item.name)) skipped.push(item.name);
      else await put(item, join(folder, item.name), () => done++);
    }
    state.expanded.add(folder);
    await afterChange(`Uploaded ${files(done)}.${skips()}`);
  } catch (error) {
    // Show what did get written.
    state.expanded.add(folder);
    await afterChange(`Uploaded ${files(done)}, then stopped: ${error.message}${skips()}`).catch(() => {});
    els.status.className = 'status error';
  }
}
