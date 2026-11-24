import { describe, expect, it } from 'vitest';
import { listQuerySchema } from '../src/schemas';
import { createAssistantTools, MAX_TOOL_ROWS, normalizeCountry, normalizeLevel, TOOL_SPECS } from '../src/services/assistant-tools';
import { createInsightsService } from '../src/services/insights-service';
import { employeeInput, setup } from './helpers';

function dataset() {
  const ctx = setup();
  const add = (o: Parameters<typeof employeeInput>[0]) => ctx.service.create(employeeInput(o));
  const ae = [400_000, 420_000, 440_000, 460_000, 480_000, 250_000].map((salary, i) =>
    add({ firstName: `Omar${i}`, lastName: 'Haddad', jobTitle: 'Data Engineer', level: 'L3', countryCode: 'AE', salary, department: 'Engineering' }),
  );
  const priya = add({ firstName: 'Priya', lastName: 'Sharma', jobTitle: 'Account Executive', department: 'Sales', level: 'L2', countryCode: 'IN', salary: 1_500_000, hireDate: '2021-03-01' });
  ctx.service.changeSalary(priya.id, { newSalary: 1_800_000, effectiveDate: '2024-04-01', reason: 'Annual review' });
  add({ firstName: 'Ravi', lastName: 'Kumar', jobTitle: 'Account Executive', department: 'Sales', level: 'L2', countryCode: 'IN', salary: 1_600_000 });
  add({ firstName: 'Jane', lastName: 'Smith', jobTitle: 'Recruiter', department: 'People & HR', level: 'L1', countryCode: 'US', salary: 70_000 });
  return { ...ctx, tools: createAssistantTools(ctx.db), insights: createInsightsService(ctx.db), ae, priya };
}

function run(tools: ReturnType<typeof createAssistantTools>, name: string, args: unknown = {}) {
  const outcome = tools.execute(name, JSON.stringify(args));
  return { ...outcome, data: JSON.parse(outcome.content) };
}

describe('assistant tools return the same numbers as the services', () => {
  it('pay_benchmark', () => {
    const { tools, insights } = dataset();
    const { ok, data, args } = run(tools, 'pay_benchmark', { jobTitle: 'Data Engineer', level: 'L3', country: 'AE' });
    expect(ok).toBe(true);
    expect(args).toEqual({ jobTitle: 'Data Engineer', level: 'L3', country: 'AE' });
    expect(data).toEqual(insights.benchmark({ jobTitle: 'Data Engineer', level: 'L3', country: 'AE' }));
    expect(data.items[0]).toMatchObject({ currency: 'AED', count: 6, min: 250_000, max: 480_000, median: 430_000 });
  });

  it('pay_equity', () => {
    const { tools, insights, ae } = dataset();
    const { data } = run(tools, 'pay_equity', { country: 'AE' });
    const expected = insights.payEquity({ threshold: 0.8, minPeers: 5, limit: 10, country: 'AE' });
    expect(data.totalFlagged).toBe(expected.totalFlagged);
    expect(data.totalGapUsd).toBe(expected.totalGapUsd);
    expect(data.items).toHaveLength(1);
    const { id: _id, ...item } = expected.items[0]!;
    expect(data.items[0]).toEqual(item);
    expect(data.items[0].employeeCode).toBe(ae[5]!.employeeCode);
  });

  it('search_employees', () => {
    const { tools, service } = dataset();
    const { data } = run(tools, 'search_employees', { department: 'Sales', country: 'IN', sort: 'salaryUsd', order: 'desc' });
    const expected = service.list(listQuerySchema.parse({ department: 'Sales', country: 'IN', sort: 'salaryUsd', order: 'desc', pageSize: 10 }));
    expect(data.total).toBe(expected.total);
    expect(data.employees.map((e: { employeeCode: string; salary: number }) => [e.employeeCode, e.salary])).toEqual(
      expected.items.map((e) => [e.employeeCode, e.salary]),
    );
    expect(data.employees[0]).toMatchObject({ name: 'Priya Sharma', salary: 1_800_000, currency: 'INR', salaryUsd: Math.round(1_800_000 / 83.5) });
  });

  it('get_employee by code and by id, with salary history', () => {
    const { tools, service, priya } = dataset();
    const byCode = run(tools, 'get_employee', { employeeCode: priya.employeeCode.toLowerCase() }).data;
    const byId = run(tools, 'get_employee', { id: priya.id }).data;
    expect(byCode).toEqual(byId);
    const detail = service.get(priya.id);
    expect(byCode).toMatchObject({ employeeCode: detail.employeeCode, salary: 1_800_000, salaryHistoryTotal: 2 });
    expect(byCode.salaryHistory).toEqual(
      detail.salaryHistory.map((h) => ({ effectiveDate: h.effectiveDate, previousSalary: h.previousSalary, newSalary: h.newSalary, currency: h.currency, reason: h.reason })),
    );
  });

  it('org_summary and pay_by_* match the insight endpoints', () => {
    const { tools, insights } = dataset();
    expect(run(tools, 'org_summary').data).toEqual(insights.summary());
    const byCountry = run(tools, 'pay_by_country').data;
    expect(byCountry.map((c: { country: string; headcount: number; medianUsd: number; localMedian: number }) => [c.country, c.headcount, c.medianUsd, c.localMedian])).toEqual(
      insights.byCountry().map((c) => [c.countryCode, c.headcount, c.medianUsd, c.local.median]),
    );
    expect(run(tools, 'pay_by_department').data.map((d: { totalUsd: number }) => d.totalUsd)).toEqual(insights.byDepartment().map((d) => d.totalUsd));
    expect(run(tools, 'pay_by_level').data.map((l: { medianUsd: number }) => l.medianUsd)).toEqual(insights.byLevel().map((l) => l.medianUsd));
  });

  it('caps rows at the requested limit and reports the total', () => {
    const { tools } = dataset();
    const { data } = run(tools, 'search_employees', { country: 'AE', limit: 2 });
    expect(data).toMatchObject({ total: 6, shown: 2 });
  });
});

describe('assistant tool input handling', () => {
  it('normalises friendly inputs to stored values', () => {
    expect(normalizeCountry('UAE')).toBe('AE');
    expect(normalizeCountry('united arab emirates')).toBe('AE');
    expect(normalizeCountry('in')).toBe('IN');
    expect(normalizeCountry('Narnia')).toBeUndefined();
    expect(normalizeLevel('Senior')).toBe('L3');
    expect(normalizeLevel('l5')).toBe('L5');

    const { tools } = dataset();
    const { ok, args } = run(tools, 'pay_benchmark', { jobTitle: 'data engineer', level: 'senior', country: 'UAE' });
    expect(ok).toBe(true);
    expect(args).toEqual({ jobTitle: 'Data Engineer', level: 'L3', country: 'AE' });
  });

  it.each([
    ['pay_benchmark', {}, /jobTitle/],
    ['pay_benchmark', { jobTitle: 'Senior Data Engineer' }, /not valid.*Job titles: .*Data Engineer.*"level"/],
    ['pay_benchmark', { jobTitle: 'Data Engineer', country: 'Narnia' }, /country: "Narnia" is not valid.*AE/],
    ['pay_equity', { threshold: 5 }, /threshold/],
    ['search_employees', { limit: MAX_TOOL_ROWS + 1 }, /limit/],
    ['search_employees', { level: 'Wizard' }, /level: "Wizard" is not valid.*L3 \(Senior\)/],
    ['search_employees', { colour: 'red' }, /colour|Unrecognized/i],
    ['get_employee', {}, /exactly one of "id" or "employeeCode"/],
    ['get_employee', { employeeCode: 'bob' }, /ACME-00042/],
  ])('%s rejects %j with a readable error', (name, args, message) => {
    const { tools } = dataset();
    const outcome = run(tools, name, args);
    expect(outcome.ok).toBe(false);
    expect(outcome.data.error).toMatch(new RegExp(`^Invalid arguments for ${name}: `));
    expect(outcome.data.error).toMatch(message);
  });

  it('reports unknown tools, bad JSON and missing employees without throwing', () => {
    const { tools } = dataset();
    expect(JSON.parse(tools.execute('delete_employee', '{}').content).error).toMatch(/Unknown tool "delete_employee". Available tools: .*pay_benchmark/);
    expect(JSON.parse(tools.execute('org_summary', '{not json').content).error).toMatch(/JSON object/);
    expect(JSON.parse(tools.execute('get_employee', '{"employeeCode":"ACME-99999"}').content).error).toMatch(/not found/i);
    expect(tools.execute('org_summary', '').ok).toBe(true);
  });

  it('exposes only read-only tools with valid JSON schemas', () => {
    expect(TOOL_SPECS.map((t) => t.function.name).sort()).toEqual(
      ['get_employee', 'org_summary', 'pay_benchmark', 'pay_by_country', 'pay_by_department', 'pay_by_level', 'pay_equity', 'search_employees'],
    );
    for (const t of TOOL_SPECS) expect(t.function.parameters).toMatchObject({ type: 'object' });
  });
});
