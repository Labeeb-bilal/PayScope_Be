import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, recomputeSalaryUsd, type DB } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { listQuerySchema } from '../src/schemas';
import { createEmployeeService } from '../src/services/employee-service';
import { employeeInput, setup } from './helpers';

const IN_RATE = 83.5;
const GB_RATE = 0.79;

function storedUsd(db: DB, id: number): number {
  return (db.prepare('SELECT salary_usd AS v FROM employees WHERE id = ?').get(id) as { v: number }).v;
}

/** Rows where the cache disagrees with salary / current rate. Should always be 0. */
function staleRows(db: DB): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM employees e JOIN countries c ON c.code = e.country_code
                WHERE e.salary_usd <> CAST(ROUND(e.salary / c.usd_rate) AS INTEGER)`)
      .get() as { n: number }
  ).n;
}

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-usd-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'app.db');
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('salary_usd cache', () => {
  it('is set on create', () => {
    const { db, service } = setup();
    const e = service.create(employeeInput({ countryCode: 'IN', salary: 2_500_000 }));
    expect(storedUsd(db, e.id)).toBe(Math.round(2_500_000 / IN_RATE));
    expect(e.salaryUsd).toBe(storedUsd(db, e.id));
  });

  it('is updated by a salary change', () => {
    const { db, service } = setup();
    const e = service.create(employeeInput({ countryCode: 'GB', salary: 70_000, hireDate: '2022-01-01' }));
    const after = service.changeSalary(e.id, { newSalary: 80_000, effectiveDate: '2024-01-01', reason: 'Promotion' });
    expect(storedUsd(db, e.id)).toBe(Math.round(80_000 / GB_RATE));
    expect(after.salaryUsd).toBe(Math.round(80_000 / GB_RATE));
  });

  it('is updated by a relocation (new salary, new rate)', () => {
    const { db, service } = setup();
    const e = service.create(employeeInput({ countryCode: 'US', salary: 100_000 }));
    service.update(e.id, { countryCode: 'IN', salary: 5_000_000 });
    expect(storedUsd(db, e.id)).toBe(Math.round(5_000_000 / IN_RATE));
  });

  it('is not touched by edits that do not affect pay', () => {
    const { db, service } = setup();
    const e = service.create(employeeInput({ countryCode: 'IN', salary: 2_500_000 }));
    service.update(e.id, { jobTitle: 'Data Engineer' });
    expect(storedUsd(db, e.id)).toBe(Math.round(2_500_000 / IN_RATE));
  });

  it('is consistent for every seeded row', () => {
    const db = openDb(':memory:');
    seedDatabase(db, 500);
    expect(staleRows(db)).toBe(0);
  });

  it('recomputeSalaryUsd reflects a changed FX rate, scoped to one country', () => {
    const { db, service } = setup();
    const inEmp = service.create(employeeInput({ countryCode: 'IN', salary: 2_500_000 }));
    const usEmp = service.create(employeeInput({ countryCode: 'US', salary: 100_000 }));

    db.prepare("UPDATE countries SET usd_rate = 100 WHERE code = 'IN'").run();
    expect(staleRows(db)).toBe(1);

    expect(recomputeSalaryUsd(db, 'IN')).toBe(1);
    expect(storedUsd(db, inEmp.id)).toBe(25_000);
    expect(storedUsd(db, usEmp.id)).toBe(100_000);
    expect(recomputeSalaryUsd(db)).toBe(0); // nothing left to change
  });

  it('openDb recomputes, so reference-data rate changes reach existing rows', () => {
    const file = tempDbPath();
    const db = openDb(file);
    seedDatabase(db, 50);
    db.prepare('UPDATE employees SET salary_usd = 1').run(); // as if computed with an old rate
    db.close();

    const reopened = openDb(file);
    expect(staleRows(reopened)).toBe(0);
    reopened.close();
  });

  it('uses the column for USD sorting', () => {
    const { db, service } = setup();
    const a = service.create(employeeInput({ firstName: 'A', countryCode: 'US', salary: 50_000 }));
    service.create(employeeInput({ firstName: 'B', countryCode: 'US', salary: 60_000 }));
    // Make the cache say A earns most: the sort must follow salary_usd, proving the column (and its index) is used.
    db.prepare('UPDATE employees SET salary_usd = 999999 WHERE id = ?').run(a.id);
    const names = service.list(listQuerySchema.parse({ sort: 'salaryUsd', order: 'desc' })).items.map((e) => e.firstName);
    expect(names).toEqual(['A', 'B']);
  });
});

describe('migration from a pre-salary_usd, pre-FTS database file', () => {
  it('adds the column, backfills it and keeps all data', () => {
    const file = tempDbPath();
    const old = new Database(file);
    old.exec(`
      CREATE TABLE countries (code TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, usd_rate REAL NOT NULL);
      CREATE TABLE employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT, employee_code TEXT NOT NULL UNIQUE, first_name TEXT NOT NULL,
        last_name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, job_title TEXT NOT NULL, level TEXT NOT NULL,
        department TEXT NOT NULL, country_code TEXT NOT NULL REFERENCES countries(code), salary INTEGER NOT NULL,
        currency TEXT NOT NULL, hire_date TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE salary_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        previous_salary INTEGER, new_salary INTEGER NOT NULL, currency TEXT NOT NULL, effective_date TEXT NOT NULL,
        reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE INDEX idx_employees_first_name ON employees(first_name);
      INSERT INTO countries VALUES ('US', 'United States', 'USD', 1), ('IN', 'India', 'INR', 83.5);
      INSERT INTO employees (employee_code, first_name, last_name, email, job_title, level, department, country_code, salary, currency, hire_date)
      VALUES ('ACME-00001', 'Old', 'Timer', 'old@acme.example', 'Software Engineer', 'L3', 'Engineering', 'IN', 3000000, 'INR', '2019-01-01'),
             ('ACME-00002', 'Also', 'Old', 'also@acme.example', 'Recruiter', 'L1', 'People & HR', 'US', 60000, 'USD', '2020-01-01');
      INSERT INTO salary_changes (employee_id, previous_salary, new_salary, currency, effective_date, reason)
      VALUES (1, NULL, 3000000, 'INR', '2019-01-01', 'Initial salary');
    `);
    old.close();

    const db = openDb(file);
    const rows = db.prepare('SELECT employee_code AS code, salary, salary_usd AS usd FROM employees ORDER BY id').all();
    expect(rows).toEqual([
      { code: 'ACME-00001', salary: 3_000_000, usd: Math.round(3_000_000 / IN_RATE) },
      { code: 'ACME-00002', salary: 60_000, usd: 60_000 },
    ]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM salary_changes').get() as { n: number }).n).toBe(1);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain('idx_employees_salary_usd');
    expect(indexes).toContain('idx_employees_name');
    expect(indexes).not.toContain('idx_employees_first_name');
    // The full-text index is backfilled from the existing rows.
    const service = createEmployeeService(db);
    expect(service.list(listQuerySchema.parse({ search: 'old timer' })).items.map((e) => e.employeeCode)).toEqual(['ACME-00001']);
    expect(service.list(listQuerySchema.parse({ search: 'also@acme' })).total).toBe(1);
    db.close();

    // Re-opening an already migrated file is a no-op.
    const again = openDb(file);
    expect(staleRows(again)).toBe(0);
    again.close();
  });
});
