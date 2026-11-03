// The detail pane: file info, text editor, hex preview.
import { call } from './transport.js';
import { els, state, currentArea, setStatus, fail } from './state.js';
import { baseName, formatSize, fromBase64 } from './format.js';
import { renderTree, reloadExpanded } from './tree.js';

const TEXT_LIMIT = 2 * 1024 * 1024;
const PREVIEW_BYTES = 4096;
const SQLITE_HEADER = 'SQLite format 3\u0000';

function meta(pairs) {
  const dl = document.createElement('dl');
  dl.className = 'meta';
  for (const [key, value] of pairs) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    if (value instanceof Node) dd.append(value);
    else dd.textContent = value;
    dl.append(dt, dd);
  }
  return dl;
}

export async function readAll(path, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const part = await call('read', { area: currentArea(), path, offset, length: state.chunk });
    const chunk = fromBase64(part.data);
    if (chunk.length === 0) break;
    bytes.set(chunk.subarray(0, size - offset), offset);
    offset += chunk.length;
  }
  return bytes;
}

function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function hexDump(bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, i + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${i.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

export async function showDetail() {
  // Never draw over unsaved edits, and let only the newest call draw.
  if (state.dirty) return;
  const run = ++state.detailRun;
  const stale = () => run !== state.detailRun || state.dirty;
  const sel = state.selected;
  if (!sel) {
    els.detail.replaceChildren(note('Select a file or folder.'));
    return;
  }
  if (sel.kind === 'directory') {
    const list = state.children.get(sel.path);
    els.detail.replaceChildren(meta([
      ['Folder', `/${sel.path}`],
      ['Storage', state.areas.find((a) => a.id === state.areaId).label],
      ['Contains', list ? `${list.length} item${list.length === 1 ? '' : 's'}` : 'Expand the folder to list it'],
    ]));
    return;
  }
  let head;
  try {
    head = await call('read', { area: currentArea(), path: sel.path, offset: 0, length: PREVIEW_BYTES });
  } catch (error) {
    if (stale()) return;
    els.detail.replaceChildren(meta([['File', `/${sel.path}`]]), note(error.message, true));
    return;
  }
  if (stale()) return;
  const headBytes = fromBase64(head.data);
  const isSqlite = new TextDecoder('latin1').decode(headBytes.subarray(0, 16)) === SQLITE_HEADER;
  const kind = document.createElement('span');
  if (isSqlite) {
    kind.className = 'badge';
    kind.textContent = 'SQLite database';
  }
  const info = meta([
    ['File', `/${sel.path}`],
    ['Size', `${formatSize(head.size)} (${head.size.toLocaleString()} bytes)`],
    ['Modified', head.lastModified ? new Date(head.lastModified).toLocaleString() : 'unknown'],
    ['Type', isSqlite ? kind : ''],
  ]);
  if (!isSqlite && head.size <= TEXT_LIMIT) {
    const bytes = head.size <= headBytes.length ? headBytes : await readAll(sel.path, head.size);
    const text = decodeText(bytes);
    if (stale()) return;
    if (text !== null) {
      els.detail.replaceChildren(info, editor(sel.path, text));
      return;
    }
  }
  const pre = document.createElement('pre');
  pre.className = 'hex';
  pre.textContent = hexDump(headBytes);
  const shown = headBytes.length < head.size ? `First ${formatSize(headBytes.length)} shown. Download the file to see all of it.` : '';
  els.detail.replaceChildren(info, ...(shown ? [note(shown)] : []), pre);
}

function note(text, isError = false) {
  const p = document.createElement('p');
  p.className = 'note';
  if (isError) p.style.color = 'var(--error)';
  p.textContent = text;
  return p;
}

function editor(path, text) {
  const wrap = document.createDocumentFragment();
  const area = document.createElement('textarea');
  area.className = 'editor';
  area.spellcheck = false;
  area.value = text;
  area.readOnly = !state.canWrite;
  area.setAttribute('aria-label', `Contents of ${baseName(path)}`);
  const save = document.createElement('button');
  save.textContent = 'Save';
  save.disabled = true;
  const discard = document.createElement('button');
  discard.textContent = 'Discard changes';
  discard.disabled = true;
  const hint = document.createElement('span');
  hint.className = 'note';
  hint.textContent = state.canWrite ? '' : 'This browser cannot change files from a page.';
  area.addEventListener('input', () => {
    state.dirty = area.value !== text;
    save.disabled = discard.disabled = !state.dirty;
  });
  save.addEventListener('click', async () => {
    try {
      await call('writeText', { area: currentArea(), path, text: area.value });
      text = area.value;
      state.dirty = false;
      save.disabled = discard.disabled = true;
      await reloadExpanded();
      renderTree();
      setStatus(`Saved ${baseName(path)}.`, 'ok');
    } catch (error) {
      fail(error);
    }
  });
  discard.addEventListener('click', () => {
    area.value = text;
    state.dirty = false;
    save.disabled = discard.disabled = true;
    setStatus('');
  });
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(save, discard, hint);
  wrap.append(actions, area);
  return wrap;
}
