// Copies a database file, and its -wal file when there is one, into memory.
// The live file is only read, never opened by SQLite.
import { call } from './transport.js';
import { fromBase64 } from './format.js';
import { applyWal } from './wal.js';

export const SNAPSHOT_LIMIT = 200 * 1024 * 1024;
const CHUNK = 512 * 1024;
const RETRIES = 3;

class Changed extends Error {}

const same = (a, b) => a.size === b.size && a.lastModified === b.lastModified;

async function statOrNull(area, path) {
  try {
    const info = await call('stat', { area, path });
    return info.kind === 'file' ? info : null;
  } catch {
    return null;
  }
}

// Every part must come from the file the stat saw.
async function readFile(area, path, info, onChunk) {
  const bytes = new Uint8Array(info.size);
  let offset = 0;
  while (offset < info.size) {
    const part = await call('read', { area, path, offset, length: CHUNK });
    if (!same(part, info)) throw new Changed();
    const chunk = fromBase64(part.data);
    if (chunk.length === 0) throw new Changed();
    bytes.set(chunk, offset);
    offset += chunk.length;
    onChunk(chunk.length);
  }
  return bytes;
}

// onProgress(done, total) is told the bytes copied so far.
export async function takeSnapshot(area, path, { onProgress = () => {} } = {}) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const info = await call('stat', { area, path });
    const walInfo = await statOrNull(area, `${path}-wal`);
    const total = info.size + (walInfo ? walInfo.size : 0);
    if (total > SNAPSHOT_LIMIT) throw new Error('Too large to open here (over 200 MB). Download it instead.');
    let done = 0;
    const onChunk = (n) => onProgress((done += n), total);
    try {
      const takenAt = Date.now();
      const db = await readFile(area, path, info, onChunk);
      const wal = walInfo ? await readFile(area, `${path}-wal`, walInfo, onChunk) : null;
      // A checkpoint while the -wal file was read changes the database.
      if (wal && !same(await call('stat', { area, path }), info)) throw new Changed();
      return { db: applyWal(db, wal), takenAt, walApplied: !!wal && wal.length > 0 };
    } catch (error) {
      if (!(error instanceof Changed)) throw error;
    }
  }
  throw new Error('The database kept changing while it was copied. Try Reload snapshot.');
}
