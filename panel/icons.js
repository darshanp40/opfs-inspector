// File type detection and the small inline icons for each type.
const EXT = {
  json: 'json',
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', css: 'code', html: 'code', htm: 'code',
  md: 'markdown', markdown: 'markdown',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', svg: 'image', bmp: 'image', ico: 'image',
  db: 'sqlite', sqlite: 'sqlite', sqlite3: 'sqlite',
  txt: 'text', log: 'text', csv: 'text', tsv: 'text', xml: 'text', yaml: 'text', yml: 'text', toml: 'text', ini: 'text',
};

// 'folder', 'text', 'json', 'code', 'markdown', 'image', 'sqlite' or 'binary', from the name only.
export function typeOf({ name, kind }) {
  if (kind === 'directory') return 'folder';
  const dot = name.lastIndexOf('.');
  return (dot > 0 && EXT[name.slice(dot + 1).toLowerCase()]) || 'binary';
}

const PAGE = 'M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13';
const PATHS = {
  folder: 'M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z',
  text: `${PAGE} M6 8h5 M6 10.5h5`,
  json: 'M5.5 2.5c-2 0-1.5 2.5-1.5 3.5S3 8 2 8c1 0 2 0 2 2s-.5 3.5 1.5 3.5 M10.5 2.5c2 0 1.5 2.5 1.5 3.5s1 2 2 2c-1 0-2 0-2 2s.5 3.5-1.5 3.5',
  code: 'M5.5 4.5 2 8l3.5 3.5 M10.5 4.5 14 8l-3.5 3.5 M9 3 7 13',
  markdown: 'M1.5 3.5h13v9h-13z M3.5 10.5v-5l2 2.5 2-2.5v5 M11.5 5.5v5 M9.5 8.5l2 2 2-2',
  image: 'M1.5 2.5h13v11h-13z M1.5 11l4-4 3 3 2-2 4 4 M11 5.5h.01',
  svg: 'M1.5 2.5h13v11h-13z M1.5 11l4-4 3 3 2-2 4 4 M11 5.5h.01',
  sqlite: 'M2.5 3.5c0-1.1 2.5-2 5.5-2s5.5.9 5.5 2v9c0 1.1-2.5 2-5.5 2s-5.5-.9-5.5-2z M2.5 3.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2 M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2',
  binary: PAGE,
};

// An SVG icon for {name, kind}. A known type can be passed as entry.type.
export function iconFor(entry) {
  const type = entry.type || typeOf(entry);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon icon-${type}`);
  const path = document.createElementNS(ns, 'path');
  // Stroke and size come from panel.css.
  path.setAttribute('d', PATHS[type]);
  svg.append(path);
  return svg;
}
