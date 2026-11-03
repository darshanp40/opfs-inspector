// The file tree: loading folders, drawing rows, keys and selecting.
import { call } from './transport.js';
import { els, state, currentArea, setStatus, fail, selectOnly, selectionChanged } from './state.js';
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
    const kept = [...state.selection].filter((p) => findEntry(p));
    if (kept.length !== state.selection.size) {
      state.selection = new Set(kept);
      selectionChanged();
    }
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
  // Redrawing destroys the buttons, so give focus back to the same part.
  const focused = els.crumbs.contains(document.activeElement) ? document.activeElement.dataset.path : null;
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
    button.dataset.path = partPath;
    button.textContent = i === 0 ? areaName() : parts[i - 1];
    if (last) button.setAttribute('aria-current', 'location');
    const kind = last && state.selected ? state.selected.kind : 'directory';
    button.addEventListener('click', () => select(partPath, kind));
    items.push(button);
  }
  els.crumbs.replaceChildren(...items);
  const again = focused != null && items.find((b) => b.dataset && b.dataset.path === focused);
  if (again) again.focus();
}

// The tree draws only the rows in view, plus a buffer, inside a spacer
// that is as tall as all rows. Every row has the same height (--row-h).
const BUFFER = 20;
const space = document.createElement('div');
space.className = 'tree-space';
space.setAttribute('role', 'none');
els.tree.append(space);
let rows = []; // every visible item, in order; { empty: true } is a folder's "empty" note
let drawn = '';
let rowH = 0;
const rowHeight = () => rowH || (rowH = parseFloat(getComputedStyle(els.tree).getPropertyValue('--row-h')));
const items = () => rows.filter((r) => !r.empty);

export function renderTree() {
  rows = [{ path: '', name: '/', kind: 'directory', depth: 0, pos: 1, setSize: 1 }];
  if (state.expanded.has('')) addChildren('', 1);
  space.style.height = `${rows.length * rowHeight()}px`;
  drawRows(true);
  renderCrumbs();
}

function addChildren(path, depth) {
  const list = state.children.get(path);
  if (!list) return;
  if (list.length === 0) rows.push({ empty: true, depth, pos: 1, setSize: 1 });
  list.forEach((entry, i) => {
    const childPath = join(path, entry.name);
    rows.push({ ...entry, path: childPath, depth, pos: i + 1, setSize: list.length });
    if (entry.kind === 'directory' && state.expanded.has(childPath)) addChildren(childPath, depth + 1);
  });
}

// Index of the row that takes Tab focus: the focused path, or its nearest shown folder.
function focusIndex() {
  let path = state.focus || '';
  for (;;) {
    const i = rows.findIndex((r) => !r.empty && r.path === path);
    if (i >= 0 || path === '') {
      state.focus = rows[Math.max(i, 0)].path;
      return Math.max(i, 0);
    }
    path = parentOf(path);
  }
}

function drawRows(force) {
  const h = rowHeight();
  const top = els.tree.scrollTop;
  const first = Math.max(0, Math.floor(top / h) - BUFFER);
  const last = Math.min(rows.length, Math.ceil((top + els.tree.clientHeight) / h) + BUFFER);
  const focus = focusIndex();
  const key = `${first}:${last}:${focus}`;
  if (!force && key === drawn) return;
  drawn = key;
  const hadFocus = els.tree.contains(document.activeElement);
  const list = [];
  for (let i = first; i < last; i++) list.push(draw(i, focus));
  // The focused row stays in the DOM even when scrolled away, so Tab still finds it.
  if (focus < first || focus >= last) list.push(draw(focus, focus));
  space.replaceChildren(...list);
  if (hadFocus) space.querySelector('[tabindex="0"]').focus({ preventScroll: true });
}

function draw(i, focus) {
  const item = rows[i];
  const div = item.empty ? emptyNote(item) : row(item);
  div.style.top = `${i * rowHeight()}px`;
  div.tabIndex = i === focus ? 0 : -1;
  div.setAttribute('aria-level', String(item.depth + 1));
  div.setAttribute('aria-posinset', String(item.pos));
  div.setAttribute('aria-setsize', String(item.setSize));
  return div;
}

function emptyNote(item) {
  const div = document.createElement('div');
  div.className = 'empty';
  // A tree may only hold tree items, so the note is a disabled one.
  div.setAttribute('role', 'treeitem');
  div.setAttribute('aria-disabled', 'true');
  div.setAttribute('aria-selected', 'false');
  div.style.paddingLeft = `${8 + item.depth * 16 + 20}px`;
  div.textContent = 'empty';
  return div;
}

function row(entry) {
  const div = document.createElement('div');
  div.className = 'row';
  div.setAttribute('role', 'treeitem');
  div.dataset.path = entry.path;
  div.style.paddingLeft = `${8 + entry.depth * 16}px`;
  const selected = state.selection.has(entry.path);
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
  }
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entry.name;
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = entry.kind === 'file' ? formatSize(entry.size) : '';
  div.append(twisty, iconFor(entry), name, size);
  return div;
}

const itemAt = (target) => {
  const div = target.closest('.row');
  return div && rows.find((r) => !r.empty && r.path === div.dataset.path);
};

els.tree.addEventListener('scroll', () => drawRows(false));

// A click or Tab moves the roving tabindex to that row.
els.tree.addEventListener('focusin', (event) => {
  const item = itemAt(event.target);
  if (!item || item.path === state.focus) return;
  const old = space.querySelector('[tabindex="0"]');
  if (old) old.tabIndex = -1;
  event.target.closest('.row').tabIndex = 0;
  state.focus = item.path;
});

els.tree.addEventListener('click', (event) => {
  const item = itemAt(event.target);
  if (!item) return;
  if (item.kind === 'directory' && event.target.closest('.twisty')) toggle(item.path);
  else if (event.shiftKey) selectRange(item);
  else if (event.ctrlKey || event.metaKey) toggleSelected(item);
  else select(item.path, item.kind);
});

els.tree.addEventListener('dblclick', (event) => {
  const item = itemAt(event.target);
  if (item && item.kind === 'directory' && !event.target.closest('.twisty')) toggle(item.path);
});

let typed = '';
let typedAt = 0;

// The ARIA tree keyboard model.
els.tree.addEventListener('keydown', (event) => {
  const list = items();
  const item = itemAt(event.target) || list.find((r) => r.path === state.focus);
  if (!item) return;
  const i = list.indexOf(item);
  const mod = event.ctrlKey || event.metaKey;
  const open = item.kind === 'directory' && state.expanded.has(item.path);
  let to = null;
  if (event.key === 'ArrowDown') to = list[i + 1];
  else if (event.key === 'ArrowUp') to = list[i - 1];
  else if (event.key === 'Home') to = list[0];
  else if (event.key === 'End') to = list[list.length - 1];
  else if (event.key === 'ArrowRight') {
    if (item.kind === 'directory' && !open) toggle(item.path);
    else if (open && list[i + 1] && list[i + 1].depth > item.depth) to = list[i + 1];
  } else if (event.key === 'ArrowLeft') {
    if (open) toggle(item.path);
    else if (item.path !== '') to = list.find((r) => r.path === parentOf(item.path));
  } else if (event.key === 'Enter') select(item.path, item.kind);
  else if (event.key === ' ') mod ? toggleSelected(item) : select(item.path, item.kind);
  else if (mod && event.key.toLowerCase() === 'a') selectAll();
  else if (event.key.length === 1 && !mod && !event.altKey) {
    // Typing jumps to the next name that starts with the typed letters.
    const now = Date.now();
    typed = now - typedAt < 500 ? typed + event.key : event.key;
    typedAt = now;
    const from = typed.length > 1 ? i : i + 1;
    const want = typed.toLowerCase();
    to = [...list.slice(from), ...list.slice(0, from)].find((r) => r.name.toLowerCase().startsWith(want));
    if (!to) return;
  } else return;
  event.preventDefault();
  if (!to) return;
  if (event.shiftKey && event.key !== ' ') selectRange(to);
  else moveFocus(to.path);
});

function moveFocus(path) {
  state.focus = path;
  const i = rows.findIndex((r) => !r.empty && r.path === path);
  const h = rowHeight();
  const tree = els.tree;
  if (i * h < tree.scrollTop) tree.scrollTop = i * h;
  else if ((i + 1) * h > tree.scrollTop + tree.clientHeight) tree.scrollTop = (i + 1) * h - tree.clientHeight;
  drawRows(true);
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

// Unsaved edits block every change of selection, except picking the same item again.
function blocked(path) {
  if (!state.dirty || (path != null && state.selected && state.selected.path === path)) return false;
  setStatus('Save or discard your changes first.', 'error');
  return true;
}

export async function select(path, kind) {
  if (blocked(path)) return;
  selectOnly({ path, kind });
  renderTree();
  updateButtons();
  setStatus('');
  await showDetail();
}

// Several items: the card shows the item last clicked (or keeps its item).
function setSelection(paths, item) {
  const moved = item && (!state.selected || state.selected.path !== item.path);
  state.selection = new Set(paths);
  if (item) {
    state.selected = { path: item.path, kind: item.kind };
    state.focus = item.path;
  }
  selectionChanged();
  renderTree();
  updateButtons();
  const n = state.selection.size;
  setStatus(n > 1 ? `${n} items selected.` : '');
  if (moved) showDetail();
}

function toggleSelected(item) {
  if (blocked(null)) return;
  const next = new Set(state.selection);
  if (!next.delete(item.path)) next.add(item.path);
  state.anchor = item.path;
  setSelection(next, item);
}

function selectRange(item) {
  if (blocked(null)) return;
  const list = items();
  const to = list.indexOf(item);
  let from = list.findIndex((r) => r.path === state.anchor);
  if (from < 0) {
    from = to;
    state.anchor = item.path;
  }
  setSelection(list.slice(Math.min(from, to), Math.max(from, to) + 1).map((r) => r.path), item);
}

// Every shown item except the root, which cannot be acted on.
function selectAll() {
  if (blocked(null)) return;
  setSelection(items().filter((r) => r.path !== '').map((r) => r.path), null);
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
