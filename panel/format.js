// Plain helpers with no page state.
export const join = (dir, name) => (dir ? `${dir}/${name}` : name);
export const parentOf = (path) => path.split('/').slice(0, -1).join('/');
export const baseName = (path) => path.split('/').pop();

export function formatSize(size) {
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

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Without JSON.rawJSON (Firefox 128 to 134) a number that would be written
// differently is refused, so formatting never changes data.
function checkNumbers(text) {
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*/g)) {
    if (token[0] !== '"' && JSON.stringify(Number(token)) !== token) {
      throw new Error(`Formatting would change the number ${token}, as this browser cannot keep it exact. The text was left as it is.`);
    }
  }
}

// Pretty-prints JSON. Numbers keep their written form where the browser can
// (JSON.rawJSON), so big integers are not rounded.
// ponytail: integer-like keys still sort first, as in any JS object.
export function formatJson(text, { indent = 2, sortKeys = false } = {}) {
  let value;
  try {
    value = JSON.parse(text, (key, v, context) => {
      if (typeof v === 'number' && context && JSON.rawJSON) return JSON.rawJSON(context.source);
      if (sortKeys && v && typeof v === 'object' && !Array.isArray(v)) {
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
      }
      return v;
    });
  } catch (error) {
    // Chromium gives a position, Firefox a line and column.
    const pos = /position (\d+)/.exec(error.message);
    const lc = /line (\d+) column (\d+)/.exec(error.message);
    let line;
    let column;
    if (!pos && lc) [line, column] = [Number(lc[1]), Number(lc[2])];
    else {
      const before = text.slice(0, pos ? Number(pos[1]) : text.length).split('\n');
      [line, column] = [before.length, before[before.length - 1].length + 1];
    }
    throw new SyntaxError(`Invalid JSON at line ${line}, column ${column}.`);
  }
  if (typeof JSON.rawJSON !== 'function') checkNumbers(text);
  return JSON.stringify(value, null, indent);
}
