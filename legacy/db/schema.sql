-- Quayside schema, v7 (2016). Do not reorder columns: the nightly export reads them by position.
CREATE TABLE IF NOT EXISTS ports (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  region TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lanes (
  origin TEXT NOT NULL,
  dest TEXT NOT NULL,
  container TEXT NOT NULL,
  base_cents INTEGER NOT NULL,
  PRIMARY KEY (origin, dest, container)
);
CREATE TABLE IF NOT EXISTS fuel (
  month TEXT PRIMARY KEY,
  pct REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'std',
  created TEXT
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  origin TEXT,
  dest TEXT,
  container TEXT,
  weight_kg INTEGER,
  hazardous INTEGER,
  depart TEXT,
  total REAL,
  breakdown TEXT,
  created_at TEXT,
  expires_at TEXT
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER,
  customer_id INTEGER,
  status TEXT,
  created_at TEXT,
  cancelled_at TEXT,
  fee REAL
);
