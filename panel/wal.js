// Replays a SQLite -wal file into a copy of the database bytes.
// Format: https://www.sqlite.org/fileformat2.html#walformat

const HEADER = 32;
const FRAME_HEADER = 24;

// SQLite's running checksum over 32-bit words, two at a time.
function checksum(view, start, end, bigEndian, s0, s1) {
  for (let i = start; i < end; i += 8) {
    s0 = (s0 + view.getUint32(i, !bigEndian) + s1) >>> 0;
    s1 = (s1 + view.getUint32(i + 4, !bigEndian) + s0) >>> 0;
  }
  return [s0, s1];
}

// Bytes 18 and 19 set to 1 mean the file is not in WAL mode.
function notWal(bytes) {
  if (bytes.length > 19) bytes[18] = bytes[19] = 1;
  return bytes;
}

// The committed pages of wal applied to db. Neither input is changed.
export function applyWal(db, wal) {
  if (!wal || wal.length < HEADER) return notWal(db.slice());
  const view = new DataView(wal.buffer, wal.byteOffset, wal.byteLength);
  const magic = view.getUint32(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return notWal(db.slice());
  const bigEndian = magic === 0x377f0683;
  const pageSize = view.getUint32(8);
  const salt1 = view.getUint32(16);
  const salt2 = view.getUint32(20);
  let sum = checksum(view, 0, 24, bigEndian, 0, 0);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) || sum[0] !== view.getUint32(24) || sum[1] !== view.getUint32(28)) {
    return notWal(db.slice());
  }
  // Find the last valid commit frame.
  const frameSize = FRAME_HEADER + pageSize;
  const frames = [];
  let committed = 0;
  let pages = 0;
  for (let at = HEADER; at + frameSize <= wal.length; at += frameSize) {
    if (view.getUint32(at + 8) !== salt1 || view.getUint32(at + 12) !== salt2) break;
    sum = checksum(view, at, at + 8, bigEndian, sum[0], sum[1]);
    sum = checksum(view, at + FRAME_HEADER, at + frameSize, bigEndian, sum[0], sum[1]);
    if (sum[0] !== view.getUint32(at + 16) || sum[1] !== view.getUint32(at + 20)) break;
    frames.push(at);
    const size = view.getUint32(at + 4);
    if (size !== 0) {
      committed = frames.length;
      pages = size;
    }
  }
  if (!committed) return notWal(db.slice());
  const out = new Uint8Array(pages * pageSize);
  out.set(db.subarray(0, out.length));
  for (const at of frames.slice(0, committed)) {
    const page = view.getUint32(at);
    if (page >= 1 && page <= pages) out.set(wal.subarray(at + FRAME_HEADER, at + frameSize), (page - 1) * pageSize);
  }
  return notWal(out);
}
