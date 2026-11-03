// Copies a database file, and its -wal file when there is one, into memory.
// The live file is only read, never opened by SQLite.
//
// Writes through a sync access handle keep size and lastModified in Chromium,
// and with locking_mode=exclusive SQLite's change counter stays the same. So
// the files are read twice in a row, and the copy is kept only when both
// reads are the same, byte for byte. A hot -journal before or after means a
// commit is still writing pages, so the copy is taken again then too.
import { call } from './transport.js';
import { fromBase64 } from './format.js';
import { applyWal } from './wal.js';

export const SNAPSHOT_LIMIT = 200 * 1024 * 1024;
const CHUNK = 512 * 1024;
const RETRIES = 3;
const JOURNAL_MAGIC = '2dUF+SChY9c='; // d9 d5 05 f9 20 a1 63 d7

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

// A -journal that starts with the magic means a commit is writing pages.
async function hotJournal(area, path) {
  try {
    return (await call('read', { area, path: `${path}-journal`, offset: 0, length: 8 })).data === JOURNAL_MAGIC;
  } catch {
    return false;
  }
}

// Reads a whole file. With earlier, each part must match it instead.
// Every part must come from the file the stat saw.
async function readFile(area, path, info, onChunk, earlier = null) {
  if (!info || (earlier && earlier.length !== info.size)) throw new Changed();
  const bytes = earlier || new Uint8Array(info.size);
  let offset = 0;
  while (offset < info.size) {
    // A file deleted during the copy counts as a change.
    const part = await call('read', { area, path, offset, length: CHUNK }).catch(() => {
      throw new Changed();
    });
    if (!same(part, info)) throw new Changed();
    const chunk = fromBase64(part.data);
    if (chunk.length === 0) throw new Changed();
    if (earlier) {
      for (let i = 0; i < chunk.length; i++) if (chunk[i] !== earlier[offset + i]) throw new Changed();
    } else {
      bytes.set(chunk, offset);
    }
    offset += chunk.length;
    onChunk(chunk.length);
  }
  return bytes;
}

// onProgress(done, total) is told the bytes read so far, over both reads.
export async function takeSnapshot(area, path, { onProgress = () => {} } = {}) {
  const walPath = `${path}-wal`;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const info = await call('stat', { area, path });
    const walInfo = await statOrNull(area, walPath);
    const size = info.size + (walInfo ? walInfo.size : 0);
    if (size > SNAPSHOT_LIMIT) throw new Error('Too large to open here (over 200 MB). Download it instead.');
    let done = 0;
    const onChunk = (n) => onProgress((done += n), size * 2);
    try {
      const takenAt = Date.now();
      if (await hotJournal(area, path)) throw new Changed();
      const db = await readFile(area, path, info, onChunk);
      const wal = walInfo ? await readFile(area, walPath, walInfo, onChunk) : null;
      // The second read. A -wal file that appears or goes is a change.
      await readFile(area, path, await statOrNull(area, path), onChunk, db);
      const walNow = await statOrNull(area, walPath);
      if (!wal !== !walNow) throw new Changed();
      if (wal) await readFile(area, walPath, walNow, onChunk, wal);
      if (await hotJournal(area, path)) throw new Changed();
      return { db: applyWal(db, wal), takenAt, walApplied: !!wal && wal.length > 0 };
    } catch (error) {
      if (!(error instanceof Changed)) throw error;
    }
  }
  throw new Error('The database kept changing while it was copied. Try Reload snapshot.');
}
