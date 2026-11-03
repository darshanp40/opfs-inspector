// The SQLite worker. It holds one in-memory copy of a database, read-only.
// Started by the panel the first time a database opens.
import initSqlJs from 'sql.js';

const MAX_ROWS = 1000;

// The wasm ships with the extension, next to this file.
const ready = fetch(new URL('sql-wasm.wasm', import.meta.url))
  .then((r) => r.arrayBuffer())
  .then((wasmBinary) => initSqlJs({ wasmBinary }));
let db = null;

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

// Steps a prepared statement into {columns, rows, truncated}.
function collect(stmt, max) {
  const columns = stmt.getColumnNames();
  const rows = [];
  let truncated = false;
  while (stmt.step()) {
    if (rows.length === max) {
      truncated = true;
      break;
    }
    // Integers come as BigInt, so 64-bit values are not rounded.
    rows.push(stmt.get(null, { useBigInt: true }));
  }
  return { columns, rows, truncated };
}

function select(sql, params, max = MAX_ROWS) {
  const stmt = db.prepare(sql, params);
  try {
    return collect(stmt, max);
  } finally {
    stmt.free();
  }
}

const handlers = {
  async open({ bytes }) {
    const SQL = await ready;
    if (db) db.close();
    db = null;
    db = new SQL.Database(bytes);
    db.exec('PRAGMA query_only = ON');
    return null;
  },
  tables() {
    return select("select name, type from sqlite_schema where type in ('table', 'view') and name not like 'sqlite_%' order by name").rows
      .map(([name, type]) => ({ name, type }));
  },
  rows({ table, offset, limit = 100 }) {
    const types = select(`PRAGMA table_info(${quote(table)})`).rows.map((r) => r[2]);
    const total = Number(select(`select count(*) from ${quote(table)}`).rows[0][0]);
    const page = select(`select * from ${quote(table)} limit ? offset ?`, [Math.min(limit, MAX_ROWS), offset]);
    return { ...page, types, total };
  },
  query({ sql }) {
    // Turning query_only off is the one way to write, even to this copy.
    if (/\bquery_only\b/i.test(sql)) throw new Error('This viewer is read-only.');
    const statements = db.iterateStatements(sql);
    const first = statements.next().value;
    if (!first) throw new Error('There is no statement to run.');
    try {
      // Anything after the first statement but comments and semicolons is a second one.
      const rest = statements.getRemainingSQL().replace(/--[^\n]*|\/\*[\s\S]*?(\*\/|$)/g, '').replace(/[\s;]/g, '');
      if (rest) throw new Error('Run one statement at a time.');
      return collect(first, MAX_ROWS);
    } finally {
      first.free();
    }
  },
};

self.onmessage = async ({ data: { id, type, ...args } }) => {
  try {
    if (type !== 'open' && !db) throw new Error('No database is open.');
    const value = await handlers[type](args);
    self.postMessage({ id, ok: true, value });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || String(error) });
  }
};
