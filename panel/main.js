// Start-up: wires the toolbar and loads the first listing.
import { onNavigated } from './transport.js';
import { els, state, setStatus } from './state.js';
import { refresh, updateButtons } from './tree.js';
import { create, rename, remove, download, upload } from './actions.js';

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

onNavigated(() => {
  state.expanded = new Set(['']);
  state.children.clear();
  state.selected = null;
  state.dirty = false;
  state.areaId = 'default';
  refresh();
});

updateButtons();
refresh();
