import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { COUNTRIES } from './reference-data';

export type DB = Database.Database;

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
CREATE INDEX IF NOT EXISTS idx_employees_department_usd ON employees(department, salary_usd);
CREATE INDEX IF NOT EXISTS idx_employees_level_usd      ON employees(level, salary_usd);
CREATE INDEX IF NOT EXISTS idx_employees_peer_salary    ON employees(job_title, level, country_code, salary);
CREATE INDEX IF NOT EXISTS idx_employees_name       ON employees(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_employees_salary_usd ON employees(salary_usd);
CREATE INDEX IF NOT EXISTS idx_employees_country_salary ON employees(country_code, salary);

CREATE INDEX IF NOT EXISTS idx_salary_changes_employee ON salary_changes(employee_id, effective_date);
`;

const FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS employees_fts USING fts5(
  first_name, last_name, email, employee_code,
  content = 'employees', content_rowid = 'id'
);`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS employees_fts_insert AFTER INSERT ON employees BEGIN
  INSERT INTO employees_fts (rowid, first_name, last_name, email, employee_code)
  VALUES (new.id, new.first_name, new.last_name, new.email, new.employee_code);
END;

CREATE TRIGGER IF NOT EXISTS employees_fts_delete AFTER DELETE ON employees BEGIN
  INSERT INTO employees_fts (employees_fts, rowid, first_name, last_name, email, employee_code)
  VALUES ('delete', old.id, old.first_name, old.last_name, old.email, old.employee_code);
END;

CREATE TRIGGER IF NOT EXISTS employees_fts_update AFTER UPDATE OF first_name, last_name, email, employee_code ON employees BEGIN
  INSERT INTO employees_fts (employees_fts, rowid, first_name, last_name, email, employee_code)
  VALUES ('delete', old.id, old.first_name, old.last_name, old.email, old.employee_code);
  INSERT INTO employees_fts (rowid, first_name, last_name, email, employee_code)
  VALUES (new.id, new.first_name, new.last_name, new.email, new.employee_code);
END;
`;

export function withoutSearchTriggers(db: DB, load: () => void): void {
  if (!db.inTransaction) throw new Error('withoutSearchTriggers must run inside a transaction');
  db.exec('DROP TRIGGER employees_fts_insert; DROP TRIGGER employees_fts_delete; DROP TRIGGER employees_fts_update;');
  load();
  db.exec("INSERT INTO employees_fts (employees_fts) VALUES ('rebuild')");
  db.exec(FTS_TRIGGERS);
}

export function salaryUsdSql(salaryExpr: string, countryCodeExpr: string): string {
  return `(SELECT CAST(ROUND(${salaryExpr} / usd_rate) AS INTEGER) FROM countries WHERE code = ${countryCodeExpr})`;
}

const SALARY_USD_OF_ROW = salaryUsdSql('employees.salary', 'employees.country_code');

export function recomputeSalaryUsd(db: DB, countryCode?: string): number {
  const scope = countryCode ? 'AND country_code = @countryCode' : '';
  return db
    .prepare(`UPDATE employees SET salary_usd = ${SALARY_USD_OF_ROW}
              WHERE salary_usd IS NOT ${SALARY_USD_OF_ROW} ${scope}`)
    .run(countryCode ? { countryCode } : {}).changes;
}

function tableExists(db: DB, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function hasColumn(db: DB, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
}

function migrate(db: DB): void {
  if (!hasColumn(db, 'employees', 'salary_usd')) {
    db.exec('ALTER TABLE employees ADD COLUMN salary_usd INTEGER NOT NULL DEFAULT 0');
  }
  if (!tableExists(db, 'employees_fts')) {
    db.exec(FTS_TABLE);
    db.exec("INSERT INTO employees_fts (employees_fts) VALUES ('rebuild')");
  }
  db.exec(FTS_TRIGGERS);
  db.exec('DROP INDEX IF EXISTS idx_employees_first_name');
  db.exec('DROP INDEX IF EXISTS idx_employees_department; DROP INDEX IF EXISTS idx_employees_peer;');
}

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
    recomputeSalaryUsd(db);
    db.exec(INDEXES);
  })();
  return db;
}
