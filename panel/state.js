// Shared panel state and the few helpers every module needs.
const $ = (id) => document.getElementById(id);
export const els = {
  area: $('area'), refresh: $('refresh'), newFile: $('new-file'), newFolder: $('new-folder'),
  upload: $('upload'), uploadInput: $('upload-input'), rename: $('rename'), download: $('download'),
  remove: $('delete'), origin: $('origin'), status: $('status'), tree: $('tree'), crumbs: $('crumbs'),
  cardHead: $('card-head'), cardTabs: $('card-tabs'), cardBody: $('card-body'), usage: $('usage'), usageMeter: $('usage-meter'),
};

export const state = {
  areas: [],
  areaId: 'default',
  origin: '',
  canWrite: true,
  expanded: new Set(['']),
  children: new Map(),
  selected: null, // { path, kind } of the item the card shows
  selection: new Set(), // paths of the selected rows
  anchor: null, // path that Shift ranges start from
  focus: '', // path of the row that takes Tab focus
  dirty: false,
  chunk: 512 * 1024,
  detailRun: 0,
  tab: null, // { path, name } of the open card tab
  usageRun: 0,
};

const selectionListeners = new Set();

// Calls listener(state) after each selection change. Returns a function that stops it.
export function onSelectionChange(listener) {
  selectionListeners.add(listener);
  return () => selectionListeners.delete(listener);
}

export function selectionChanged() {
  for (const listener of selectionListeners) listener(state);
}

// Selects one item, or nothing, and shows it on the card.
// The root can be shown on the card but is never in the selection.
export function selectOnly(entry) {
  state.selected = entry;
  state.selection = new Set(entry && entry.path !== '' ? [entry.path] : []);
  state.anchor = entry ? entry.path : null;
  if (entry) state.focus = entry.path;
  selectionChanged();
}

export const currentArea = () => (state.areas.find((a) => a.id === state.areaId) || state.areas[0]).area;

export function setStatus(message, kind = '') {
  els.status.textContent = message || '';
  els.status.className = `status ${kind}`;
}

export function fail(error) {
  setStatus(error.message || String(error), 'error');
}

// Puts focus back on the tree's current row.
export function focusTree() {
  const row = els.tree.querySelector('[tabindex="0"]');
  if (row) row.focus({ preventScroll: true });
}
