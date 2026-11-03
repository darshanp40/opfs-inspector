// Start-up: registers the commands and loads the first listing.
import { onNavigated } from './transport.js';
import { applyTheme } from './theme.js';
import { els, state, setStatus, selectOnly } from './state.js';
import { refresh, updateButtons, focusedItem, selectAll, select, toggle } from './tree.js';
import { create, rename, remove, download, upload, duplicate, targets, moveAsk, openStorage } from './actions.js';
import { register, bindToolbar } from './commands.js';
import { openHelp } from './menu.js';
import { openSettings, bindSettings } from './settings.js';
import { parentOf } from './format.js';

const saveFirst = () => setStatus('Save or discard your changes first.', 'error');

els.area.addEventListener('change', async () => {
  if (state.dirty) {
    els.area.value = state.areaId;
    return saveFirst();
  }
  state.areaId = els.area.value;
  state.expanded = new Set(['']);
  state.children.clear();
  selectOnly(null);
  await refresh();
});
els.uploadInput.addEventListener('change', async () => {
  const files = [...els.uploadInput.files];
  els.uploadInput.value = '';
  if (files.length) await upload(files);
});

// The root is only ever the sole target, so checking the first is enough.
const hasItem = () => {
  const list = targets();
  return list.length > 0 && list[0].path !== '';
};
const closedFolder = () => {
  const f = focusedItem();
  return !!f && f.kind === 'directory' && !state.expanded.has(f.path);
};
const openFolder = () => {
  const f = focusedItem();
  return !!f && f.kind === 'directory' && state.expanded.has(f.path);
};
const editorButton = (cmd) => els.cardBody.querySelector(`[data-cmd="${cmd}"]`);
const stepTab = (step) => {
  const tabs = [...els.cardTabs.querySelectorAll('[role=tab]')];
  const at = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
  const next = tabs[(at + step + tabs.length) % tabs.length];
  next.click();
  next.focus();
  setStatus(`${next.textContent} tab.`);
};
const hasTabs = () => els.cardTabs.children.length > 1;

register({
  id: 'refresh', label: 'Refresh', tip: 'Reload the file listing', keys: 'Alt+R', toolbar: true, typing: true,
  run: () => (state.dirty ? saveFirst() : refresh()),
});
register({
  id: 'new-file', label: 'New file', tip: 'Create a file in the selected folder', keys: 'Mod+Alt+N', toolbar: true, menu: true, typing: true,
  run: () => create('file'),
});
register({
  id: 'new-folder', label: 'New folder', tip: 'Create a folder in the selected folder', keys: 'Mod+Shift+N', toolbar: true, menu: true, typing: true,
  run: () => create('directory'),
});
register({
  id: 'upload', label: 'Upload', tip: 'Upload files into the selected folder', keys: 'Mod+U', toolbar: true, menu: true, typing: true,
  when: () => state.canWrite, run: () => els.uploadInput.click(),
});
register({ id: 'rename', label: 'Rename', tip: 'Rename the selected item', keys: 'F2', toolbar: true, menu: true, when: () => hasItem() && targets().length === 1, run: rename });
register({
  id: 'duplicate', label: 'Duplicate', tip: 'Copy the selected items into the same folder', keys: 'Mod+D', menu: true,
  when: () => hasItem() && state.canWrite, run: duplicate,
});
register({
  id: 'move', label: 'Move to…', tip: 'Move the selected items to another folder', keys: 'Alt+M', toolbar: true, menu: true,
  when: () => hasItem() && state.canWrite, run: moveAsk,
});
register({
  id: 'download', label: 'Download', tip: 'Download the selected file, or a zip of anything else', keys: 'Mod+S', scope: '!editor', swallow: true, toolbar: true, menu: true,
  when: () => targets().length > 0, run: download,
});
register({
  id: 'delete', label: 'Delete', tip: 'Delete the selected items', keys: ['Delete', 'Mod+Backspace'], scope: 'tree', toolbar: true, menu: true,
  when: hasItem, run: remove,
});
register({
  id: 'save', label: 'Save', keys: 'Mod+S', scope: 'editor', swallow: true, typing: true,
  when: () => state.dirty, run: () => editorButton('save').click(),
});
register({ id: 'discard', label: 'Discard changes', keys: 'Mod+Shift+Z', scope: 'editor', typing: true, when: () => state.dirty, run: () => editorButton('discard').click() });
register({
  id: 'format-json', label: 'Format JSON', keys: 'Mod+Shift+F', scope: 'editor', typing: true,
  when: () => !!editorButton('format-json') && !editorButton('format-json').disabled, run: () => editorButton('format-json').click(),
});
register({ id: 'select-all', label: 'Select all', keys: 'Mod+A', scope: 'tree', when: () => !!focusedItem(), run: selectAll });
register({
  id: 'copy-path', label: 'Copy path', keys: 'Mod+Alt+C', menu: true, when: () => state.selection.size > 0,
  async run() {
    await navigator.clipboard.writeText([...state.selection].map((p) => `/${p}`).join('\n'));
    setStatus(state.selection.size > 1 ? 'Copied the paths.' : 'Copied the path.', 'ok');
  },
});
register({
  id: 'collapse-all', label: 'Collapse all folders', keys: 'Mod+Shift+Left', when: () => state.expanded.size > 1,
  async run() {
    for (const path of [...state.expanded]) if (path && parentOf(path) === '') await toggle(path);
    setStatus('Collapsed all folders.', 'ok');
  },
});
register({ id: 'expand', label: 'Expand folder', keys: 'Right', scope: 'tree', when: closedFolder, run: () => toggle(focusedItem().path) });
register({ id: 'collapse', label: 'Collapse folder', keys: 'Left', scope: 'tree', when: openFolder, run: () => toggle(focusedItem().path) });
register({ id: 'open', label: 'Open', keys: 'Enter', scope: 'tree', when: () => !!focusedItem(), run: () => select(focusedItem().path, focusedItem().kind) });
register({
  id: 'go-up', label: 'Go to parent folder', keys: 'Backspace', scope: 'tree',
  when: () => !!focusedItem() && focusedItem().path !== '', run: () => select(parentOf(focusedItem().path), 'directory'),
});
register({
  id: 'folder-size', label: 'Calculate folder size', tip: 'Add up the size of the selected folder', keys: 'Mod+I', menu: true,
  when: () => !!state.selected && state.selected.kind === 'directory',
  run() {
    const button = editorButton('folder-size');
    if (button && !button.disabled) button.click();
  },
});
register({ id: 'settings', label: 'Settings', tip: 'Change the settings', keys: 'Mod+,', typing: true, toolbar: true, run: openSettings });
register({ id: 'help', label: 'Show keyboard shortcuts', keys: '?', run: openHelp });
register({ id: 'next-tab', label: 'Next tab', keys: 'Mod+Alt+Right', typing: true, when: hasTabs, run: () => stepTab(1) });
register({ id: 'prev-tab', label: 'Previous tab', keys: 'Mod+Alt+Left', typing: true, when: hasTabs, run: () => stepTab(-1) });

bindToolbar();
bindSettings();
document.getElementById('storage-details').addEventListener('click', () => openStorage());

// Esc hides a toolbar tooltip. It shows again for the next button.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.querySelector('.tools').classList.add('tips-off');
});
for (const button of document.querySelectorAll('.tools .icon-button')) {
  for (const type of ['mouseenter', 'focus']) button.addEventListener(type, () => button.parentElement.classList.remove('tips-off'));
}

onNavigated(() => {
  state.expanded = new Set(['']);
  state.children.clear();
  selectOnly(null);
  state.dirty = false;
  state.areaId = 'default';
  refresh();
});

applyTheme();
updateButtons();
refresh();
