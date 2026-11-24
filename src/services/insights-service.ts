import type { DB } from '../db/connection';
import { LEVELS } from '../db/reference-data';
import { NotFoundError } from '../lib/errors';
import { niceStep, type SummaryStats } from '../lib/stats';
import { createInsightsRepository, type GroupAggregate } from '../repositories/insights-repository';
import { createReferenceRepository } from '../repositories/reference-repository';

const round = (n: number) => Math.round(n);
const QUARTILES = [0.25, 0.5, 0.75] as const;

/** SummaryStats from SQL aggregates + indexed percentile lookups, rounded for display. */
function stats(agg: GroupAggregate, [p25, median, p75]: number[]): SummaryStats {
  return { count: agg.count, min: agg.min, p25: round(p25!), median: round(median!), p75: round(p75!), max: agg.max, mean: round(agg.mean), total: agg.total };
}

/**
 * Answers "how does the org pay people?". Totals, counts and averages come from SQL GROUP BY;
 * percentiles from indexed lookups; pay-equity flags from one SQL statement. Node never loads the
 * employee table. Cross-country figures use the stored USD value (employees.salary_usd);
 * per-country figures stay in local currency.
 */
export function createInsightsService(db: DB) {
  const repo = createInsightsRepository(db);
  const reference = createReferenceRepository(db);
  const countriesByCode = () => new Map(reference.countries().map((c) => [c.code, c]));

  return {
    summary() {
      const [all] = repo.aggregates('all', 'usd');
      const distinct = repo.distinctCounts();
      if (!all) return { headcount: 0, totalPayrollUsd: 0, medianSalaryUsd: 0, meanSalaryUsd: 0, countries: 0, departments: 0 };
      const [median] = repo.percentiles('all', 'usd', '', all.count, [0.5]);
      return {
        headcount: all.count,
        totalPayrollUsd: round(all.total),
        medianSalaryUsd: round(median!),
        meanSalaryUsd: round(all.mean),
        countries: distinct.countries,
        departments: distinct.departments,
      };
    },

    byCountry() {
      const countries = countriesByCode();
      const usdTotals = new Map(repo.aggregates('country', 'usd').map((a) => [a.key, a.total]));
      return repo
        .aggregates('country', 'local')
        .map((agg) => {
          const country = countries.get(agg.key)!;
          const [medianUsd] = repo.percentiles('country', 'usd', agg.key, agg.count, [0.5]);
          return {
            countryCode: agg.key,
            countryName: country.name,
            currency: country.currency,
            headcount: agg.count,
            local: stats(agg, repo.percentiles('country', 'local', agg.key, agg.count, QUARTILES)),
            medianUsd: round(medianUsd!),
            totalUsd: round(usdTotals.get(agg.key) ?? 0),
          };
        })
        .sort((a, b) => b.headcount - a.headcount);
    },

    byDepartment() {
      const groups = repo.aggregates('department', 'usd');
      const grandTotal = groups.reduce((sum, g) => sum + g.total, 0); // one number per department
      return groups
        .map((g) => ({
          department: g.key,
          headcount: g.count,
          medianUsd: round(repo.percentiles('department', 'usd', g.key, g.count, [0.5])[0]!),
          meanUsd: round(g.mean),
          totalUsd: round(g.total),
          payrollShare: grandTotal ? g.total / grandTotal : 0,
        }))
        .sort((a, b) => b.totalUsd - a.totalUsd);
    },

    byLevel() {
      const groups = new Map(repo.aggregates('level', 'usd').map((a) => [a.key, a]));
      return LEVELS.filter((l) => groups.has(l)).map((level) => {
        const g = groups.get(level)!;
        const [p25, median, p75] = repo.percentiles('level', 'usd', level, g.count, QUARTILES);
        return { level, headcount: g.count, medianUsd: round(median!), p25Usd: round(p25!), p75Usd: round(p75!) };
      });
    },

    /** Salary distribution: in local currency when one country is selected, otherwise USD. */
    distribution(country?: string) {
      const measure = country ? 'local' : 'usd';
      const filters = country ? { country } : {};
      const [all] = repo.aggregates('all', measure, filters);
      if (!all) {
        if (country) throw new NotFoundError('Employees for country');
        return { currency: 'USD', buckets: [] };
      }
      // Size buckets on P99 so a few outliers don't squash the chart; the last bucket is open-ended.
      const [p99] = repo.percentiles('all', measure, '', all.count, [0.99], filters);
      const step = niceStep(p99! / 15);
      const bucketCount = Math.min(16, Math.floor(all.max / step) + 1);
      const counts = repo.histogram(measure, step, bucketCount, filters);
      return {
        currency: country ? countriesByCode().get(country)!.currency : 'USD',
        buckets: Array.from({ length: bucketCount }, (_, i) => ({
          from: i * step,
          to: i === bucketCount - 1 ? null : (i + 1) * step,
          count: counts.get(i) ?? 0,
        })),
      };
    },

    /** "What do we pay a <title> (at <level>) (in <country>)?" Stats per country × level in local currency. */
    benchmark(q: { jobTitle: string; level?: string; country?: string }) {
      const filters = { jobTitle: q.jobTitle, level: q.level, country: q.country };
      const countries = countriesByCode();
      const groups = repo.aggregates('benchmark', 'local', filters);
      const items = groups
        .map((g) => {
          const [countryCode, level] = g.key.split('|') as [string, string];
          const country = countries.get(countryCode)!;
          return {
            countryCode,
            countryName: country.name,
            currency: country.currency,
            level,
            ...stats(g, repo.percentiles('benchmark', 'local', g.key, g.count, QUARTILES, filters)),
            medianUsd: round(repo.percentiles('benchmark', 'usd', g.key, g.count, [0.5], filters)[0]!),
          };
        })
        .sort((a, b) => a.countryName.localeCompare(b.countryName) || a.level.localeCompare(b.level));
      return { jobTitle: q.jobTitle, headcount: groups.reduce((sum, g) => sum + g.count, 0), items };
    },

    /**
     * Flags people paid below `threshold` × the median of their peer group
     * (same job title, level and country). Small peer groups are skipped: a median of 2 people isn't a benchmark.
     */
    payEquity(q: { threshold: number; minPeers: number; limit: number; country?: string; department?: string }) {
      const result = repo.payEquity(q);
      return {
        threshold: q.threshold,
        totalFlagged: result.totalFlagged,
        totalGapUsd: round(result.totalGapUsd),
        items: result.items.map((f) => ({
          id: f.id,
          employeeCode: f.employeeCode,
          name: f.name,
          jobTitle: f.jobTitle,
          level: f.level,
          department: f.department,
          countryCode: f.countryCode,
          currency: f.currency,
          salary: f.salary,
          peerMedian: round(f.peerMedian),
          peerCount: f.peerCount,
          ratio: Math.round(f.ratio * 1000) / 1000,
          gapToMedian: round(f.peerMedian - f.salary),
          gapToMedianUsd: round(f.gapToMedianUsd),
        })),
      };
    },
  };
}

export type InsightsService = ReturnType<typeof createInsightsService>;
