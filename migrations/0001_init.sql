-- Reference schema. The API also creates these tables automatically on first use.

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  goal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('add','withdraw','transfer')),
  cat TEXT NOT NULL REFERENCES categories(id),
  to_cat TEXT REFERENCES categories(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT NOT NULL DEFAULT '',
  t INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tx_t ON transactions (t, seq);
