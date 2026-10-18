// D1 storage. Tables are created on first use, so a fresh database needs no manual step.
// The same schema lives in migrations/0001_init.sql for reference.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS categories (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     color TEXT NOT NULL,
     goal INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     archived_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS transactions (
     id TEXT PRIMARY KEY,
     seq INTEGER NOT NULL,
     type TEXT NOT NULL CHECK (type IN ('add','withdraw','transfer')),
     cat TEXT NOT NULL REFERENCES categories(id),
     to_cat TEXT REFERENCES categories(id),
     amount INTEGER NOT NULL CHECK (amount > 0),
     note TEXT NOT NULL DEFAULT '',
     t INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS tx_t ON transactions (t, seq)`,
];

// columns added after the first release, for databases created before them
const ADDED = [['categories', 'archived_at', 'INTEGER']];

let ready = null;
export function ensureSchema(db) {
  ready ??= (async () => {
    await db.batch(SCHEMA.map(s => db.prepare(s)));
    for (const [table, col, type] of ADDED) {
      const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
      if (!results.some(r => r.name === col)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

const rowToTx = r => ({ id: r.id, seq: r.seq, type: r.type, cat: r.cat, to: r.to_cat, amount: r.amount, note: r.note, t: r.t });

export async function getState(db) {
  const [cats, txs] = await db.batch([
    db.prepare('SELECT id, name, color, goal, archived_at AS archived FROM categories ORDER BY created_at, id'),
    db.prepare('SELECT * FROM transactions ORDER BY t, seq'),
  ]);
  return { categories: cats.results, transactions: txs.results.map(rowToTx) };
}

export async function categoryIds(db, ids) {
  const uniq = [...new Set(ids)];
  const { results } = await db.prepare(`SELECT id FROM categories WHERE id IN (${uniq.map(() => '?').join(',')})`).bind(...uniq).all();
  return new Set(results.map(r => r.id));
}

// Idempotent: replaying the same id (e.g. an offline retry) is a no-op.
export async function insertTransaction(db, tx, now = Date.now()) {
  const r = await db.prepare(
    `INSERT OR IGNORE INTO transactions (id, seq, type, cat, to_cat, amount, note, t, created_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM transactions), ?, ?, ?, ?, ?, ?, ?)`)
    .bind(tx.id, tx.type, tx.cat, tx.to, tx.amount, tx.note, tx.t, now).run();
  return r.meta.changes > 0;
}

export async function deleteTransaction(db, id) {
  const r = await db.prepare('DELETE FROM transactions WHERE id = ?').bind(id).run();
  return r.meta.changes > 0;
}

export async function insertCategory(db, c, now = Date.now()) {
  const r = await db.prepare('INSERT OR IGNORE INTO categories (id, name, color, goal, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(c.id, c.name, c.color, c.goal, now).run();
  return r.meta.changes > 0;
}

const COLUMN = { name: 'name', color: 'color', goal: 'goal', archived: 'archived_at' };

export async function updateCategory(db, id, fields) {
  const keys = Object.keys(fields); // already whitelisted by validateCategory
  const r = await db.prepare(`UPDATE categories SET ${keys.map(k => `${COLUMN[k]} = ?`).join(', ')} WHERE id = ?`)
    .bind(...keys.map(k => fields[k]), id).run();
  return r.meta.changes > 0;
}

// An active category can only be deleted while it has no history. An archived one is deleted with its history,
// as long as it holds no money: moves between it and other categories become deposits to or withdrawals from
// those categories, so their balances stay the same. Mirrors dropCategory() in public/js/ledger.js.
export async function deleteCategory(db, id) {
  const c = await db.prepare('SELECT name, archived_at FROM categories WHERE id = ?').bind(id).first();
  if (!c) return 'missing';
  if (c.archived_at == null) {
    const used = await db.prepare('SELECT 1 FROM transactions WHERE cat = ? OR to_cat = ? LIMIT 1').bind(id, id).first();
    if (used) return 'in-use';
  } else {
    const { b } = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN to_cat = ? THEN amount WHEN type = 'add' THEN amount ELSE -amount END), 0) AS b
      FROM transactions WHERE cat = ? OR to_cat = ?`).bind(id, id, id).first();
    if (b !== 0) return 'not-empty';
  }
  const note = `CASE WHEN note = '' THEN ? ELSE substr(note || ' · ' || ?, 1, 200) END`;
  const [, , , r] = await db.batch([
    db.prepare(`UPDATE transactions SET type = 'add', cat = to_cat, to_cat = NULL, note = ${note} WHERE cat = ? AND type = 'transfer'`)
      .bind(`From ${c.name}`, `from ${c.name}`, id),
    db.prepare(`UPDATE transactions SET type = 'withdraw', to_cat = NULL, note = ${note} WHERE to_cat = ?`)
      .bind(`To ${c.name}`, `to ${c.name}`, id),
    db.prepare('DELETE FROM transactions WHERE cat = ?').bind(id),
    db.prepare('DELETE FROM categories WHERE id = ?').bind(id),
  ]);
  return r.meta.changes > 0 ? 'deleted' : 'missing';
}
