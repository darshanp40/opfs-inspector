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
  canWrite: true,
  expanded: new Set(['']),
  children: new Map(),
  selected: null, // { path, kind }
  dirty: false,
  chunk: 512 * 1024,
  detailRun: 0,
  tab: null, // { path, name } of the open card tab
  usageRun: 0,
};

export const currentArea = () => (state.areas.find((a) => a.id === state.areaId) || state.areas[0]).area;

export function setStatus(message, kind = '') {
  els.status.textContent = message || '';
  els.status.className = `status ${kind}`;
}

export function fail(error) {
  setStatus(error.message || String(error), 'error');
}
