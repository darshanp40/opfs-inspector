// The file tree: loading folders, drawing rows, selecting.
import { call } from './transport.js';
import { els, state, currentArea, setStatus, fail } from './state.js';
import { join, parentOf, baseName, formatSize } from './format.js';
import { showDetail } from './detail.js';
import { iconFor } from './icons.js';

async function loadAreas() {
  const info = await call('areas');
  state.areas = info.areas;
  state.canWrite = info.canWrite;
  if (!state.areas.some((a) => a.id === state.areaId)) state.areaId = 'default';
  els.area.replaceChildren(...state.areas.map((a) => new Option(a.label, a.id, false, a.id === state.areaId)));
  els.origin.textContent = info.origin + (info.hasBuckets ? '' : ' (no storage buckets in this browser)');
}

export async function loadFolder(path) {
  state.children.set(path, await call('list', { area: currentArea(), path }));
}

export async function reloadExpanded() {
  for (const path of [...state.expanded].sort((a, b) => a.length - b.length)) {
    try {
      await loadFolder(path);
    } catch (error) {
      state.expanded.delete(path);
      state.children.delete(path);
      if (path === '') throw error;
    }
  }
}

export async function refresh() {
  try {
    await loadAreas();
    showUsage();
    await reloadExpanded();
    if (state.selected && !findEntry(state.selected.path)) state.selected = null;
    renderTree();
    await showDetail();
    setStatus('');
  } catch (error) {
    state.children.clear();
    renderTree();
    fail(error);
  }
  updateButtons();
}

function findEntry(path) {
  if (path === '') return { name: '', kind: 'directory' };
  const list = state.children.get(parentOf(path));
  return list && list.find((e) => e.name === baseName(path));
}

// Footer text and meter. Only the newest call draws.
export async function showUsage() {
  const run = ++state.usageRun;
  let text = 'Storage use is not available';
  let value = 0;
  try {
    const { usage, quota } = await call('estimate', { area: currentArea() });
    if (usage != null && quota) {
      text = `${formatSize(usage)} of ${formatSize(quota)} used`;
      value = usage / quota;
    }
  } catch {
    // Keep the "not available" text.
  }
  if (run !== state.usageRun) return;
  els.usage.textContent = text;
  els.usageMeter.value = value;
  els.usageMeter.title = `${(value * 100).toFixed(value < 0.01 ? 2 : 0)}% used`;
}

const areaName = () => {
  const area = state.areas.find((a) => a.id === state.areaId);
  return area && area.area && area.area.kind === 'bucket' ? area.area.name : 'Default';
};

// The path bar: one button per part of the selected path.
function renderCrumbs() {
  const path = state.selected ? state.selected.path : '';
  const parts = path ? path.split('/') : [];
  const items = [];
  for (let i = 0; i <= parts.length; i++) {
    const partPath = parts.slice(0, i).join('/');
    const last = i === parts.length;
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '/';
      items.push(sep);
    }
    const button = document.createElement('button');
    button.className = 'crumb';
    button.textContent = i === 0 ? areaName() : parts[i - 1];
    if (last) button.setAttribute('aria-current', 'location');
    const kind = last && state.selected ? state.selected.kind : 'directory';
    button.addEventListener('click', () => select(partPath, kind));
    items.push(button);
  }
  els.crumbs.replaceChildren(...items);
}

export function renderTree() {
  const rows = [];
  const rootRow = row({ path: '', name: '/', kind: 'directory', depth: 0 });
  rows.push(rootRow);
  if (state.expanded.has('')) addChildren('', 1, rows);
  els.tree.replaceChildren(...rows);
  renderCrumbs();
}

function addChildren(path, depth, rows) {
  const list = state.children.get(path);
  if (!list) return;
  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.style.paddingLeft = `${8 + depth * 16 + 20}px`;
    empty.textContent = 'empty';
    rows.push(empty);
  }
  for (const entry of list) {
    const childPath = join(path, entry.name);
    rows.push(row({ ...entry, path: childPath, depth }));
    if (entry.kind === 'directory' && state.expanded.has(childPath)) addChildren(childPath, depth + 1, rows);
  }
}

function row(entry) {
  const div = document.createElement('div');
  div.className = 'row';
  div.tabIndex = 0;
  div.setAttribute('role', 'treeitem');
  div.dataset.path = entry.path;
  div.style.paddingLeft = `${8 + entry.depth * 16}px`;
  const selected = Boolean(state.selected && state.selected.path === entry.path);
  div.classList.toggle('selected', selected);
  div.setAttribute('aria-selected', String(selected));
  if (entry.error) {
    div.classList.add('error');
    div.title = entry.error;
  }
  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.setAttribute('aria-hidden', 'true');
  if (entry.kind === 'directory') {
    if (state.expanded.has(entry.path)) twisty.classList.add('open');
    div.setAttribute('aria-expanded', String(state.expanded.has(entry.path)));
    twisty.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle(entry.path);
    });
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entry.name;
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = entry.kind === 'file' ? formatSize(entry.size) : '';
  div.append(twisty, iconFor(entry), name, size);
  div.addEventListener('click', () => select(entry.path, entry.kind));
  div.addEventListener('dblclick', () => entry.kind === 'directory' && toggle(entry.path));
  div.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') select(entry.path, entry.kind);
    if (entry.kind === 'directory' && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      const open = state.expanded.has(entry.path);
      if ((event.key === 'ArrowRight') !== open) toggle(entry.path);
    }
  });
  return div;
}

export async function toggle(path) {
  try {
    if (state.expanded.has(path)) {
      state.expanded.delete(path);
      for (const p of [...state.expanded]) if (p.startsWith(`${path}/`)) state.expanded.delete(p);
    } else {
      await loadFolder(path);
      state.expanded.add(path);
    }
    renderTree();
  } catch (error) {
    fail(error);
  }
}

export async function select(path, kind) {
  if (state.dirty && (!state.selected || state.selected.path !== path)) {
    setStatus('Save or discard your changes first.', 'error');
    return;
  }
  state.selected = { path, kind };
  renderTree();
  updateButtons();
  setStatus('');
  await showDetail();
}

export function updateButtons() {
  const sel = state.selected;
  const writable = state.canWrite;
  els.newFile.disabled = false;
  els.newFolder.disabled = false;
  els.upload.disabled = !writable;
  els.rename.disabled = !sel || sel.path === '';
  els.download.disabled = !sel || sel.kind !== 'file';
  els.remove.disabled = !sel || sel.path === '';
}
