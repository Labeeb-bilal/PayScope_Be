import type { DB } from '../db/connection';

export interface CountryRow {
  code: string;
  name: string;
  currency: string;
  usdRate: number;
}

export function createReferenceRepository(db: DB) {
  return {
    countries(): CountryRow[] {
      return db.prepare('SELECT code, name, currency, usd_rate AS usdRate FROM countries ORDER BY name').all() as CountryRow[];
    },
    country(code: string): CountryRow | undefined {
      return db.prepare('SELECT code, name, currency, usd_rate AS usdRate FROM countries WHERE code = ?').get(code) as
        | CountryRow
        | undefined;
    },
    /** Departments and titles currently in use, so filters reflect real data. */
    jobCatalog(): { department: string; jobTitle: string; headcount: number }[] {
      return db
        .prepare(`SELECT department, job_title AS jobTitle, COUNT(*) AS headcount
                  FROM employees GROUP BY department, job_title ORDER BY department, job_title`)
        .all() as { department: string; jobTitle: string; headcount: number }[];
    },
  };
}

export type ReferenceRepository = ReturnType<typeof createReferenceRepository>;
