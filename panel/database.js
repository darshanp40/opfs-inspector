// The SQLite viewer: Table and Query tabs on an in-memory snapshot.
// The worker and its wasm load the first time a database opens.
// Table names and values come from the site, so they are shown as text only.
import { register } from './commands.js';
import { currentArea, setStatus, fail } from './state.js';
import { formatSize } from './format.js';
import { getSettings, onSettingsChange } from './settings.js';
import { takeSnapshot } from './snapshot.js';
import { download } from './actions.js';

const PAGE = 100;
const PROGRESS_FROM = 5 * 1024 * 1024;

const QUERY_LIMIT = 30_000;

let worker = null;
let nextId = 1;
const waiting = new Map();
// The open snapshot's bytes, so a new worker can open it again.
// ponytail: keeps a second copy in the panel, up to the 200 MB limit.
let openBytes = null;

// Ends the worker and fails what waits on it. The next call starts a new one.
function stopWorker(message) {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const reply of waiting.values()) reply.reject(new Error(message));
  waiting.clear();
}

function send(type, args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...args });
  });
}

// Sends one message to the worker and resolves to its value.
function ask(type, args = {}) {
  if (!worker) {
    worker = new Worker(new URL('sqlite.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const reply = waiting.get(data.id);
      waiting.delete(data.id);
      if (!reply) return;
      if (data.ok) reply.resolve(data.value);
      else reply.reject(new Error(data.error));
    };
    worker.onerror = () => stopWorker('SQLite stopped. Try Reload snapshot.');
    // The worker runs messages in order, so this opens before the call below.
    if (type !== 'open' && openBytes) send('open', { bytes: openBytes }).catch(() => {});
  }
  if (type === 'open') openBytes = args.bytes;
  return send(type, args);
}

let current = null; // the snapshot of the database on the card
let queryEditor = null;

// Called when the card is drawn again.
export function closeSqlite() {
  current = null;
  openBytes = null;
  if (queryEditor) {
    queryEditor.destroy();
    queryEditor = null;
  }
}

function note(text, isError = false) {
  const p = document.createElement('p');
  p.className = isError ? 'note error' : 'note';
  p.textContent = text;
  return p;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// One snapshot for the item, shared by its tabs. A reload bumps run.
function session(item) {
  if (current && current.item === item) return current;
  const s = { item, area: currentArea(), run: 0, ready: null, views: new Set() };
  const text = document.createElement('span');
  text.className = 'note';
  text.setAttribute('role', 'status');
  const get = button('Download', download);
  s.bar = document.createElement('div');
  s.bar.className = 'snap';
  s.bar.append(text, get, button('Reload snapshot', () => load(s)));
  s.say = (message, isError = false, tooLarge = false) => {
    text.textContent = message;
    text.className = isError ? 'note error' : 'note';
    get.hidden = !tooLarge;
  };
  current = s;
  load(s);
  return s;
}

function load(s) {
  const run = ++s.run;
  // A long query must not hold up the new snapshot.
  if (waiting.size) stopWorker('Stopped, as a new snapshot was taken.');
  const live = () => s === current && run === s.run;
  s.say('Taking a snapshot…');
  s.ready = takeSnapshot(s.area, s.item.path, {
    onProgress(done, total) {
      if (total > PROGRESS_FROM && live()) s.say(`Copying the database… ${Math.floor((done / total) * 100)}%`);
    },
  }).then(async ({ db, takenAt, walApplied }) => {
    // A newer snapshot, or another database, owns the worker now.
    if (!live()) return;
    await ask('open', { bytes: db });
    if (live()) s.say(`Snapshot taken ${new Date(takenAt).toLocaleTimeString()}${walApplied ? ', with the -wal file' : ''}`);
  });
  s.ready.catch((error) => {
    if (live()) s.say(error.message, true, /Too large/.test(error.message));
  });
  for (const view of s.views) view(run);
}

// Waits for the snapshot. False when it failed or a newer one started.
async function opened(s, run, node) {
  try {
    await s.ready;
  } catch {
    return false;
  }
  return run === s.run && node.isConnected;
}

// Head row: column names, with types under them when known.
function grid(label, { columns, types = [], rows }) {
  const wrap = document.createElement('div');
  wrap.className = 'grid-wrap';
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', label);
  const table = document.createElement('table');
  table.className = 'grid';
  const caption = document.createElement('caption');
  caption.className = 'visually-hidden';
  caption.textContent = label;
  const head = document.createElement('tr');
  columns.forEach((name, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = name;
    if (types[i]) {
      const type = document.createElement('span');
      type.className = 'type';
      type.textContent = types[i];
      th.append(type);
    }
    head.append(th);
  });
  const body = document.createElement('tbody');
  for (const values of rows) {
    const tr = document.createElement('tr');
    for (const value of values) {
      const td = document.createElement('td');
      if (value === null) {
        td.textContent = 'NULL';
        td.className = 'muted';
      } else if (value instanceof Uint8Array) {
        td.textContent = `BLOB, ${formatSize(value.length)}`;
        td.className = 'muted';
      } else {
        td.textContent = String(value);
        if (td.textContent.length > 60) td.title = td.textContent;
      }
      tr.append(td);
    }
    body.append(tr);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  table.append(caption, thead, body);
  wrap.append(table);
  return wrap;
}

export function snapshotBar(item) {
  return session(item).bar;
}

export function tableView(item) {
  const s = session(item);
  const box = document.createElement('div');
  box.className = 'sql-view';
  const picker = document.createElement('select');
  const label = document.createElement('label');
  label.append('Table ', picker);
  const prev = button('Previous', () => page(offset - PAGE));
  const next = button('Next', () => page(offset + PAGE));
  const count = document.createElement('span');
  count.className = 'note count';
  const tools = document.createElement('div');
  tools.className = 'actions';
  tools.append(label, prev, next, count);
  const body = document.createElement('div');
  body.className = 'sql-body';
  box.append(tools, body);
  let table = null;
  let offset = 0;
  tools.hidden = true;

  async function page(at) {
    const run = s.run;
    try {
      const r = await ask('rows', { table, offset: at, limit: PAGE });
      if (run !== s.run || !box.isConnected) return;
      offset = at;
      body.replaceChildren(grid(`Rows of ${table}`, r));
      count.textContent = r.total ? `Rows ${(offset + 1).toLocaleString()}–${(offset + r.rows.length).toLocaleString()} of ${r.total.toLocaleString()}` : 'No rows';
      prev.disabled = offset === 0;
      next.disabled = offset + PAGE >= r.total;
    } catch (error) {
      if (box.isConnected) body.replaceChildren(note(error.message, true));
    }
  }

  async function show(run) {
    if (!(await opened(s, run, box))) return;
    try {
      const list = await ask('tables');
      if (run !== s.run || !box.isConnected) return;
      if (!list.length) {
        tools.hidden = true;
        body.replaceChildren(note('This database has no tables.'));
        return;
      }
      picker.replaceChildren(...list.map(({ name, type }) => new Option(type === 'view' ? `${name} (view)` : name, name)));
      // Keep the table and page across a reload when the table is still there.
      if (!list.some((t) => t.name === table)) {
        table = list[0].name;
        offset = 0;
      }
      picker.value = table;
      tools.hidden = false;
      await page(offset);
    } catch (error) {
      if (box.isConnected) body.replaceChildren(note(error.message, true));
    }
  }
  picker.addEventListener('change', () => {
    table = picker.value;
    page(0);
  });
  s.views.add(show);
  show(s.run);
  return box;
}

export function queryView(item) {
  const s = session(item);
  const box = document.createElement('div');
  box.className = 'sql-view';
  const runButton = button('Run', run);
  runButton.className = 'primary';
  runButton.dataset.cmd = 'run-query';
  runButton.disabled = true;
  const cancel = button('Cancel query', () => stopWorker('Cancelled the query.'));
  cancel.hidden = true;
  const hint = note('One statement at a time, read-only.');
  const tools = document.createElement('div');
  tools.className = 'actions';
  tools.append(runButton, cancel, hint);
  const host = document.createElement('div');
  host.className = 'editor query-editor';
  const result = document.createElement('div');
  result.className = 'sql-body sql-result';
  box.append(tools, host, result);

  async function run() {
    const at = s.run;
    result.replaceChildren(note('Running…'));
    if (!(await opened(s, at, box))) {
      if (box.isConnected) result.replaceChildren(note('There is no snapshot to query. Try Reload snapshot.', true));
      return;
    }
    // Only one query at a time. A query that never ends stops the worker.
    runButton.disabled = true;
    cancel.hidden = false;
    const timer = setTimeout(() => stopWorker(`The query ran for over ${QUERY_LIMIT / 1000} seconds, so it was stopped.`), QUERY_LIMIT);
    try {
      const r = await ask('query', { sql: queryEditor.getText() });
      if (!box.isConnected) return;
      if (!r.columns.length) {
        result.replaceChildren(note('Done. The statement returned no rows.'));
        setStatus('Ran the statement.', 'ok');
        return;
      }
      const n = r.rows.length;
      const summary = r.truncated ? `Showing the first ${n.toLocaleString()} rows.` : `${n.toLocaleString()} row${n === 1 ? '' : 's'}.`;
      result.replaceChildren(note(summary), grid('Query result', r));
      setStatus(summary, 'ok');
    } catch (error) {
      if (!box.isConnected) return;
      const cancelled = error.message === 'Cancelled the query.';
      result.replaceChildren(note(error.message, !cancelled));
      if (cancelled) setStatus(error.message);
      else fail(error);
    } finally {
      clearTimeout(timer);
      const hadFocus = document.activeElement === cancel;
      runButton.disabled = false;
      cancel.hidden = true;
      if (hadFocus) runButton.focus();
    }
  }

  import('./editor.entry.js').then(({ createEditor }) => {
    if (!host.isConnected) return;
    if (queryEditor) queryEditor.destroy();
    queryEditor = createEditor(host, {
      text: 'select name, type from sqlite_schema',
      language: 'sql',
      fontSize: getSettings().editorFontSize,
      dark: document.documentElement.dataset.theme === 'dark',
      label: 'SQL query',
    });
    runButton.disabled = false;
  }).catch(fail);
  return box;
}

const runButton = () => document.querySelector('#card-body [data-cmd="run-query"]:not(.markdown *)');
register({
  id: 'run-query', label: 'Run query', keys: 'Mod+Enter', scope: 'query', typing: true,
  when: () => !!runButton() && !runButton().disabled, run: () => runButton().click(),
});

onSettingsChange((now, before) => {
  if (queryEditor && now.editorFontSize !== before.editorFontSize) queryEditor.setFontSize(now.editorFontSize);
});
