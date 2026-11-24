import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { groupBy, histogram, percentileSorted } from '../src/lib/stats';
import { createInsightsRepository } from '../src/repositories/insights-repository';
import { createInsightsService } from '../src/services/insights-service';

/**
 * The SQL implementation is checked against a plain in-memory oracle on a realistic seeded dataset:
 * read every row once, then group/sort/sum in TypeScript the obvious way. Any off-by-one in an
 * OFFSET or a wrong GROUP BY shows up as a mismatch.
 */
const db = openDb();
seedDatabase(db, 1_500);
const repo = createInsightsRepository(db);
const rows = db
  .prepare('SELECT id, job_title AS jobTitle, level, department, country_code AS country, salary, salary_usd AS usd FROM employees')
  .all() as { id: number; jobTitle: string; level: string; department: string; country: string; salary: number; usd: number }[];

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const PS = [0, 0.25, 0.5, 0.75, 0.99, 1];

describe('insights repository vs in-memory oracle', () => {
  it.each([
    ['department', 'usd', (r: (typeof rows)[0]) => r.department, (r: (typeof rows)[0]) => r.usd],
    ['level', 'usd', (r: (typeof rows)[0]) => r.level, (r: (typeof rows)[0]) => r.usd],
    ['country', 'local', (r: (typeof rows)[0]) => r.country, (r: (typeof rows)[0]) => r.salary],
    ['country', 'usd', (r: (typeof rows)[0]) => r.country, (r: (typeof rows)[0]) => r.usd],
    ['all', 'usd', () => '', (r: (typeof rows)[0]) => r.usd],
  ] as const)('aggregates and percentiles by %s (%s)', (grouping, measure, key, value) => {
    const expected = groupBy(rows, key);
    const aggregates = repo.aggregates(grouping, measure);
    expect(aggregates.map((a) => a.key).sort()).toEqual([...expected.keys()].sort());
    for (const agg of aggregates) {
      const values = sorted(expected.get(agg.key)!.map(value));
      const total = values.reduce((s, v) => s + v, 0);
      expect(agg).toMatchObject({ count: values.length, min: values[0], max: values.at(-1), total });
      expect(agg.mean).toBeCloseTo(total / values.length, 6);
      const got = repo.percentiles(grouping, measure, agg.key, agg.count, PS);
      expect(got).toEqual(PS.map((p) => percentileSorted(values, p)));
    }
  });

  it('benchmark groups (country × level for one title, optionally filtered)', () => {
    for (const filters of [{ jobTitle: 'Software Engineer' }, { jobTitle: 'Account Executive', country: 'IN' }, { jobTitle: 'Recruiter', level: 'L1' }]) {
      const matching = rows.filter(
        (r) => r.jobTitle === filters.jobTitle && (!('country' in filters) || r.country === filters.country) && (!('level' in filters) || r.level === filters.level),
      );
      const expected = groupBy(matching, (r): string => `${r.country}|${r.level}`);
      const groups = repo.aggregates('benchmark', 'local', filters);
      expect(groups.map((g) => g.key).sort()).toEqual([...expected.keys()].sort());
      for (const g of groups) {
        const local = sorted(expected.get(g.key)!.map((r) => r.salary));
        const usd = sorted(expected.get(g.key)!.map((r) => r.usd));
        expect(repo.percentiles('benchmark', 'local', g.key, g.count, PS, filters)).toEqual(PS.map((p) => percentileSorted(local, p)));
        expect(repo.percentiles('benchmark', 'usd', g.key, g.count, [0.5], filters)).toEqual([percentileSorted(usd, 0.5)]);
      }
    }
  });

  it('histogram counts match the in-memory histogram', () => {
    const usd = rows.map((r) => r.usd);
    const step = 20_000;
    const expected = histogram(usd, step, 16);
    const counts = repo.histogram('usd', step, expected.length);
    expect(expected.map((b, i) => counts.get(i) ?? 0)).toEqual(expected.map((b) => b.count));
  });

  it('pay equity flags exactly the people below threshold × peer median, lowest ratio first', () => {
    for (const q of [
      { threshold: 0.8, minPeers: 5, limit: 1_000 },
      { threshold: 0.9, minPeers: 3, limit: 1_000, country: 'US' },
      { threshold: 0.85, minPeers: 5, limit: 1_000, department: 'Sales' },
    ]) {
      const expected: { id: number; ratio: number; median: number }[] = [];
      for (const peers of groupBy(rows, (r) => `${r.jobTitle}|${r.level}|${r.country}`).values()) {
        if (peers.length < q.minPeers) continue;
        const median = percentileSorted(sorted(peers.map((r) => r.salary)), 0.5);
        for (const r of peers) {
          if (r.salary >= q.threshold * median) continue;
          if (q.country && r.country !== q.country) continue;
          if (q.department && r.department !== q.department) continue;
          expected.push({ id: r.id, ratio: r.salary / median, median });
        }
      }
      expected.sort((a, b) => a.ratio - b.ratio || a.id - b.id);
      const result = repo.payEquity(q);
      expect(result.totalFlagged).toBe(expected.length);
      expect(result.items.map((i) => i.id)).toEqual(expected.map((e) => e.id));
      expect(result.items.map((i) => i.peerMedian)).toEqual(expected.map((e) => e.median));
    }
  });

  it('limit caps the items but not the totals', () => {
    const all = repo.payEquity({ threshold: 0.9, minPeers: 5, limit: 1_000 });
    const top = repo.payEquity({ threshold: 0.9, minPeers: 5, limit: 3 });
    expect(top.items).toEqual(all.items.slice(0, 3));
    expect(top.totalFlagged).toBe(all.totalFlagged);
    expect(top.totalGapUsd).toBe(all.totalGapUsd);
  });

  it('service answers an empty org without errors', () => {
    const empty = createInsightsService(openDb());
    expect(empty.summary()).toEqual({ headcount: 0, totalPayrollUsd: 0, medianSalaryUsd: 0, meanSalaryUsd: 0, countries: 0, departments: 0 });
    expect(empty.byCountry()).toEqual([]);
    expect(empty.byDepartment()).toEqual([]);
    expect(empty.byLevel()).toEqual([]);
    expect(empty.distribution()).toEqual({ currency: 'USD', buckets: [] });
    expect(() => empty.distribution('IN')).toThrow(/not found/);
    expect(empty.benchmark({ jobTitle: 'Data Engineer' })).toEqual({ jobTitle: 'Data Engineer', headcount: 0, items: [] });
    expect(empty.payEquity({ threshold: 0.8, minPeers: 5, limit: 10 })).toEqual({ threshold: 0.8, totalFlagged: 0, totalGapUsd: 0, items: [] });
  });
});
