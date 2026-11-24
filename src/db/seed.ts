import { salaryUsdSql, withoutSearchTriggers, type DB } from './connection';
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

/**
 * Name pools per culture, so a seeded person gets a first name and surname that belong together
 * (no "Kenji Patel"). Names are plain ASCII where the culture allows it; emails are ASCII-folded anyway.
 */
interface NamePool {
  first: readonly string[];
  last: readonly string[];
}

const ENGLISH: NamePool = {
  first: [
    'James', 'Oliver', 'William', 'Harry', 'George', 'Thomas', 'Jack', 'Daniel', 'Matthew', 'Samuel', 'Benjamin', 'Henry',
    'Michael', 'David', 'Andrew', 'Christopher', 'Emily', 'Olivia', 'Charlotte', 'Amelia', 'Sophie', 'Grace', 'Hannah',
    'Jessica', 'Emma', 'Lucy', 'Sarah', 'Rebecca', 'Elizabeth', 'Katherine', 'Laura', 'Megan',
  ],
  last: [
    'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Taylor', 'Wilson', 'Davies', 'Evans', 'Thomas', 'Roberts', 'Walker',
    'Wright', 'Robinson', 'Thompson', 'White', 'Hughes', 'Edwards', 'Green', 'Hall', 'Wood', 'Harris', 'Clarke', 'Jackson',
    'Turner', 'Hill', 'Cooper', 'Ward', 'Morris', 'Baker', 'Mitchell', 'Campbell',
  ],
};

const INDIAN: NamePool = {
  first: [
    'Aarav', 'Arjun', 'Rohan', 'Rahul', 'Vikram', 'Aditya', 'Karan', 'Ishaan', 'Kabir', 'Siddharth', 'Amit', 'Rajesh',
    'Sanjay', 'Vivek', 'Ankit', 'Nikhil', 'Priya', 'Ananya', 'Diya', 'Kavya', 'Pooja', 'Neha', 'Sneha', 'Aishwarya',
    'Riya', 'Shreya', 'Meera', 'Divya', 'Anjali', 'Sunita', 'Kiran', 'Nisha',
  ],
  last: [
    'Sharma', 'Verma', 'Gupta', 'Singh', 'Kumar', 'Patel', 'Mehta', 'Joshi', 'Agarwal', 'Chauhan', 'Yadav', 'Mishra',
    'Pandey', 'Tiwari', 'Srivastava', 'Saxena', 'Malhotra', 'Kapoor', 'Chopra', 'Bhatia', 'Iyer', 'Nair', 'Reddy', 'Rao',
    'Menon', 'Desai', 'Shah', 'Banerjee', 'Chatterjee', 'Das', 'Kulkarni', 'Jain',
  ],
};

const GERMAN: NamePool = {
  first: [
    'Lukas', 'Leon', 'Felix', 'Jonas', 'Maximilian', 'Paul', 'Finn', 'Niklas', 'Tobias', 'Florian', 'Stefan', 'Matthias',
    'Jan', 'Moritz', 'Sebastian', 'Markus', 'Anna', 'Lena', 'Laura', 'Lea', 'Hannah', 'Sophie', 'Julia', 'Katharina',
    'Johanna', 'Clara', 'Marie', 'Sarah', 'Lisa', 'Miriam', 'Franziska', 'Sabine',
  ],
  last: [
    'Mueller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Koch',
    'Richter', 'Klein', 'Wolf', 'Schroeder', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krueger', 'Hofmann', 'Hartmann',
    'Lange', 'Schmitt', 'Werner', 'Krause', 'Meier', 'Lehmann', 'Huber', 'Kaiser',
  ],
};

const JAPANESE: NamePool = {
  first: [
    'Haruto', 'Yuto', 'Sota', 'Riku', 'Kaito', 'Takumi', 'Kenji', 'Hiroshi', 'Daiki', 'Ren', 'Shota', 'Kenta', 'Takeshi',
    'Ryota', 'Yui', 'Hina', 'Sakura', 'Aoi', 'Yuna', 'Mei', 'Haruka', 'Misaki', 'Nanami', 'Yuki', 'Ayaka', 'Rin', 'Emi',
    'Naoko', 'Keiko', 'Mio',
  ],
  last: [
    'Sato', 'Suzuki', 'Takahashi', 'Tanaka', 'Watanabe', 'Ito', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Kato', 'Yoshida',
    'Yamada', 'Sasaki', 'Yamaguchi', 'Matsumoto', 'Inoue', 'Kimura', 'Hayashi', 'Shimizu', 'Yamazaki', 'Mori', 'Ikeda',
    'Hashimoto', 'Abe', 'Ishikawa', 'Ogawa', 'Fujita', 'Okada', 'Goto', 'Hasegawa',
  ],
};

const BRAZILIAN: NamePool = {
  first: [
    'Joao', 'Pedro', 'Lucas', 'Gabriel', 'Matheus', 'Rafael', 'Gustavo', 'Felipe', 'Bruno', 'Thiago', 'Rodrigo', 'Diego',
    'Leonardo', 'Eduardo', 'Ricardo', 'Marcelo', 'Ana', 'Maria', 'Beatriz', 'Juliana', 'Camila', 'Larissa', 'Fernanda',
    'Mariana', 'Leticia', 'Gabriela', 'Amanda', 'Carolina', 'Patricia', 'Isabela', 'Luiza', 'Bianca',
  ],
  last: [
    'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes', 'Costa',
    'Ribeiro', 'Martins', 'Carvalho', 'Almeida', 'Lopes', 'Soares', 'Fernandes', 'Vieira', 'Barbosa', 'Rocha', 'Dias',
    'Nascimento', 'Andrade', 'Moreira', 'Nunes', 'Marques', 'Machado', 'Mendes', 'Freitas',
  ],
};

const ARABIC: NamePool = {
  first: [
    'Mohammed', 'Ahmed', 'Omar', 'Khalid', 'Yousef', 'Hamad', 'Saeed', 'Abdullah', 'Rashid', 'Faisal', 'Hassan', 'Ali',
    'Tariq', 'Majid', 'Sultan', 'Ibrahim', 'Fatima', 'Aisha', 'Mariam', 'Noura', 'Layla', 'Sara', 'Hessa', 'Amna', 'Reem',
    'Shamma', 'Latifa', 'Maitha', 'Huda', 'Salma', 'Dana', 'Lina',
  ],
  last: [
    'Al-Mansoori', 'Al-Nuaimi', 'Al-Hashimi', 'Al-Mazrouei', 'Al-Shamsi', 'Al-Dhaheri', 'Al-Suwaidi', 'Al-Ketbi',
    'Al-Falasi', 'Al-Marri', 'Al-Zaabi', 'Al-Qasimi', 'Al-Hammadi', 'Al-Kaabi', 'Al-Muhairi', 'Al-Romaithi', 'Al-Blooshi',
    'Al-Ali', 'Haddad', 'Khoury', 'Nasser', 'Saleh', 'Mansour', 'Aziz', 'Rahman', 'Hamdan', 'Karim', 'Yousef',
  ],
};

const SINGAPOREAN: NamePool = {
  first: [
    'Wei Ming', 'Jun Hao', 'Zhi Hao', 'Jia Hui', 'Xin Yi', 'Hui Min', 'Li Ting', 'Kai Wen', 'Jun Jie', 'Wen Xuan', 'Shu Fen',
    'Mei Ling', 'Darren', 'Marcus', 'Ryan', 'Bryan', 'Gavin', 'Jasmine', 'Rachel', 'Cheryl', 'Felicia', 'Vanessa', 'Natalie',
    'Joanne', 'Elaine', 'Clement',
  ],
  last: [
    'Tan', 'Lim', 'Lee', 'Ng', 'Ong', 'Wong', 'Goh', 'Chua', 'Chan', 'Koh', 'Teo', 'Ang', 'Yeo', 'Tay', 'Ho', 'Low', 'Toh',
    'Sim', 'Chong', 'Chia', 'Seah', 'Foo', 'Leong', 'Quek', 'Heng', 'Pang',
  ],
};

/** Which naming culture each country's employees are drawn from. */
export const NAMES_BY_COUNTRY: Record<string, NamePool> = {
  US: ENGLISH, GB: ENGLISH, CA: ENGLISH, AU: ENGLISH,
  IN: INDIAN, DE: GERMAN, JP: JAPANESE, BR: BRAZILIAN, AE: ARABIC, SG: SINGAPOREAN,
};

/** "Wei Ming" + "Tan" + 42 -> "wei.ming.tan.42": lowercase ASCII letters/digits separated by dots. */
function emailLocalPart(firstName: string, lastName: string, n: number): string {
  return `${firstName} ${lastName} ${n}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('.');
}

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
    const names = NAMES_BY_COUNTRY[country.code]!;
    const firstName = pick(rng, names.first);
    const lastName = pick(rng, names.last);

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
      email: `${emailLocalPart(firstName, lastName, i)}@acme.example`,
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
                           country_code, salary, currency, salary_usd, hire_date)
    VALUES (@employeeCode, @firstName, @lastName, @email, @jobTitle, @level, @department,
            @countryCode, @salary, @currency, ${salaryUsdSql('@salary', '@countryCode')}, @hireDate)`);
  const insertChange = db.prepare(`
    INSERT INTO salary_changes (employee_id, previous_salary, new_salary, currency, effective_date, reason)
    VALUES (?, ?, ?, ?, ?, ?)`);

  db.transaction(() => withoutSearchTriggers(db, () => {
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
  }))();
  return employees.length;
}
