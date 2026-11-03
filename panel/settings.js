// Settings kept in the panel's own localStorage, and the dialog that edits them.

const KEY = 'opfs-inspector:settings';
const DEFAULTS = { jsonIndent: 2, sortKeys: false, folderSize: 'own', editorFontSize: 12 };
const VALID = {
  jsonIndent: (v) => v === 2 || v === 4 || v === '\t',
  sortKeys: (v) => typeof v === 'boolean',
  folderSize: (v) => v === 'own' || v === 'recursive',
  editorFontSize: (v) => Number.isInteger(v) && v >= 8 && v <= 32,
};

let memory = null; // used when localStorage is blocked
const listeners = new Set();

// Anything missing or invalid falls back to its default.
export function getSettings() {
  let saved = memory || {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY)) || saved;
  } catch {
    // Storage blocked or the text is damaged: use the defaults.
  }
  const out = { ...DEFAULTS };
  for (const name of Object.keys(DEFAULTS)) if (VALID[name](saved[name])) out[name] = saved[name];
  return out;
}

export function setSettings(partial) {
  const before = getSettings();
  const next = { ...before };
  for (const name of Object.keys(DEFAULTS)) if (name in partial && VALID[name](partial[name])) next[name] = partial[name];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not saved, but this session still uses them.
    memory = next;
  }
  for (const listener of listeners) listener(next, before);
}

// Calls listener(settings) after each change. Returns a function that stops it.
export function onSettingsChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openSettings() {
  const dialog = document.getElementById('settings-dialog');
  const field = (id) => document.getElementById(id);
  const s = getSettings();
  field('set-indent').value = String(s.jsonIndent);
  field('set-sort').checked = s.sortKeys;
  field('set-folder').value = s.folderSize;
  field('set-font').value = s.editorFontSize;
  field('settings-status').textContent = '';
  dialog.showModal();
}

export function bindSettings() {
  const field = (id) => document.getElementById(id);
  const save = (partial, message) => {
    setSettings(partial);
    // The dialog makes the rest of the page inert, so say it inside the dialog.
    field('settings-status').textContent = message;
  };
  field('set-indent').addEventListener('change', (e) => save({ jsonIndent: e.target.value === '\t' ? '\t' : Number(e.target.value) }, 'JSON indent saved.'));
  field('set-sort').addEventListener('change', (e) => save({ sortKeys: e.target.checked }, 'Sort keys saved.'));
  field('set-folder').addEventListener('change', (e) => save({ folderSize: e.target.value }, 'Folder size setting saved.'));
  field('set-font').addEventListener('change', (e) => {
    // Keep it in range, and show the value that was kept.
    const size = Math.min(32, Math.max(8, Math.round(Number(e.target.value)) || DEFAULTS.editorFontSize));
    e.target.value = size;
    save({ editorFontSize: size }, 'Editor font size saved.');
  });
}
