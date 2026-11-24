/**
 * Aggregate queries for pay insights. SQLite does the counting, summing, grouping, filtering and
 * ordering; only small results reach Node. USD figures use the stored employees.salary_usd column:
 * no join to countries and no division per row.
 *
 * Percentiles: SQLite has no MEDIAN/PERCENTILE function, and window functions (ROW_NUMBER OVER ...)
 * measured slower than sorting in JS. Instead every percentile is read from an index that is already
 * sorted by (group, value): `ORDER BY value LIMIT 1 OFFSET k` walks the index and returns one number,
 * with no sort. Group sizes come from the GROUP BY query. See docs/05-performance.md.
 *
 * SQL fragments built here (column names) come from this file only; user values are always bound.
 */
import type { DB } from '../db/connection';
import type Database from 'better-sqlite3';

export interface Filters {
  country?: string;
  department?: string;
  jobTitle?: string;
  level?: string;
}

/** A grouping and the columns its percentiles are read in (each pair is backed by an index). */
type Grouping = 'all' | 'country' | 'department' | 'level' | 'benchmark';
type Measure = 'local' | 'usd';

const GROUP_COLUMNS: Record<Grouping, string[]> = {
  all: [],
  country: ['country_code'],
  department: ['department'],
  level: ['level'],
  // Benchmark rows are always filtered by job_title; groups are country × level.
  benchmark: ['country_code', 'level'],
};

const FILTER_COLUMNS: Record<keyof Filters, string> = {
  country: 'country_code',
  department: 'department',
  jobTitle: 'job_title',
  level: 'level',
};

/**
 * Value column for a measure, and the column to ORDER BY so an index can serve it.
 * Within one country every salary has the same currency, so ordering by `salary` also orders
 * `salary_usd`; that lets (country_code, salary) and the peer index serve USD percentiles too.
 */
function columns(grouping: Grouping, measure: Measure): { value: string; order: string } {
  if (measure === 'local') return { value: 'salary', order: 'salary' };
  const singleCurrency = GROUP_COLUMNS[grouping].includes('country_code');
  return { value: 'salary_usd', order: singleCurrency ? 'salary' : 'salary_usd' };
}

export interface GroupAggregate {
  /** Group values joined with "|", e.g. "IN" or "AE|L3"; "" for the whole table. */
  key: string;
  count: number;
  min: number;
  max: number;
  total: number;
  mean: number;
}

export interface PeerFlag {
  id: number;
  employeeCode: string;
  name: string;
  jobTitle: string;
  level: string;
  department: string;
  countryCode: string;
  currency: string;
  salary: number;
  peerMedian: number;
  peerCount: number;
  ratio: number;
  gapToMedianUsd: number;
}

export function createInsightsRepository(db: DB) {
  // Statements are prepared once per SQL text: percentile lookups run many tiny queries.
  const cache = new Map<string, Database.Statement>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };

  function filterSql(filters: Filters, extra: string[] = []): { sql: string; params: Record<string, string> } {
    const clauses = [...extra];
    const params: Record<string, string> = {};
    for (const key of Object.keys(FILTER_COLUMNS) as (keyof Filters)[]) {
      const value = filters[key];
      if (value === undefined) continue;
      clauses.push(`${FILTER_COLUMNS[key]} = @${key}`);
      params[key] = value;
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  /** Value at 0-based position `offset` of the group's sorted values: one indexed lookup. */
  function valueAt(grouping: Grouping, measure: Measure, groupValues: string[], offset: number, filters: Filters): number {
    const cols = GROUP_COLUMNS[grouping];
    const { value, order } = columns(grouping, measure);
    const { sql, params } = filterSql(filters, cols.map((c, i) => `${c} = @g${i}`));
    const groupParams = Object.fromEntries(groupValues.map((v, i) => [`g${i}`, v]));
    return stmt(`SELECT ${value} FROM employees ${sql} ORDER BY ${order} LIMIT 1 OFFSET @offset`)
      .pluck()
      .get({ ...params, ...groupParams, offset }) as number;
  }

  return {
    /** COUNT / MIN / MAX / SUM / AVG per group, computed by SQLite. */
    aggregates(grouping: Grouping, measure: Measure, filters: Filters = {}): GroupAggregate[] {
      const cols = GROUP_COLUMNS[grouping];
      const { value } = columns(grouping, measure);
      const key = cols.length ? cols.join(" || '|' || ") : "''";
      const { sql, params } = filterSql(filters);
      return stmt(
        `SELECT ${key} AS key, COUNT(*) AS count, MIN(${value}) AS min, MAX(${value}) AS max,
                SUM(${value}) AS total, AVG(${value}) AS mean
         FROM employees ${sql} ${cols.length ? `GROUP BY ${cols.join(', ')}` : 'HAVING COUNT(*) > 0'}`,
      ).all(params) as GroupAggregate[];
    },

    /**
     * Linear-interpolated percentiles (Excel PERCENTILE.INC, same as lib/stats percentileSorted) of one
     * group of `count` rows. Each percentile needs one or two indexed lookups.
     */
    percentiles(grouping: Grouping, measure: Measure, groupKey: string, count: number, ps: readonly number[], filters: Filters = {}): number[] {
      const groupValues = GROUP_COLUMNS[grouping].length ? groupKey.split('|') : [];
      return ps.map((p) => {
        const idx = (count - 1) * p;
        const lo = Math.floor(idx);
        const loVal = valueAt(grouping, measure, groupValues, lo, filters);
        if (idx === lo) return loVal;
        const hiVal = valueAt(grouping, measure, groupValues, lo + 1, filters);
        return loVal + (hiVal - loVal) * (idx - lo);
      });
    },

    /** Distinct countries and departments with at least one employee. */
    distinctCounts(): { countries: number; departments: number } {
      return stmt('SELECT COUNT(DISTINCT country_code) AS countries, COUNT(DISTINCT department) AS departments FROM employees').get() as {
        countries: number;
        departments: number;
      };
    },

    /**
     * Histogram counts per bucket via GROUP BY. Bucket i covers [i*step, (i+1)*step); values at or above
     * the last bucket's start are counted in the last bucket (open-ended).
     */
    histogram(measure: Measure, step: number, bucketCount: number, filters: Filters = {}): Map<number, number> {
      const value = measure === 'usd' ? 'salary_usd' : 'salary';
      const { sql, params } = filterSql(filters);
      const rows = stmt(
        `SELECT MIN(CAST(${value} / @step AS INTEGER), @last) AS bucket, COUNT(*) AS count
         FROM employees ${sql} GROUP BY bucket`,
      )
        .raw()
        .all({ ...params, step, last: bucketCount - 1 }) as [number, number][];
      return new Map(rows);
    },

    /**
     * Employees paid below `threshold` × their peer median (same title, level, country), lowest ratio first.
     *
     * 1. Peer medians: SQLite streams (title, level, country, salary) from the covering index
     *    idx_employees_peer_salary, already sorted, so each group's median is just its middle value(s).
     * 2. Everything else is one SQL statement: the medians are passed as JSON, each group's underpaid
     *    people are found with an index range search (salary < threshold × median), and SQLite orders
     *    them and computes the totals. The USD gap is only computed for flagged rows.
     */
    payEquity(q: { threshold: number; minPeers: number; limit: number; country?: string; department?: string }): {
      totalFlagged: number;
      totalGapUsd: number;
      items: PeerFlag[];
    } {
      const peers: [string, string, string, number, number][] = [];
      let group: [string, string, string] | null = null;
      let salaries: number[] = [];
      const close = () => {
        const n = salaries.length;
        if (group && n >= q.minPeers) peers.push([...group, n, (salaries[(n - 1) >> 1]! + salaries[n >> 1]!) / 2]);
      };
      const sorted = stmt('SELECT job_title, level, country_code, salary FROM employees ORDER BY job_title, level, country_code, salary')
        .raw()
        .all() as [string, string, string, number][];
      for (const [jobTitle, level, country, salary] of sorted) {
        if (!group || group[0] !== jobTitle || group[1] !== level || group[2] !== country) {
          close();
          group = [jobTitle, level, country];
          salaries = [];
        }
        salaries.push(salary);
      }
      close();

      const extra = [q.country ? 'AND e.country_code = @country' : '', q.department ? 'AND e.department = @department' : ''].join(' ');
      const rows = stmt(
        `WITH peers AS (
           SELECT value ->> 0 AS job_title, value ->> 1 AS level, value ->> 2 AS country_code,
                  value ->> 3 AS peer_count, value ->> 4 AS peer_median
           FROM json_each(@peers)
         ),
         flagged AS (
           SELECT e.id, e.employee_code AS employeeCode, e.first_name || ' ' || e.last_name AS name,
                  e.job_title AS jobTitle, e.level, e.department, e.country_code AS countryCode, e.currency,
                  e.salary, p.peer_median AS peerMedian, p.peer_count AS peerCount,
                  e.salary * 1.0 / p.peer_median AS ratio,
                  ROUND((p.peer_median - e.salary) / c.usd_rate) AS gapToMedianUsd
           FROM peers p
           JOIN employees e ON e.job_title = p.job_title AND e.level = p.level AND e.country_code = p.country_code
                           AND e.salary < @threshold * p.peer_median ${extra}
           JOIN countries c ON c.code = e.country_code
         )
         SELECT *, COUNT(*) OVER () AS totalFlagged, SUM(gapToMedianUsd) OVER () AS totalGapUsd
         FROM flagged ORDER BY ratio, id LIMIT @limit`,
      ).all({
        peers: JSON.stringify(peers),
        threshold: q.threshold,
        limit: q.limit,
        ...(q.country ? { country: q.country } : {}),
        ...(q.department ? { department: q.department } : {}),
      }) as (PeerFlag & { totalFlagged: number; totalGapUsd: number })[];

      return {
        totalFlagged: rows[0]?.totalFlagged ?? 0,
        totalGapUsd: rows[0]?.totalGapUsd ?? 0,
        items: rows.map(({ totalFlagged: _t, totalGapUsd: _g, ...item }) => item),
      };
    },
  };
}

export type InsightsRepository = ReturnType<typeof createInsightsRepository>;
