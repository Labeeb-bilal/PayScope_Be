import { describe, expect, it } from 'vitest';
import { createInsightsService } from '../src/services/insights-service';
import { niceStep } from '../src/lib/stats';
import { employeeInput, setup } from './helpers';

/**
 * Hand-built dataset where the right answers are easy to verify by eye:
 * - 5 US L2 Software Engineers: 90k, 95k, 100k, 105k, 60k → median 95k, the 60k one is underpaid (ratio 0.63)
 * - 2 India L2 Software Engineers: 1,670,000 and 2,505,000 INR (= 20k and 30k USD)
 * - 1 US L3 Account Executive in Sales: 120k
 */
function fixture() {
  const ctx = setup();
  const add = (o: Parameters<typeof employeeInput>[0]) => ctx.service.create(employeeInput(o));
  for (const salary of [90_000, 95_000, 100_000, 105_000]) add({ salary });
  const underpaid = add({ salary: 60_000, firstName: 'Under', lastName: 'Paid' });
  add({ countryCode: 'IN', salary: 1_670_000 });
  add({ countryCode: 'IN', salary: 2_505_000 });
  add({ jobTitle: 'Account Executive', department: 'Sales', level: 'L3', salary: 120_000 });
  return { ...ctx, insights: createInsightsService(ctx.db), underpaid };
}

describe('InsightsService.summary', () => {
  it('reports headcount and USD payroll across currencies', () => {
    const { insights } = fixture();
    expect(insights.summary()).toEqual({
      headcount: 8,
      totalPayrollUsd: 90_000 + 95_000 + 100_000 + 105_000 + 60_000 + 20_000 + 30_000 + 120_000,
      medianSalaryUsd: 92_500,
      meanSalaryUsd: 77_500,
      countries: 2,
      departments: 2,
    });
  });

  it('handles an empty org', () => {
    const { db } = setup();
    expect(createInsightsService(db).summary()).toMatchObject({ headcount: 0, totalPayrollUsd: 0 });
  });
});

describe('InsightsService.byCountry', () => {
  it('keeps stats in local currency and adds a USD median', () => {
    const { insights } = fixture();
    const india = insights.byCountry().find((c) => c.countryCode === 'IN')!;
    expect(india).toMatchObject({ currency: 'INR', headcount: 2, medianUsd: 25_000 });
    expect(india.local).toMatchObject({ min: 1_670_000, max: 2_505_000, median: 2_087_500 });
  });
});

describe('InsightsService.byDepartment', () => {
  it('orders by payroll cost and computes payroll share', () => {
    const { insights } = fixture();
    const [eng, sales] = insights.byDepartment();
    expect(eng!.department).toBe('Engineering');
    expect(sales).toMatchObject({ department: 'Sales', headcount: 1, totalUsd: 120_000 });
    expect(eng!.payrollShare + sales!.payrollShare).toBeCloseTo(1);
  });
});

describe('InsightsService.benchmark', () => {
  it('returns per country × level stats for a job title', () => {
    const { insights } = fixture();
    const result = insights.benchmark({ jobTitle: 'Software Engineer' });
    expect(result.headcount).toBe(7);
    const us = result.items.find((i) => i.countryCode === 'US')!;
    expect(us).toMatchObject({ level: 'L2', currency: 'USD', count: 5, min: 60_000, median: 95_000, max: 105_000 });
  });

  it('narrows by country', () => {
    const { insights } = fixture();
    const result = insights.benchmark({ jobTitle: 'Software Engineer', country: 'IN' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.medianUsd).toBe(25_000);
  });
});

describe('InsightsService.payEquity', () => {
  const defaults = { threshold: 0.8, minPeers: 5, limit: 100 };

  it('flags employees well below their peer median', () => {
    const { insights, underpaid } = fixture();
    const result = insights.payEquity(defaults);
    expect(result.totalFlagged).toBe(1);
    expect(result.items[0]).toMatchObject({ id: underpaid.id, peerMedian: 95_000, peerCount: 5, gapToMedian: 35_000, ratio: 0.632 });
  });

  it('ignores peer groups smaller than minPeers', () => {
    const { insights } = fixture();
    expect(insights.payEquity({ ...defaults, minPeers: 6 }).totalFlagged).toBe(0);
  });

  it('applies country/department filters to the flagged list', () => {
    const { insights } = fixture();
    expect(insights.payEquity({ ...defaults, country: 'IN' }).totalFlagged).toBe(0);
    expect(insights.payEquity({ ...defaults, department: 'Engineering' }).totalFlagged).toBe(1);
  });
});

describe('InsightsService.distribution', () => {
  it('uses USD org-wide and local currency for one country', () => {
    const { insights } = fixture();
    expect(insights.distribution().currency).toBe('USD');
    const india = insights.distribution('IN');
    expect(india.currency).toBe('INR');
    expect(india.buckets.reduce((s, b) => s + b.count, 0)).toBe(2);
    expect(india.buckets.at(-1)!.to).toBeNull();
  });
});

describe('niceStep', () => {
  it('rounds to 1/2/2.5/5 × 10^n', () => {
    expect(niceStep(13_000)).toBe(20_000);
    expect(niceStep(2_300)).toBe(2_500);
    expect(niceStep(4_100)).toBe(5_000);
    expect(niceStep(0)).toBe(1);
  });
});
