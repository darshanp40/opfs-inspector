// The image preview: zoom, rotate and pixel size. Site content is untrusted, so
// every image, SVG included, is shown only through <img src=blob:>.
import { register } from './commands.js';

export const IMAGE_LIMIT = 5 * 1024 * 1024;
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
};
const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

// The image type from the name, or else from the first bytes. null if neither says.
export function imageMime(name, bytes) {
  const dot = name.lastIndexOf('.');
  const byName = dot > 0 && MIME[name.slice(dot + 1).toLowerCase()];
  if (byName) return byName;
  const head = ascii(bytes, 0, 12);
  if (head.startsWith('\x89PNG')) return MIME.png;
  if (head.startsWith('\xff\xd8\xff')) return MIME.jpg;
  if (head.startsWith('GIF8')) return MIME.gif;
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return MIME.webp;
  if (head.slice(4, 8) === 'ftyp' && /avif|avis/.test(ascii(bytes, 8, 12))) return MIME.avif;
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return MIME.ico;
  return null;
}

let active = null; // the preview on show, for the zoom and rotate commands

export function showImage(container, blob, name) {
  const url = URL.createObjectURL(blob);
  let zoom = null; // null fits the picture to the view
  let turns = 0;
  const button = (label, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const view = document.createElement('div');
  view.className = 'image-view';
  const bar = document.createElement('div');
  bar.className = 'actions';
  const info = document.createElement('span');
  info.className = 'note';
  const port = document.createElement('div');
  port.className = 'image-port';
  port.tabIndex = 0;
  port.setAttribute('role', 'group');
  port.setAttribute('aria-label', `Preview of ${name}`);
  const img = document.createElement('img');
  img.alt = name;
  port.append(img);

  const size = () => ({ w: img.naturalWidth || 300, h: img.naturalHeight || 150 });
  const fitZoom = () => {
    const { w, h } = size();
    const [vw, vh] = turns % 2 ? [h, w] : [w, h];
    return Math.min(1, port.clientWidth / vw, port.clientHeight / vh) || 1;
  };
  function draw() {
    const { w, h } = size();
    const z = zoom ?? fitZoom();
    img.style.width = `${w * z}px`;
    img.style.height = `${h * z}px`;
    img.style.transform = `rotate(${turns * 90}deg)`;
    // A turned picture takes the room of its turned shape.
    img.style.margin = turns % 2 ? `${(w * z - h * z) / 2}px ${(h * z - w * z) / 2}px` : '';
    info.textContent = `${w} × ${h} px · ${zoom === null ? 'Fit, ' : ''}${Math.round(z * 100)}%`;
  }
  const step = (by) => {
    zoom = Math.min(8, Math.max(0.1, Math.round(((zoom ?? fitZoom()) + by) * 100) / 100));
    draw();
  };
  const api = {
    zoomIn: () => step(0.25),
    zoomOut: () => step(-0.25),
    rotate: () => {
      turns = (turns + 1) % 4;
      draw();
    },
    destroy() {
      if (active === api) active = null;
      URL.revokeObjectURL(url);
      img.removeAttribute('src');
      container.replaceChildren();
    },
  };
  bar.append(
    button('Fit', () => { zoom = null; draw(); }),
    button('100%', () => { zoom = 1; draw(); }),
    button('Zoom in', api.zoomIn),
    button('Zoom out', api.zoomOut),
    button('Rotate', api.rotate),
    info,
  );
  img.addEventListener('load', draw);
  img.addEventListener('error', () => {
    info.textContent = 'This image cannot be shown.';
    img.hidden = true;
  });
  img.src = url;
  view.append(bar, port);
  container.replaceChildren(view);
  active = api;
  return api;
}

// Keys work while focus is in the preview, so the tree keeps its typing.
const shown = () => active !== null;
register({ id: 'zoom-in', label: 'Zoom in', keys: '+', scope: 'preview', when: shown, run: () => active.zoomIn() });
register({ id: 'zoom-out', label: 'Zoom out', keys: '-', scope: 'preview', when: shown, run: () => active.zoomOut() });
register({ id: 'rotate', label: 'Rotate image', keys: 'R', scope: 'preview', when: shown, run: () => active.rotate() });
