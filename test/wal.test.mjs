// applyWal against WAL files written by SQLite itself (node:sqlite).
import { before, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyWal } from '../panel/wal.js';

let SQL;
let db; // the database file, with 3 rows
let wal; // two commits: 10 rows, then 5 more
let bigDb; // 3 rows
let bigWal; // 10 rows, then 2000 rows that span many pages

before(async () => {
  SQL = await initSqlJs();
  const dir = await mkdtemp(join(tmpdir(), 'wal-'));
  const file = join(dir, 'x.db');
  const live = new DatabaseSync(file);
  live.exec('create table t (n integer)');
  for (let i = 0; i < 3; i++) live.exec(`insert into t values (${i})`);
  live.exec('pragma journal_mode = wal; pragma wal_autocheckpoint = 0');
  live.exec(`begin; ${Array.from({ length: 10 }, (_, i) => `insert into t values (${i})`).join(';')}; commit`);
  live.exec(`begin; ${Array.from({ length: 5 }, (_, i) => `insert into t values (${i})`).join(';')}; commit`);
  // Copied while the writer is open, so nothing has been checkpointed.
  db = new Uint8Array(await readFile(file));
  wal = new Uint8Array(await readFile(`${file}-wal`));
  live.close();
  // A -wal file whose last commit has many frames.
  const other = join(dir, 'y.db');
  const big = new DatabaseSync(other);
  big.exec('create table t (n integer)');
  for (let i = 0; i < 3; i++) big.exec(`insert into t values (${i})`);
  big.exec('pragma journal_mode = wal; pragma wal_autocheckpoint = 0');
  big.exec(`begin; ${Array.from({ length: 10 }, (_, i) => `insert into t values (${i})`).join(';')}; commit`);
  big.exec(`begin; ${Array.from({ length: 2000 }, (_, i) => `insert into t values (${i})`).join(';')}; commit`);
  bigDb = new Uint8Array(await readFile(other));
  bigWal = new Uint8Array(await readFile(`${other}-wal`));
  big.close();
  await rm(dir, { recursive: true });
});

const count = (bytes) => {
  const d = new SQL.Database(bytes);
  try {
    return d.exec('select count(*) from t')[0].values[0][0];
  } finally {
    d.close();
  }
};

// Frame offsets, and whether each frame ends a commit.
function frames(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = 24 + view.getUint32(8);
  const list = [];
  for (let at = 32; at + size <= bytes.length; at += size) list.push({ at, commit: view.getUint32(at + 4) !== 0 });
  return { list, size };
}

it('applyWal brings in committed rows', () => {
  assert.equal(count(applyWal(db, wal)), 18);
});

it('an uncommitted tail is ignored', () => {
  assert.equal(count(applyWal(db, wal.subarray(0, wal.length - 100))), 13);
});

it('a WAL with wrong salts is ignored', () => {
  const bad = wal.slice();
  bad[32 + 8] ^= 0xff; // salt-1 of the first frame
  assert.equal(count(applyWal(db, bad)), 3);
});

it('bytes 18 and 19 are 1', () => {
  assert.equal(db[18], 2, 'the copy is in WAL mode');
  for (const out of [applyWal(db, wal), applyWal(db, new Uint8Array(0))]) assert.deepEqual([out[18], out[19]], [1, 1]);
  assert.equal(db[18], 2, 'the input is not changed');
});

it('a bad frame checksum stops the replay at that frame', () => {
  const { list } = frames(wal);
  const firstCommit = list.findIndex((f) => f.commit);
  assert.ok(firstCommit < list.length - 1, 'the second commit has frames');
  const bad = wal.slice();
  bad[list[firstCommit + 1].at + 16] ^= 0xff; // checksum-1 of the first frame of commit 2
  assert.equal(count(applyWal(db, bad)), 13);
});

it('a bad header checksum means the WAL is ignored', () => {
  const bad = wal.slice();
  bad[24] ^= 0xff;
  assert.equal(count(applyWal(db, bad)), 3);
});

it('valid frames after the last commit are ignored', () => {
  const { list, size } = frames(bigWal);
  const last = list[list.length - 1];
  assert.ok(last.commit && list.length > 3 && !list[list.length - 2].commit, 'the last commit has several frames');
  // Whole frames of commit 2, all valid, but not its commit frame.
  const tail = bigWal.subarray(0, last.at);
  assert.equal(tail.length % size, 32 % size);
  assert.equal(count(applyWal(bigDb, tail)), 13);
  assert.equal(count(applyWal(bigDb, bigWal)), 2013);
});
