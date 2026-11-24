import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { createEmployeeRepository } from '../src/repositories/employee-repository';
import { listQuerySchema } from '../src/schemas';
import { createInsightsService } from '../src/services/insights-service';

export interface CapturedStatement {
  sql: string;
  args: unknown[];
}

export interface QueryCase {
  name: string;
  run: (db: DB) => unknown;
}

export const EMPLOYEE_COUNT = 10_000;

export const CASES: QueryCase[] = [
  {
    name: '1. List sorted by salary (USD) desc, page 1',
    run: (db) => createEmployeeRepository(db).list(listQuerySchema.parse({ sort: 'salaryUsd', order: 'desc' })),
  },
  {
    name: '2. List filtered by country=IN, sorted by salary desc',
    run: (db) => createEmployeeRepository(db).list(listQuerySchema.parse({ country: 'IN', sort: 'salaryUsd', order: 'desc' })),
  },
  {
    name: '3. Search "pri" (name / email / code prefix)',
    run: (db) => createEmployeeRepository(db).list(listQuerySchema.parse({ search: 'pri' })),
  },
  {
    name: '4. Benchmark (job_title + level + country)',
    run: (db) => createInsightsService(db).benchmark({ jobTitle: 'Data Engineer', level: 'L3', country: 'DE' }),
  },
  {
    name: '5. Salary history for one employee',
    run: (db) => createEmployeeRepository(db).salaryHistory(5_000),
  },
  {
    name: '6. Default directory page (sorted by name)',
    run: (db) => createEmployeeRepository(db).list(listQuerySchema.parse({})),
  },
];

export function openSeededTempDb(): { db: DB; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-perf-'));
  const db = openDb(path.join(dir, 'perf.db'));
  seedDatabase(db, EMPLOYEE_COUNT);
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const EXECUTING_METHODS = new Set(['all', 'get', 'run', 'iterate']);

export function captureStatements(db: DB, fn: () => unknown): CapturedStatement[] {
  const captured: CapturedStatement[] = [];
  const originalPrepare = db.prepare;
  db.prepare = ((sql: string) => {
    const stmt = originalPrepare.call(db, sql);
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (typeof prop === 'string' && EXECUTING_METHODS.has(prop)) {
          return (...args: unknown[]) => {
            captured.push({ sql, args });
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
  }) as DB['prepare'];
  try {
    const result = fn();
    if (result && typeof result === 'object' && Symbol.iterator in result && !Array.isArray(result)) {
      for (const _ of result as Iterable<unknown>) void _;
    }
  } finally {
    db.prepare = originalPrepare;
  }
  return captured;
}

export function oneLine(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export function environment(db: DB): string {
  const { v } = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
  return `Node ${process.version}, SQLite ${v}, ${cpu}, ${os.platform()} ${os.arch()}`;
}
