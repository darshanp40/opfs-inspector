// Toolbar actions: create, rename, delete, download, upload.
import { call } from './transport.js';
import { els, state, currentArea, setStatus, fail, selectOnly, focusTree } from './state.js';
import { join, parentOf, baseName, formatSize, toBase64 } from './format.js';
import { loadFolder, reloadExpanded, renderTree, updateButtons, showUsage } from './tree.js';
import { showDetail, readAll } from './detail.js';

function targetFolder() {
  const sel = state.selected;
  if (!sel) return '';
  return sel.kind === 'directory' ? sel.path : parentOf(sel.path);
}

// Asks for a name at the top of the card. Resolves to null on cancel.
function askName(label, initial = '') {
  return new Promise((resolve) => {
    const form = document.createElement('form');
    form.className = 'actions';
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
      form.remove();
      focusTree();
      resolve(value);
    };
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
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'actions';
    const text = document.createElement('span');
    text.textContent = message;
    const yes = document.createElement('button');
    yes.textContent = action;
    yes.className = 'danger';
    const no = document.createElement('button');
    no.textContent = 'Cancel';
    box.append(text, yes, no);
    const done = (value) => {
      box.remove();
      focusTree();
      resolve(value);
    };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    els.cardBody.prepend(box);
    yes.focus();
  });
}

async function afterChange(message, selectPath, kind) {
  await reloadExpanded();
  if (selectPath !== undefined) {
    state.dirty = false;
    selectOnly(selectPath === null ? null : { path: selectPath, kind });
  }
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
  const path = join(folder, name);
  try {
    await call(kind === 'file' ? 'createFile' : 'createFolder', { area: currentArea(), path });
    state.expanded.add(folder);
    await afterChange(`Created ${name}.`, path, kind === 'file' ? 'file' : 'directory');
  } catch (error) {
    fail(error);
  }
}

export async function rename() {
  const sel = state.selected;
  if (!sel || !sel.path) return;
  if (state.dirty) return setStatus('Save or discard your changes first.', 'error');
  const newName = await askName('New name', baseName(sel.path));
  if (!newName || newName === baseName(sel.path)) return;
  try {
    await call('rename', { area: currentArea(), path: sel.path, newName });
    const newPath = join(parentOf(sel.path), newName);
    if (state.expanded.has(sel.path)) {
      state.expanded.delete(sel.path);
      state.expanded.add(newPath);
    }
    await afterChange(`Renamed to ${newName}.`, newPath, sel.kind);
  } catch (error) {
    fail(error);
  }
}

export async function duplicate() {
  const sel = state.selected;
  if (!sel || !sel.path) return;
  if (state.dirty) return setStatus('Save or discard your changes first.', 'error');
  const folder = parentOf(sel.path);
  try {
    const { path } = await call('copy', { area: currentArea(), path: sel.path, toDir: folder });
    state.expanded.add(folder);
    await afterChange(`Duplicated as ${baseName(path)}.`, path, sel.kind);
  } catch (error) {
    fail(error);
  }
}

export async function remove() {
  const sel = state.selected;
  if (!sel || !sel.path) return;
  const what = sel.kind === 'directory' ? `the folder ${baseName(sel.path)} and everything in it` : baseName(sel.path);
  if (!(await askConfirm(`Delete ${what}? This cannot be undone.`, 'Delete'))) return;
  try {
    await call('remove', { area: currentArea(), path: sel.path });
    state.expanded.delete(sel.path);
    await afterChange(`Deleted ${baseName(sel.path)}.`, null);
  } catch (error) {
    fail(error);
  }
}

export async function download() {
  const sel = state.selected;
  if (!sel || sel.kind !== 'file') return;
  try {
    setStatus(`Reading ${baseName(sel.path)}…`);
    const head = await call('read', { area: currentArea(), path: sel.path, offset: 0, length: 0 });
    const bytes = await readAll(sel.path, head.size);
    const url = URL.createObjectURL(new Blob([bytes]));
    const link = document.createElement('a');
    link.href = url;
    link.download = baseName(sel.path);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setStatus(`Downloaded ${baseName(sel.path)}.`, 'ok');
  } catch (error) {
    fail(error);
  }
}

export async function upload(files) {
  const folder = targetFolder();
  const existing = new Set((state.children.get(folder) || []).map((e) => e.name));
  const skipped = [];
  let done = 0;
  try {
    if (!state.children.has(folder)) await loadFolder(folder);
    for (const e of state.children.get(folder)) existing.add(e.name);
    for (const file of files) {
      if (existing.has(file.name)) {
        skipped.push(file.name);
        continue;
      }
      const path = join(folder, file.name);
      let offset = 0;
      do {
        setStatus(`Uploading ${file.name}: ${formatSize(offset)} of ${formatSize(file.size)}`);
        const bytes = new Uint8Array(await file.slice(offset, offset + state.chunk).arrayBuffer());
        await call('writeChunk', { area: currentArea(), path, data: toBase64(bytes), offset });
        offset += bytes.length;
      } while (offset < file.size);
      done++;
    }
    state.expanded.add(folder);
    const message = `Uploaded ${done} file${done === 1 ? '' : 's'}.`
      + (skipped.length ? ` Skipped ${skipped.join(', ')}: a file with that name exists.` : '');
    await afterChange(message);
  } catch (error) {
    fail(error);
  }
}
