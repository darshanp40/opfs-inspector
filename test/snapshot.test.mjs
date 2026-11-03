// takeSnapshot against fake files, for write orders a real browser can't be
// timed into. A rollback commit can spill pages to the database before it
// commits, so its -journal is hot from the spill to the end of the commit.
import { it } from 'node:test';
import assert from 'node:assert/strict';

const CHUNK = 512 * 1024;
const MAGIC = [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7];
let onCall = null;
globalThis.window = { opfsTransport: { call: (op, args) => onCall(op, args) } };
const { takeSnapshot } = await import('../panel/snapshot.js');

// The commit spills a page in part 3 while the first read is at part 0,
// then writes part 1 once the second read has passed it. Before the fix
// both reads matched and the copy was torn.
// exclusive: the change counter stays the same. journal: false is
// journal_mode=memory, so there is no -journal file.
async function spillThenCommit({ exclusive, journal }) {
  const files = new Map();
  const db = new Uint8Array(4 * CHUNK);
  db[24] = 7; // change counter
  files.set('app.db', db);
  let parts = 0;
  let probes = 0; // -journal looks after the spill
  let step = 0;
  const commit = () => {
    step = 2;
    if (!exclusive) db[24] = 8;
    db[CHUNK + 100] = 0xbb;
    files.delete('app.db-journal');
  };
  onCall = async (op, { path, offset = 0, length }) => {
    const file = files.get(path);
    if (!file) return { ok: false, error: 'It no longer exists.' };
    const value = op === 'stat'
      ? { kind: 'file', size: file.length, lastModified: 1 }
      : { size: file.length, lastModified: 1, offset, data: Buffer.from(file.subarray(offset, offset + length)).toString('base64') };
    // The writer moves on after the reader's call.
    if (op === 'read' && path === 'app.db' && length === CHUNK) {
      parts++;
      if (step === 0) {
        step = 1;
        if (journal) files.set('app.db-journal', Uint8Array.from([...MAGIC, 0, 0, 0, 1]));
        db[3 * CHUNK + 100] = 0xbb;
      } else if (step === 1 && parts === 6) commit();
    }
    if (step === 1 && path === 'app.db-journal' && ++probes === 2) commit();
    return { ok: true, value };
  };
  const { db: copy } = await takeSnapshot({ kind: 'default' }, 'app.db');
  assert.equal(step, 2, 'the commit happened');
  assert.deepEqual([copy[3 * CHUNK + 100], copy[CHUNK + 100]], [0xbb, 0xbb], 'not torn');
}

it('a spill then commit around both reads is copied again', () => spillThenCommit({ exclusive: false, journal: true }));

it('with exclusive locking, the -journal between the reads catches it', () => spillThenCommit({ exclusive: true, journal: true }));

it('with no -journal file, the change counter catches it', () => spillThenCommit({ exclusive: false, journal: false }));
