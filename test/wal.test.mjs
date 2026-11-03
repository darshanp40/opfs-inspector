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
