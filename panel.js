// The panel. It talks to the page only through transport.call(), so it can
// also run against ops.js directly in tests.
(() => {
  const TEXT_LIMIT = 2 * 1024 * 1024;
  const PREVIEW_BYTES = 4096;
  const SQLITE_HEADER = 'SQLite format 3\u0000';

  const $ = (id) => document.getElementById(id);
  const els = {
    area: $('area'), refresh: $('refresh'), newFile: $('new-file'), newFolder: $('new-folder'),
    upload: $('upload'), uploadInput: $('upload-input'), rename: $('rename'), download: $('download'),
    remove: $('delete'), origin: $('origin'), status: $('status'), tree: $('tree'), detail: $('detail'),
  };

  const state = {
    areas: [],
    areaId: 'default',
    canWrite: true,
    expanded: new Set(['']),
    children: new Map(),
    selected: null, // { path, kind }
    dirty: false,
    chunk: 512 * 1024,
    detailRun: 0,
  };

  const transport = window.opfsTransport || extensionTransport();

  function extensionTransport() {
    const api = globalThis.browser || globalThis.chrome;
    const tabId = api.devtools
      ? api.devtools.inspectedWindow.tabId
      : Number(new URLSearchParams(location.search).get('tabId'));
    let port = null;
    let nextId = 1;
    const waiting = new Map();
    function connect() {
      port = api.runtime.connect({ name: 'opfs-inspector' });
      port.onMessage.addListener((reply) => {
        const resolve = waiting.get(reply.id);
        waiting.delete(reply.id);
        if (resolve) resolve(reply);
      });
      port.onDisconnect.addListener(() => {
        port = null;
        for (const resolve of waiting.values()) resolve({ ok: false, error: 'The extension restarted. Try again.' });
        waiting.clear();
      });
    }
    return {
      call(op, args) {
        if (!port) connect();
        const id = nextId++;
        return new Promise((resolve) => {
          waiting.set(id, resolve);
          port.postMessage({ id, tabId, op, args });
        });
      },
      onNavigated(listener) {
        if (api.devtools) api.devtools.network.onNavigated.addListener(listener);
      },
    };
  }

  async function call(op, args) {
    const reply = await transport.call(op, args);
    if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'No answer from the page.');
    return reply.value;
  }

  const currentArea = () => (state.areas.find((a) => a.id === state.areaId) || state.areas[0]).area;
  const join = (dir, name) => (dir ? `${dir}/${name}` : name);
  const parentOf = (path) => path.split('/').slice(0, -1).join('/');
  const baseName = (path) => path.split('/').pop();

  function setStatus(message, kind = '') {
    els.status.textContent = message || '';
    els.status.className = `status ${kind}`;
  }

  function fail(error) {
    setStatus(error.message || String(error), 'error');
  }

  function formatSize(size) {
    if (size == null) return '';
    if (size < 1024) return `${size} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = size / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
  }

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  // ---- loading ----

  async function loadAreas() {
    const info = await call('areas');
    state.areas = info.areas;
    state.canWrite = info.canWrite;
    if (!state.areas.some((a) => a.id === state.areaId)) state.areaId = 'default';
    els.area.replaceChildren(...state.areas.map((a) => new Option(a.label, a.id, false, a.id === state.areaId)));
    els.origin.textContent = info.origin + (info.hasBuckets ? '' : ' (no storage buckets in this browser)');
  }

  async function loadFolder(path) {
    state.children.set(path, await call('list', { area: currentArea(), path }));
  }

  async function reloadExpanded() {
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

  async function refresh() {
    try {
      await loadAreas();
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

  // ---- tree ----

  function renderTree() {
    const rows = [];
    const rootRow = row({ path: '', name: '/', kind: 'directory', depth: 0 });
    rows.push(rootRow);
    if (state.expanded.has('')) addChildren('', 1, rows);
    els.tree.replaceChildren(...rows);
  }

  function addChildren(path, depth, rows) {
    const list = state.children.get(path);
    if (!list) return;
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.paddingLeft = `${8 + depth * 14 + 18}px`;
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
    div.style.paddingLeft = `${8 + entry.depth * 14}px`;
    if (state.selected && state.selected.path === entry.path) div.classList.add('selected');
    if (entry.error) {
      div.classList.add('error');
      div.title = entry.error;
    }
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    if (entry.kind === 'directory') {
      twisty.textContent = state.expanded.has(entry.path) ? '▾' : '▸';
      div.setAttribute('aria-expanded', String(state.expanded.has(entry.path)));
      twisty.addEventListener('click', (event) => {
        event.stopPropagation();
        toggle(entry.path);
      });
    }
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.kind === 'directory' && entry.path ? `${entry.name}/` : entry.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = entry.kind === 'file' ? formatSize(entry.size) : '';
    div.append(twisty, name, size);
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

  async function toggle(path) {
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

  async function select(path, kind) {
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

  function updateButtons() {
    const sel = state.selected;
    const writable = state.canWrite;
    els.newFile.disabled = false;
    els.newFolder.disabled = false;
    els.upload.disabled = !writable;
    els.rename.disabled = !sel || sel.path === '';
    els.download.disabled = !sel || sel.kind !== 'file';
    els.remove.disabled = !sel || sel.path === '';
  }

  // ---- detail ----

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

  async function readAll(path, size) {
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

  async function showDetail() {
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

  // ---- actions ----

  function targetFolder() {
    const sel = state.selected;
    if (!sel) return '';
    return sel.kind === 'directory' ? sel.path : parentOf(sel.path);
  }

  // Asks for a name inside the detail pane. Resolves to null on cancel.
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
        resolve(value);
      };
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        done(input.value.trim() || null);
      });
      cancel.addEventListener('click', () => done(null));
      els.detail.prepend(form);
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
        resolve(value);
      };
      yes.addEventListener('click', () => done(true));
      no.addEventListener('click', () => done(false));
      els.detail.prepend(box);
      yes.focus();
    });
  }

  async function afterChange(message, selectPath, kind) {
    await reloadExpanded();
    if (selectPath !== undefined) {
      state.dirty = false;
      state.selected = selectPath === null ? null : { path: selectPath, kind };
    }
    renderTree();
    updateButtons();
    await showDetail();
    setStatus(message, 'ok');
  }

  async function create(kind) {
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

  async function rename() {
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

  async function remove() {
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

  async function download() {
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

  async function upload(files) {
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

  // ---- wiring ----

  els.area.addEventListener('change', async () => {
    if (state.dirty) {
      els.area.value = state.areaId;
      return setStatus('Save or discard your changes first.', 'error');
    }
    state.areaId = els.area.value;
    state.expanded = new Set(['']);
    state.children.clear();
    state.selected = null;
    await refresh();
  });
  els.refresh.addEventListener('click', () => {
    if (state.dirty) return setStatus('Save or discard your changes first.', 'error');
    refresh();
  });
  els.newFile.addEventListener('click', () => create('file'));
  els.newFolder.addEventListener('click', () => create('directory'));
  els.rename.addEventListener('click', rename);
  els.remove.addEventListener('click', remove);
  els.download.addEventListener('click', download);
  els.upload.addEventListener('click', () => els.uploadInput.click());
  els.uploadInput.addEventListener('change', async () => {
    const files = [...els.uploadInput.files];
    els.uploadInput.value = '';
    if (files.length) await upload(files);
  });

  if (transport.onNavigated) {
    transport.onNavigated(() => {
      state.expanded = new Set(['']);
      state.children.clear();
      state.selected = null;
      state.dirty = false;
      state.areaId = 'default';
      refresh();
    });
  }

  updateButtons();
  refresh();
})();
