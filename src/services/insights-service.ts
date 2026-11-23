import type { DB } from '../db/connection';
import { LEVELS } from '../db/reference-data';
import { NotFoundError } from '../lib/errors';
import { groupBy, histogram, niceStep, percentileSorted, summarize, toUsd, type SummaryStats } from '../lib/stats';

interface PayRow {
  id: number;
  employeeCode: string;
  name: string;
  jobTitle: string;
  level: string;
  department: string;
  countryCode: string;
  countryName: string;
  currency: string;
  salary: number;
  usdRate: number;
}

const round = (n: number) => Math.round(n);

function roundStats(s: SummaryStats): SummaryStats {
  return { count: s.count, min: s.min, p25: round(s.p25), median: round(s.median), p75: round(s.p75), max: s.max, mean: round(s.mean), total: s.total };
}

/**
 * Answers "how does the org pay people?". Reads the pay columns once per call (10k rows ≈ a few ms)
 * and aggregates in memory. Local-currency stats are only computed within a single currency.
 * Anything spanning countries is converted to USD.
 */
export function createInsightsService(db: DB) {
  function load(filter: { country?: string; department?: string; jobTitle?: string; level?: string } = {}): PayRow[] {
    const clauses: string[] = [];
    if (filter.country) clauses.push('e.country_code = @country');
    if (filter.department) clauses.push('e.department = @department');
    if (filter.jobTitle) clauses.push('e.job_title = @jobTitle');
    if (filter.level) clauses.push('e.level = @level');
    return db
      .prepare(`SELECT e.id, e.employee_code AS employeeCode, e.first_name || ' ' || e.last_name AS name, e.job_title AS jobTitle,
                       e.level, e.department, e.country_code AS countryCode, c.name AS countryName, e.currency, e.salary,
                       c.usd_rate AS usdRate
                FROM employees e JOIN countries c ON c.code = e.country_code
                ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`)
      .all(filter) as PayRow[];
  }

  const usd = (r: PayRow) => toUsd(r.salary, r.usdRate);

  return {
    summary() {
      const rows = load();
      const stats = summarize(rows.map(usd));
      return {
        headcount: rows.length,
        totalPayrollUsd: round(stats?.total ?? 0),
        medianSalaryUsd: round(stats?.median ?? 0),
        meanSalaryUsd: round(stats?.mean ?? 0),
        countries: new Set(rows.map((r) => r.countryCode)).size,
        departments: new Set(rows.map((r) => r.department)).size,
      };
    },

    byCountry() {
      const groups = groupBy(load(), (r) => r.countryCode);
      return [...groups.values()]
        .map((rows) => {
          const first = rows[0]!;
          const usdStats = summarize(rows.map(usd))!;
          return {
            countryCode: first.countryCode,
            countryName: first.countryName,
            currency: first.currency,
            headcount: rows.length,
            local: roundStats(summarize(rows.map((r) => r.salary))!),
            medianUsd: round(usdStats.median),
            totalUsd: round(usdStats.total),
          };
        })
        .sort((a, b) => b.headcount - a.headcount);
    },

    byDepartment() {
      const rows = load();
      const grandTotal = rows.reduce((s, r) => s + usd(r), 0);
      return [...groupBy(rows, (r) => r.department).entries()]
        .map(([department, group]) => {
          const s = summarize(group.map(usd))!;
          return {
            department,
            headcount: group.length,
            medianUsd: round(s.median),
            meanUsd: round(s.mean),
            totalUsd: round(s.total),
            payrollShare: grandTotal ? s.total / grandTotal : 0,
          };
        })
        .sort((a, b) => b.totalUsd - a.totalUsd);
    },

    byLevel() {
      const groups = groupBy(load(), (r) => r.level);
      return LEVELS.filter((l) => groups.has(l)).map((level) => {
        const s = summarize(groups.get(level)!.map(usd))!;
        return { level, headcount: s.count, medianUsd: round(s.median), p25Usd: round(s.p25), p75Usd: round(s.p75) };
      });
    },

    /** Salary distribution: in local currency when one country is selected, otherwise USD. */
    distribution(country?: string) {
      const rows = load({ country });
      if (country && rows.length === 0) throw new NotFoundError('Employees for country');
      const values = country ? rows.map((r) => r.salary) : rows.map(usd);
      const currency = country ? rows[0]!.currency : 'USD';
      if (values.length === 0) return { currency, buckets: [] };
      const sorted = [...values].sort((a, b) => a - b);
      // Size buckets on P99 so a few outliers don't squash the chart.
      const step = niceStep(percentileSorted(sorted, 0.99) / 15);
      return {
        currency,
        buckets: histogram(values, step, 16).map((b) => ({ ...b, to: Number.isFinite(b.to) ? b.to : null })),
      };
    },

    /** "What do we pay a <title> (at <level>) (in <country>)?" Stats per country × level in local currency. */
    benchmark(q: { jobTitle: string; level?: string; country?: string }) {
      const rows = load({ jobTitle: q.jobTitle, level: q.level, country: q.country });
      const groups = groupBy(rows, (r) => `${r.countryCode}|${r.level}`);
      const items = [...groups.values()]
        .map((group) => {
          const first = group[0]!;
          const local = roundStats(summarize(group.map((r) => r.salary))!);
          return {
            countryCode: first.countryCode,
            countryName: first.countryName,
            currency: first.currency,
            level: first.level,
            ...local,
            medianUsd: round(toUsd(local.median, first.usdRate)),
          };
        })
        .sort((a, b) => a.countryName.localeCompare(b.countryName) || a.level.localeCompare(b.level));
      return { jobTitle: q.jobTitle, headcount: rows.length, items };
    },

    /**
     * Flags people paid below `threshold` × the median of their peer group
     * (same job title, level and country). Small peer groups are skipped: a median of 2 people isn't a benchmark.
     */
    payEquity(q: { threshold: number; minPeers: number; limit: number; country?: string; department?: string }) {
      const peers = groupBy(load(), (r) => `${r.jobTitle}|${r.level}|${r.countryCode}`);
      const flagged = [];
      for (const group of peers.values()) {
        if (group.length < q.minPeers) continue;
        const peerMedian = percentileSorted(group.map((r) => r.salary).sort((a, b) => a - b), 0.5);
        for (const r of group) {
          const ratio = r.salary / peerMedian;
          if (ratio >= q.threshold) continue;
          if (q.country && r.countryCode !== q.country) continue;
          if (q.department && r.department !== q.department) continue;
          flagged.push({
            id: r.id,
            employeeCode: r.employeeCode,
            name: r.name,
            jobTitle: r.jobTitle,
            level: r.level,
            department: r.department,
            countryCode: r.countryCode,
            currency: r.currency,
            salary: r.salary,
            peerMedian: round(peerMedian),
            peerCount: group.length,
            ratio: Math.round(ratio * 1000) / 1000,
            gapToMedian: round(peerMedian - r.salary),
            gapToMedianUsd: round(toUsd(peerMedian - r.salary, r.usdRate)),
          });
        }
      }
      flagged.sort((a, b) => a.ratio - b.ratio);
      return {
        threshold: q.threshold,
        totalFlagged: flagged.length,
        totalGapUsd: flagged.reduce((s, f) => s + f.gapToMedianUsd, 0),
        items: flagged.slice(0, q.limit),
      };
    },
  };
}

export type InsightsService = ReturnType<typeof createInsightsService>;
