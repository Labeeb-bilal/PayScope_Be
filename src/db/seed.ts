import type { DB } from './connection';
import { COUNTRIES, DEPARTMENTS, LEVELS, type Level } from './reference-data';

/** Small, fast, deterministic PRNG (mulberry32). Same seed → same data everywhere. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function weighted<T>(rng: () => number, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r < 0) return value;
  }
  return entries[entries.length - 1]![0];
}

const FIRST_NAMES = [
  'Aarav', 'Aisha', 'Akira', 'Alex', 'Amelia', 'Ana', 'Arjun', 'Ava', 'Ben', 'Camila', 'Chloe', 'Daniel',
  'David', 'Diya', 'Elena', 'Emma', 'Ethan', 'Fatima', 'Felix', 'Gabriel', 'Hana', 'Hannah', 'Isabella', 'Ishaan',
  'James', 'Jia', 'Julia', 'Kabir', 'Kenji', 'Laila', 'Leo', 'Liam', 'Lucas', 'Maya', 'Mei', 'Mia',
  'Mohammed', 'Noah', 'Olivia', 'Omar', 'Priya', 'Rahul', 'Rohan', 'Sakura', 'Samuel', 'Sara', 'Sofia', 'Thomas',
  'Wei', 'Yusuf', 'Zara', 'Zoe', 'Ananya', 'Carlos', 'Hiro', 'Layla', 'Lena', 'Marco', 'Nina', 'Ravi',
];

const LAST_NAMES = [
  'Ahmed', 'Ali', 'Anderson', 'Brown', 'Chen', 'Costa', 'Das', 'Davis', 'Fernandes', 'Fischer', 'Garcia', 'Gupta',
  'Hassan', 'Ito', 'Iyer', 'Johnson', 'Khan', 'Kim', 'Kumar', 'Lee', 'Lopez', 'Martin', 'Meyer', 'Miller',
  'Nair', 'Nakamura', 'Nguyen', 'Patel', 'Reddy', 'Rodriguez', 'Rossi', 'Santos', 'Schmidt', 'Shah', 'Silva', 'Singh',
  'Smith', 'Suzuki', 'Tanaka', 'Taylor', 'Thomas', 'Wagner', 'Walker', 'Wang', 'Williams', 'Wilson', 'Wong', 'Zhang',
];

/** Headcount weight and pay level relative to the US market. */
const COUNTRY_PROFILE: Record<string, { weight: number; marketFactor: number }> = {
  US: { weight: 25, marketFactor: 1.0 },
  IN: { weight: 25, marketFactor: 0.22 },
  GB: { weight: 10, marketFactor: 0.75 },
  DE: { weight: 8, marketFactor: 0.8 },
  CA: { weight: 6, marketFactor: 0.8 },
  AE: { weight: 6, marketFactor: 0.7 },
  SG: { weight: 5, marketFactor: 0.75 },
  AU: { weight: 5, marketFactor: 0.8 },
  JP: { weight: 5, marketFactor: 0.6 },
  BR: { weight: 5, marketFactor: 0.3 },
};

const DEPARTMENT_WEIGHTS: Record<string, number> = {
  Engineering: 30, Product: 7, Sales: 15, Marketing: 8, 'Customer Success': 15, Finance: 6, 'People & HR': 6, Operations: 13,
};

const LEVEL_WEIGHTS: Record<Level, number> = { L1: 30, L2: 30, L3: 22, L4: 12, L5: 6 };
const LEVEL_MULTIPLIER: Record<Level, number> = { L1: 1, L2: 1.3, L3: 1.65, L4: 2.05, L5: 2.6 };

/** Share of employees deliberately paid well below peers, so pay-equity flags have something real to find. */
const UNDERPAID_SHARE = 0.03;

export interface SeedEmployee {
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  level: Level;
  department: string;
  countryCode: string;
  currency: string;
  salary: number;
  hireDate: string;
  /** Salary before the most recent raise, if any (for seeded history). */
  previousSalary: number | null;
  lastRaiseDate: string | null;
}

/** Rounds to a "human" number in the local currency: 100 for USD-like, 1,000 for INR, 10,000 for JPY. */
export function roundSalary(amount: number, usdRate: number): number {
  const unit = 100 * Math.max(1, 10 ** Math.floor(Math.log10(usdRate)));
  return Math.max(unit, Math.round(amount / unit) * unit);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Pure generator: no DB access, fully deterministic for a given (count, seed). */
export function generateEmployees(count: number, seed = 42): SeedEmployee[] {
  const rng = createRng(seed);
  const countryEntries = COUNTRIES.map((c) => [c, COUNTRY_PROFILE[c.code]!.weight] as const);
  const deptEntries = Object.entries(DEPARTMENT_WEIGHTS);
  const levelEntries = LEVELS.map((l) => [l, LEVEL_WEIGHTS[l]] as const);
  const referenceDate = Date.UTC(2026, 0, 1);
  const tenYearsMs = 10 * 365 * 24 * 3600 * 1000;

  const employees: SeedEmployee[] = [];
  for (let i = 1; i <= count; i++) {
    const country = weighted(rng, countryEntries);
    const department = weighted(rng, deptEntries);
    const titles = DEPARTMENTS[department]!;
    const jobTitle = pick(rng, Object.keys(titles));
    const level = weighted(rng, levelEntries);
    const firstName = pick(rng, FIRST_NAMES);
    const lastName = pick(rng, LAST_NAMES);

    const usdBase = titles[jobTitle]! * LEVEL_MULTIPLIER[level] * COUNTRY_PROFILE[country.code]!.marketFactor;
    const noise = 0.85 + rng() * 0.3; // ±15% spread within a peer group
    const underpaid = rng() < UNDERPAID_SHARE ? 0.65 : 1;
    const salary = roundSalary(usdBase * noise * underpaid * country.usdRate, country.usdRate);

    const hireDate = new Date(referenceDate - Math.floor(rng() * tenYearsMs));
    const hadRaise = rng() < 0.6 && referenceDate - hireDate.getTime() > 365 * 24 * 3600 * 1000;
    const raisePct = 0.03 + rng() * 0.09;
    const lastRaiseDate = hadRaise ? isoDate(new Date(referenceDate - Math.floor(rng() * 300) * 24 * 3600 * 1000)) : null;

    employees.push({
      employeeCode: `ACME-${String(i).padStart(5, '0')}`,
      firstName,
      lastName,
      email: `${firstName}.${lastName}.${i}@acme.example`.toLowerCase(),
      jobTitle,
      level,
      department,
      countryCode: country.code,
      currency: country.currency,
      salary,
      hireDate: isoDate(hireDate),
      previousSalary: hadRaise ? roundSalary(salary / (1 + raisePct), country.usdRate) : null,
      lastRaiseDate,
    });
  }
  return employees;
}

/** Wipes employee data and inserts a deterministic dataset in one transaction. */
export function seedDatabase(db: DB, count = 10_000, seed = 42): number {
  const employees = generateEmployees(count, seed);
  const insertEmployee = db.prepare(`
    INSERT INTO employees (employee_code, first_name, last_name, email, job_title, level, department,
                           country_code, salary, currency, hire_date)
    VALUES (@employeeCode, @firstName, @lastName, @email, @jobTitle, @level, @department,
            @countryCode, @salary, @currency, @hireDate)`);
  const insertChange = db.prepare(`
    INSERT INTO salary_changes (employee_id, previous_salary, new_salary, currency, effective_date, reason)
    VALUES (?, ?, ?, ?, ?, ?)`);

  db.transaction(() => {
    db.exec('DELETE FROM salary_changes; DELETE FROM employees; DELETE FROM sqlite_sequence;');
    for (const e of employees) {
      const { lastInsertRowid } = insertEmployee.run(e);
      const id = Number(lastInsertRowid);
      if (e.previousSalary !== null && e.lastRaiseDate) {
        insertChange.run(id, null, e.previousSalary, e.currency, e.hireDate, 'Initial salary');
        insertChange.run(id, e.previousSalary, e.salary, e.currency, e.lastRaiseDate, 'Annual review');
      } else {
        insertChange.run(id, null, e.salary, e.currency, e.hireDate, 'Initial salary');
      }
    }
  })();
  return employees.length;
}
