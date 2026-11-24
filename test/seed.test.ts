import { describe, expect, it } from 'vitest';
import { openDb, withoutSearchTriggers } from '../src/db/connection';
import { listQuerySchema } from '../src/schemas';
import { createEmployeeService } from '../src/services/employee-service';
import { employeeInput } from './helpers';
import { createRng, generateEmployees, NAMES_BY_COUNTRY, roundSalary, seedDatabase } from '../src/db/seed';
import { createEmployeeSchema } from '../src/schemas';
import { COUNTRIES, DEPARTMENTS, LEVELS } from '../src/db/reference-data';

describe('createRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng(7);
    const b = createRng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces values in [0, 1)', () => {
    const rng = createRng(1);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('roundSalary', () => {
  it('rounds to 100 for USD-like currencies', () => {
    expect(roundSalary(123_456, 1)).toBe(123_500);
  });
  it('rounds to 1,000 for INR and 10,000 for JPY', () => {
    expect(roundSalary(1_234_567, 83.5)).toBe(1_235_000);
    expect(roundSalary(12_345_678, 150)).toBe(12_350_000);
  });
  it('never returns zero', () => {
    expect(roundSalary(1, 1)).toBe(100);
  });
});

describe('generateEmployees', () => {
  it('is deterministic for a given seed', () => {
    expect(generateEmployees(50, 1)).toEqual(generateEmployees(50, 1));
    expect(generateEmployees(50, 1)).not.toEqual(generateEmployees(50, 2));
  });

  it('produces valid, unique employees', () => {
    const employees = generateEmployees(2000);
    const countryCodes = new Set(COUNTRIES.map((c) => c.code));
    expect(new Set(employees.map((e) => e.email)).size).toBe(2000);
    expect(new Set(employees.map((e) => e.employeeCode)).size).toBe(2000);
    for (const e of employees) {
      expect(countryCodes.has(e.countryCode)).toBe(true);
      expect(COUNTRIES.find((c) => c.code === e.countryCode)!.currency).toBe(e.currency);
      expect(Object.keys(DEPARTMENTS[e.department]!)).toContain(e.jobTitle);
      expect(LEVELS).toContain(e.level);
      expect(Number.isInteger(e.salary) && e.salary > 0).toBe(true);
      expect(e.hireDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('gives each person a first name and surname from their country\'s naming culture', () => {
    for (const c of COUNTRIES) expect(NAMES_BY_COUNTRY[c.code], c.code).toBeDefined();
    for (const e of generateEmployees(2000)) {
      const pool = NAMES_BY_COUNTRY[e.countryCode]!;
      expect(pool.first).toContain(e.firstName);
      expect(pool.last).toContain(e.lastName);
    }
  });

  it('builds emails that pass the API\'s own validation', () => {
    const email = createEmployeeSchema.shape.email;
    for (const e of generateEmployees(2000)) {
      expect(email.safeParse(e.email).success, e.email).toBe(true);
      expect(e.email).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)*@acme\.example$/);
    }
  });

  it('pays senior levels more than junior levels on average', () => {
    const us = generateEmployees(3000).filter((e) => e.countryCode === 'US');
    const avg = (level: string) => {
      const xs = us.filter((e) => e.level === level).map((e) => e.salary);
      return xs.reduce((a, b) => a + b, 0) / xs.length;
    };
    expect(avg('L5')).toBeGreaterThan(avg('L3'));
    expect(avg('L3')).toBeGreaterThan(avg('L1'));
  });
});

describe('seedDatabase', () => {
  it('inserts employees with a salary history and is re-runnable', () => {
    const db = openDb();
    seedDatabase(db, 300);
    seedDatabase(db, 300); // second run replaces, does not duplicate
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM employees').get() as { n: number };
    expect(n).toBe(300);

    const withoutHistory = db
      .prepare('SELECT COUNT(*) AS n FROM employees e WHERE NOT EXISTS (SELECT 1 FROM salary_changes s WHERE s.employee_id = e.id)')
      .get() as { n: number };
    expect(withoutHistory.n).toBe(0);

    // latest history entry always matches the current salary
    const mismatched = db
      .prepare(`SELECT COUNT(*) AS n FROM employees e
                WHERE e.salary != (SELECT new_salary FROM salary_changes s WHERE s.employee_id = e.id
                                   ORDER BY effective_date DESC, id DESC LIMIT 1)`)
      .get() as { n: number };
    expect(mismatched.n).toBe(0);
  });

  it('seeds 10,000 employees quickly', () => {
    const db = openDb();
    const start = Date.now();
    expect(seedDatabase(db, 10_000)).toBe(10_000);
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe('seedDatabase and the full-text index', () => {
  const ftsIntegrityCheck = (db: ReturnType<typeof openDb>) =>
    db.prepare("INSERT INTO employees_fts (employees_fts, rank) VALUES ('integrity-check', 1)").run();

  it('leaves the search index consistent with the table, also when re-seeding', () => {
    const db = openDb(':memory:');
    seedDatabase(db, 300);
    seedDatabase(db, 200, 7);
    expect(() => ftsIntegrityCheck(db)).not.toThrow();
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM employees_fts WHERE employees_fts MATCH 'acme*'").get() as { n: number };
    expect(n).toBe(200);
  });

  it('restores the sync triggers after a bulk load', () => {
    const db = openDb(':memory:');
    seedDatabase(db, 50);
    const triggers = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get() as { n: number };
    expect(triggers.n).toBe(3);
    const service = createEmployeeService(db);
    service.create(employeeInput({ firstName: 'Zebedee' }));
    expect(service.list(listQuerySchema.parse({ search: 'zebedee' })).total).toBe(1);
    expect(() => ftsIntegrityCheck(db)).not.toThrow();
  });

  it('refuses to drop the triggers outside a transaction', () => {
    const db = openDb(':memory:');
    expect(() => withoutSearchTriggers(db, () => {})).toThrow(/inside a transaction/);
  });
});
