import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { COUNTRIES } from './reference-data';

export type DB = Database.Database;

/** Tables only. Indexes are created after migrations, because some indexed columns don't exist in older files yet. */
const TABLES = `
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
  -- Derived cache: ROUND(salary / countries.usd_rate). salary + currency stay the source of truth.
  -- Kept in sync on every salary/country write; rebuilt by recomputeSalaryUsd() on FX changes.
  salary_usd    INTEGER NOT NULL,
  hire_date     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

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
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_employees_country    ON employees(country_code);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
CREATE INDEX IF NOT EXISTS idx_employees_peer       ON employees(job_title, level, country_code);
CREATE INDEX IF NOT EXISTS idx_employees_name       ON employees(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_employees_first_name ON employees(first_name);
CREATE INDEX IF NOT EXISTS idx_employees_salary_usd ON employees(salary_usd);

CREATE INDEX IF NOT EXISTS idx_salary_changes_employee ON salary_changes(employee_id, effective_date);
`;

/**
 * SQL expression for the USD value of a salary: local salary / usd_rate of the given country, rounded.
 * Arguments are SQL expressions (column references or named parameters), never user input.
 */
export function salaryUsdSql(salaryExpr: string, countryCodeExpr: string): string {
  return `(SELECT CAST(ROUND(${salaryExpr} / usd_rate) AS INTEGER) FROM countries WHERE code = ${countryCodeExpr})`;
}

const SALARY_USD_OF_ROW = salaryUsdSql('employees.salary', 'employees.country_code');

/**
 * Rebuilds the salary_usd cache from salary and the current FX rates (all countries, or one).
 * Only rows whose value actually changes are written. Returns the number of rows updated.
 */
export function recomputeSalaryUsd(db: DB, countryCode?: string): number {
  const scope = countryCode ? 'AND country_code = @countryCode' : '';
  return db
    .prepare(`UPDATE employees SET salary_usd = ${SALARY_USD_OF_ROW}
              WHERE salary_usd IS NOT ${SALARY_USD_OF_ROW} ${scope}`)
    .run(countryCode ? { countryCode } : {}).changes;
}

function hasColumn(db: DB, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
}

/** Brings database files created by older versions up to the current schema, without losing data. */
function migrate(db: DB): void {
  if (!hasColumn(db, 'employees', 'salary_usd')) {
    // ADD COLUMN ... NOT NULL needs a default; the real values are backfilled by recomputeSalaryUsd() in openDb.
    db.exec('ALTER TABLE employees ADD COLUMN salary_usd INTEGER NOT NULL DEFAULT 0');
  }
}

/** Opens (or creates) a database, applies schema, migrations and reference data. Use ':memory:' in tests. */
export function openDb(filename = ':memory:'): DB {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.transaction(() => {
    db.exec(TABLES);
    migrate(db);
    const upsert = db.prepare(
      `INSERT INTO countries (code, name, currency, usd_rate) VALUES (@code, @name, @currency, @usdRate)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, currency = excluded.currency, usd_rate = excluded.usd_rate`,
    );
    COUNTRIES.forEach((c) => upsert.run(c));
    // Reflects any FX-rate change in reference data, and backfills salary_usd after the migration above.
    recomputeSalaryUsd(db);
    db.exec(INDEXES);
  })();
  return db;
}
