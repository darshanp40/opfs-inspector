// The card: the open item's header, tabs and views.
import { call } from './transport.js';
import { els, state, currentArea, setStatus, fail } from './state.js';
import { baseName, formatSize, fromBase64 } from './format.js';
import { renderTree, reloadExpanded, showUsage } from './tree.js';
import { iconFor, typeOf } from './icons.js';

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

// onChunk(n) is told the size of each part read.
export async function readAll(path, size, onChunk) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const part = await call('read', { area: currentArea(), path, offset, length: state.chunk });
    const chunk = fromBase64(part.data);
    if (chunk.length === 0) break;
    bytes.set(chunk.subarray(0, size - offset), offset);
    offset += chunk.length;
    if (onChunk) onChunk(chunk.length);
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

// Lines of offset, hex and text, with the offset and text columns in spans.
function hexDump(bytes) {
  const nodes = [];
  const span = (className, text) => Object.assign(document.createElement('span'), { className, textContent: text });
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, i + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    nodes.push(span('off', i.toString(16).padStart(8, '0')), `  ${hex.padEnd(47)}  `, span('ascii', ascii), '\n');
  }
  return nodes;
}

// The tabs each type gets. Only tabs in TABS are shown, so later tasks add a
// renderer to TABS and the tab appears.
const TABS_BY_TYPE = {
  folder: ['Details'],
  text: ['Editor', 'Details'],
  json: ['Editor', 'Details'],
  code: ['Editor', 'Details'],
  markdown: ['Preview', 'Editor', 'Details'],
  image: ['Preview', 'Details'],
  svg: ['Preview', 'Editor', 'Details'],
  sqlite: ['Table', 'Query', 'Details'],
  binary: ['Bytes', 'Details'],
};
const TYPE_LABELS = {
  folder: 'Folder', text: 'Text', json: 'JSON', code: 'Code', markdown: 'Markdown',
  image: 'Image', svg: 'SVG image', sqlite: 'SQLite database', binary: 'Binary',
};

// Each renderer takes the item ({path, type, ...}) and returns a node.
export const TABS = {
  Editor: (item) => editor(item.path, item.text),
  Bytes: (item) => {
    const pre = document.createElement('pre');
    pre.className = 'hex';
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', 'Bytes');
    pre.append(...hexDump(item.headBytes));
    const shown = item.headBytes.length < item.size
      ? `First ${formatSize(item.headBytes.length)} shown. Download the file to see all of it.` : '';
    const wrap = document.createDocumentFragment();
    if (shown) wrap.append(note(shown));
    wrap.append(pre);
    return wrap;
  },
  Details: (item) => {
    const wrap = document.createDocumentFragment();
    const storage = state.areas.find((a) => a.id === state.areaId).label;
    if (item.type === 'folder') {
      const list = state.children.get(item.path);
      wrap.append(meta([
        ['Folder', `/${item.path}`],
        ['Storage', storage],
        ['Contains', list ? itemCount(list.length) : 'Expand the folder to list it'],
      ]));
    } else if (item.error) {
      wrap.append(meta([['File', `/${item.path}`], ['Storage', storage]]), note(item.error, true));
    } else {
      wrap.append(meta([
        ['File', `/${item.path}`],
        ['Storage', storage],
        ['Size', `${formatSize(item.size)} (${item.size.toLocaleString()} bytes)`],
        ['Modified', modified(item)],
        ['Type', TYPE_LABELS[item.type]],
      ]));
    }
    return wrap;
  },
};

export function tabsFor(type) {
  const names = TABS_BY_TYPE[type].filter((name) => name in TABS);
  // Until a type's own views exist, show its bytes.
  if (type !== 'folder' && names.length === 1) names.unshift('Bytes');
  return names;
}

const itemCount = (n) => `${n} item${n === 1 ? '' : 's'}`;
const modified = (item) => (item.lastModified ? new Date(item.lastModified).toLocaleString() : 'unknown');

export async function showDetail() {
  // Never draw over unsaved edits, and let only the newest call draw.
  if (state.dirty) return;
  const run = ++state.detailRun;
  const stale = () => run !== state.detailRun || state.dirty;
  const sel = state.selected;
  if (!sel) {
    drawCard(null);
    return;
  }
  if (sel.kind === 'directory') {
    drawCard({ path: sel.path, type: 'folder' });
    return;
  }
  let head;
  try {
    head = await call('read', { area: currentArea(), path: sel.path, offset: 0, length: PREVIEW_BYTES });
  } catch (error) {
    if (stale()) return;
    drawCard({ path: sel.path, type: typeOf({ name: baseName(sel.path), kind: 'file' }), error: error.message });
    return;
  }
  if (stale()) return;
  const headBytes = fromBase64(head.data);
  const item = { path: sel.path, size: head.size, lastModified: head.lastModified, headBytes };
  const isSqlite = new TextDecoder('latin1').decode(headBytes.subarray(0, 16)) === SQLITE_HEADER;
  item.type = isSqlite ? 'sqlite' : typeOf({ name: baseName(sel.path), kind: 'file' });
  // SVG is an image that is also text, so it gets the editor.
  if (item.type === 'image' && /\.svg$/i.test(sel.path)) item.type = 'svg';
  if (['text', 'json', 'code', 'markdown', 'svg', 'binary'].includes(item.type)) {
    // Any file that reads as text gets the editor, whatever its name.
    item.text = head.size <= TEXT_LIMIT
      ? decodeText(head.size <= headBytes.length ? headBytes : await readAll(sel.path, head.size)) : null;
    if (stale()) return;
    if (item.text === null) item.type = 'binary';
    else if (item.type === 'binary') item.type = 'text';
  }
  drawCard(item);
}

function drawCard(item) {
  // An open question from an action stays, or its answer would never come.
  // Removed one by one, so the question keeps focus.
  for (const node of [...els.cardBody.childNodes]) if (!node.classList || !node.classList.contains('prompt')) node.remove();
  if (!item) {
    els.cardHead.replaceChildren();
    els.cardTabs.replaceChildren();
    els.cardTabs.hidden = true;
    els.cardBody.append(note('Select a file or folder.'));
    els.cardBody.classList.add('blank');
    return;
  }
  els.cardBody.classList.remove('blank');
  els.cardHead.replaceChildren(cardHead(item));
  // A file that could not be read has only its details.
  const names = item.error ? ['Details'] : tabsFor(item.type);
  // Keep the open tab when the same item is drawn again.
  const keep = state.tab && state.tab.path === item.path && names.includes(state.tab.name);
  const active = keep ? state.tab.name : names[0];
  const tabs = names.map((name, i) => {
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.id = `tab-${i}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${i}`);
    tab.textContent = name;
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.id = `panel-${i}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    els.cardBody.append(panel);
    const open = () => {
      for (const t of tabs) {
        const on = t.tab === tab;
        t.tab.setAttribute('aria-selected', String(on));
        t.tab.tabIndex = on ? 0 : -1;
        t.panel.hidden = !on;
      }
      // Draw a tab the first time it opens, then keep it, so edits survive.
      if (!panel.hasChildNodes()) panel.append(TABS[name](item));
      state.tab = { path: item.path, name };
    };
    tab.addEventListener('click', open);
    return { tab, panel, open };
  });
  els.cardTabs.replaceChildren(...tabs.map((t) => t.tab));
  els.cardTabs.hidden = false;
  els.cardTabs.onkeydown = (event) => {
    const i = tabs.findIndex((t) => t.tab === document.activeElement);
    if (i < 0) return;
    const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const next = tabs[(keys[event.key] + tabs.length) % tabs.length];
    next.open();
    next.tab.focus();
  };
  tabs[names.indexOf(active)].open();
}

function cardHead(item) {
  const wrap = document.createDocumentFragment();
  const name = item.path ? baseName(item.path) : '/';
  const icon = iconFor({ name, kind: item.type === 'folder' ? 'directory' : 'file', type: item.type });
  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = name;
  const sub = document.createElement('p');
  sub.className = 'card-sub';
  if (item.type === 'folder') {
    const list = state.children.get(item.path);
    sub.textContent = list ? itemCount(list.length) : 'Folder';
  } else if (!item.error) {
    sub.textContent = `${formatSize(item.size)} · ${modified(item)}`;
  }
  const text = document.createElement('div');
  text.className = 'card-text';
  text.append(title, sub);
  wrap.append(icon, text);
  if (item.type !== 'folder') {
    const badge = document.createElement('span');
    badge.className = `badge badge-${item.type}`;
    badge.textContent = TYPE_LABELS[item.type];
    wrap.append(badge);
  }
  return wrap;
}

function note(text, isError = false) {
  const p = document.createElement('p');
  p.className = isError ? 'note error' : 'note';
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
  save.className = 'primary';
  save.dataset.cmd = 'save';
  save.textContent = 'Save';
  save.disabled = true;
  const discard = document.createElement('button');
  discard.textContent = 'Discard changes';
  discard.dataset.cmd = 'discard';
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
      showUsage();
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
