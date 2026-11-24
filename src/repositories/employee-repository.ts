import { salaryUsdSql, type DB } from '../db/connection';
import type { ListFilters, ListQuery } from '../schemas';

export interface EmployeeRow {
  id: number;
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  level: string;
  department: string;
  countryCode: string;
  countryName: string;
  salary: number;
  currency: string;
  salaryUsd: number;
  hireDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface SalaryChangeRow {
  id: number;
  employeeId: number;
  previousSalary: number | null;
  newSalary: number;
  currency: string;
  effectiveDate: string;
  reason: string;
  createdAt: string;
}

const SELECT_EMPLOYEE = `
  SELECT e.id, e.employee_code AS employeeCode, e.first_name AS firstName, e.last_name AS lastName, e.email,
         e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, c.name AS countryName,
         e.salary, e.currency, e.salary_usd AS salaryUsd, e.hire_date AS hireDate,
         e.created_at AS createdAt, e.updated_at AS updatedAt
  FROM employees e JOIN countries c ON c.code = e.country_code`;

/** Whitelisted ORDER BY expressions. Never interpolate user input into SQL. */
const SORT_SQL: Record<ListQuery['sort'], string> = {
  name: 'e.last_name {dir}, e.first_name {dir}',
  salaryUsd: 'e.salary_usd {dir}',
  hireDate: 'e.hire_date {dir}',
  jobTitle: 'e.job_title {dir}, e.level {dir}',
  country: 'c.name {dir}',
  department: 'e.department {dir}',
  employeeCode: 'e.employee_code {dir}',
};

/**
 * Turns free text into a safe FTS5 query: every whitespace-separated token becomes a quoted
 * prefix phrase ("carol"* AND "x"*), so FTS5 operators and punctuation in user input are never
 * interpreted. Inside quotes FTS5 applies the same tokenizer as the index, so "test.person" becomes
 * the phrase `test person*`. Tokens without any letter or digit (e.g. "%", "-", "(") are dropped.
 * Returns null when nothing searchable is left.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = input.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' AND ');
}

function buildWhere(filters: ListFilters): { sql: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.search) {
    const match = toFtsQuery(filters.search);
    if (match === null) {
      clauses.push('0'); // only punctuation: nothing can match
    } else {
      params.search = match;
      clauses.push('e.id IN (SELECT rowid FROM employees_fts WHERE employees_fts MATCH @search)');
    }
  }
  if (filters.country) {
    clauses.push('e.country_code = @country');
    params.country = filters.country;
  }
  if (filters.department) {
    clauses.push('e.department = @department');
    params.department = filters.department;
  }
  if (filters.jobTitle) {
    clauses.push('e.job_title = @jobTitle');
    params.jobTitle = filters.jobTitle;
  }
  if (filters.level) {
    clauses.push('e.level = @level');
    params.level = filters.level;
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export interface NewEmployeeRecord {
  employeeCode: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  level: string;
  department: string;
  countryCode: string;
  salary: number;
  currency: string;
  hireDate: string;
}

export function createEmployeeRepository(db: DB) {
  return {
    list(query: ListQuery): { items: EmployeeRow[]; total: number } {
      const { sql: where, params } = buildWhere(query);
      const dir = query.order === 'desc' ? 'DESC' : 'ASC';
      // Within one country every salary is in the same currency, so local salary orders exactly like USD
      // and idx_employees_country_salary can return rows pre-sorted (no conversion, no temp B-tree).
      const sortSql = query.sort === 'salaryUsd' && query.country ? 'e.salary {dir}' : SORT_SQL[query.sort];
      const orderBy = `${sortSql.replaceAll('{dir}', dir)}, e.id ${dir}`;
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM employees e ${where}`).get(params) as { n: number }).n;
      const items = db
        .prepare(`${SELECT_EMPLOYEE} ${where} ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`)
        .all({ ...params, limit: query.pageSize, offset: (query.page - 1) * query.pageSize }) as EmployeeRow[];
      return { items, total };
    },

    /** Streams all matches (for CSV export) without loading pages. */
    iterate(filters: ListFilters): IterableIterator<EmployeeRow> {
      const { sql: where, params } = buildWhere(filters);
      return db.prepare(`${SELECT_EMPLOYEE} ${where} ORDER BY e.employee_code`).iterate(params) as IterableIterator<EmployeeRow>;
    },

    findById(id: number): EmployeeRow | undefined {
      return db.prepare(`${SELECT_EMPLOYEE} WHERE e.id = ?`).get(id) as EmployeeRow | undefined;
    },

    findIdByCode(employeeCode: string): number | undefined {
      const row = db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(employeeCode) as { id: number } | undefined;
      return row?.id;
    },

    findIdByEmail(email: string): number | undefined {
      const row = db.prepare('SELECT id FROM employees WHERE email = ?').get(email) as { id: number } | undefined;
      return row?.id;
    },

    nextEmployeeCode(): string {
      const row = db.prepare('SELECT MAX(CAST(SUBSTR(employee_code, 6) AS INTEGER)) AS n FROM employees').get() as { n: number | null };
      return `ACME-${String((row.n ?? 0) + 1).padStart(5, '0')}`;
    },

    insert(e: NewEmployeeRecord): number {
      const result = db
        .prepare(`INSERT INTO employees (employee_code, first_name, last_name, email, job_title, level, department,
                                         country_code, salary, currency, salary_usd, hire_date)
                  VALUES (@employeeCode, @firstName, @lastName, @email, @jobTitle, @level, @department,
                          @countryCode, @salary, @currency, ${salaryUsdSql('@salary', '@countryCode')}, @hireDate)`)
        .run(e);
      return Number(result.lastInsertRowid);
    },

    update(id: number, fields: Partial<NewEmployeeRecord>): void {
      const columns: Record<keyof NewEmployeeRecord, string> = {
        employeeCode: 'employee_code', firstName: 'first_name', lastName: 'last_name', email: 'email',
        jobTitle: 'job_title', level: 'level', department: 'department', countryCode: 'country_code',
        salary: 'salary', currency: 'currency', hireDate: 'hire_date',
      };
      const keys = (Object.keys(fields) as (keyof NewEmployeeRecord)[]).filter((k) => fields[k] !== undefined);
      if (keys.length === 0) return;
      const set = keys.map((k) => `${columns[k]} = @${k}`).join(', ');
      db.prepare(`UPDATE employees SET ${set}, updated_at = datetime('now') WHERE id = @id`).run({ ...fields, id });
      if (keys.includes('salary') || keys.includes('countryCode')) {
        // Callers already run inside a transaction, so the cache never disagrees with salary/country.
        db.prepare(`UPDATE employees SET salary_usd = ${salaryUsdSql('employees.salary', 'employees.country_code')} WHERE id = ?`).run(id);
      }
    },

    delete(id: number): boolean {
      return db.prepare('DELETE FROM employees WHERE id = ?').run(id).changes > 0;
    },

    insertSalaryChange(c: Omit<SalaryChangeRow, 'id' | 'createdAt'>): void {
      db.prepare(`INSERT INTO salary_changes (employee_id, previous_salary, new_salary, currency, effective_date, reason)
                  VALUES (@employeeId, @previousSalary, @newSalary, @currency, @effectiveDate, @reason)`).run(c);
    },

    salaryHistory(employeeId: number): SalaryChangeRow[] {
      return db
        .prepare(`SELECT id, employee_id AS employeeId, previous_salary AS previousSalary, new_salary AS newSalary,
                         currency, effective_date AS effectiveDate, reason, created_at AS createdAt
                  FROM salary_changes WHERE employee_id = ? ORDER BY effective_date DESC, id DESC`)
        .all(employeeId) as SalaryChangeRow[];
    },
  };
}

export type EmployeeRepository = ReturnType<typeof createEmployeeRepository>;
