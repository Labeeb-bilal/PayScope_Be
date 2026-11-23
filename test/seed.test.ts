import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection';
import { createRng, generateEmployees, roundSalary, seedDatabase } from '../src/db/seed';
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
