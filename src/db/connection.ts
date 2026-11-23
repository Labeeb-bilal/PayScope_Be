import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { COUNTRIES } from './reference-data';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS countries (
  code      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  currency  TEXT NOT NULL,
  usd_rate  REAL NOT NULL CHECK (usd_rate > 0)
);

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_code TEXT NOT NULL UNIQUE,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  job_title     TEXT NOT NULL,
  level         TEXT NOT NULL,
  department    TEXT NOT NULL,
  country_code  TEXT NOT NULL REFERENCES countries(code),
  salary        INTEGER NOT NULL CHECK (salary > 0),
  currency      TEXT NOT NULL,
  hire_date     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_employees_country    ON employees(country_code);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
CREATE INDEX IF NOT EXISTS idx_employees_peer       ON employees(job_title, level, country_code);
CREATE INDEX IF NOT EXISTS idx_employees_name       ON employees(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_employees_first_name ON employees(first_name);

CREATE TABLE IF NOT EXISTS salary_changes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id      INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  previous_salary  INTEGER,
  new_salary       INTEGER NOT NULL CHECK (new_salary > 0),
  currency         TEXT NOT NULL,
  effective_date   TEXT NOT NULL,
  reason           TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_salary_changes_employee ON salary_changes(employee_id, effective_date);
`;

/** Opens (or creates) a database, applies schema and reference data. Use ':memory:' in tests. */
export function openDb(filename = ':memory:'): DB {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const upsert = db.prepare(
    `INSERT INTO countries (code, name, currency, usd_rate) VALUES (@code, @name, @currency, @usdRate)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, currency = excluded.currency, usd_rate = excluded.usd_rate`,
  );
  db.transaction(() => COUNTRIES.forEach((c) => upsert.run(c)))();
  return db;
}
