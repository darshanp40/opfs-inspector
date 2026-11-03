// Copies a database file, and its -wal file when there is one, into memory.
// The live file is only read, never opened by SQLite.
//
// Writes through a sync access handle keep size and lastModified in Chromium,
// so a copy is checked against what SQLite itself changes:
// - Rollback mode: every commit changes the database header (the change
//   counter), and a hot -journal exists while pages are written.
// - WAL mode: a checkpoint copies pages from the -wal file into the database,
//   and they stay in the -wal file until it starts again with a new header.
//   Replaying the -wal file repairs those pages.
// So the database header, the -wal header and the -journal state must be the
// same before and after the copy, or it is taken again.
import { call } from './transport.js';
import { fromBase64, toBase64 } from './format.js';
import { applyWal } from './wal.js';

export const SNAPSHOT_LIMIT = 200 * 1024 * 1024;
const CHUNK = 512 * 1024;
const RETRIES = 3;

class Changed extends Error {}

const same = (a, b) => a.size === b.size && a.lastModified === b.lastModified;
const JOURNAL_MAGIC = '2dUF+SChY9c='; // d9 d5 05 f9 20 a1 63 d7

// The first bytes of a file as base64, or null when it is missing.
async function head(area, path, length) {
  try {
    return (await call('read', { area, path, offset: 0, length })).data;
  } catch {
    return null;
  }
}

// A -journal that starts with the magic means a commit is writing pages.
const hotJournal = async (area, path) => (await head(area, `${path}-journal`, 8)) === JOURNAL_MAGIC;

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
      // Order matters: database header, -wal header, -journal, the copy,
      // then the same checks the other way round.
      const dbHead = await head(area, path, 100);
      const walHead = await head(area, `${path}-wal`, 32);
      if (await hotJournal(area, path)) throw new Changed();
      const db = await readFile(area, path, info, onChunk);
      const wal = walInfo ? await readFile(area, `${path}-wal`, walInfo, onChunk) : null;
      if (await hotJournal(area, path)) throw new Changed();
      if (await head(area, path, 100) !== dbHead || toBase64(db.subarray(0, 100)) !== dbHead) throw new Changed();
      if (await head(area, `${path}-wal`, 32) !== walHead || (wal && toBase64(wal.subarray(0, 32)) !== walHead)) throw new Changed();
      // A checkpoint while the -wal file was read changes the database.
      if (wal && !same(await call('stat', { area, path }), info)) throw new Changed();
      return { db: applyWal(db, wal), takenAt, walApplied: !!wal && wal.length > 0 };
    } catch (error) {
      if (!(error instanceof Changed)) throw error;
    }
  }
  throw new Error('The database kept changing while it was copied. Try Reload snapshot.');
}
