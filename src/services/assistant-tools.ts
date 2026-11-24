import { z } from 'zod';
import type { DB } from '../db/connection';
import { COUNTRIES, LEVEL_LABELS, LEVELS, type Level } from '../db/reference-data';
import { AppError } from '../lib/errors';
import type { ToolSpec } from '../lib/llm-client';
import { createReferenceRepository } from '../repositories/reference-repository';
import { listQuerySchema, SORT_FIELDS } from '../schemas';
import { createEmployeeService } from './employee-service';
import { createInsightsService } from './insights-service';

export const MAX_TOOL_ROWS = 20;

const COUNTRY_ALIASES: Record<string, string> = {
  uae: 'AE', emirates: 'AE', uk: 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB',
  usa: 'US', america: 'US', 'united states of america': 'US',
};

export function normalizeCountry(input: string): string | undefined {
  const key = input.trim().toLowerCase();
  const byCode = COUNTRIES.find((c) => c.code.toLowerCase() === key);
  const byName = COUNTRIES.find((c) => c.name.toLowerCase() === key);
  return byCode?.code ?? byName?.code ?? COUNTRY_ALIASES[key];
}

export function normalizeLevel(input: string): Level | undefined {
  const key = input.trim().toLowerCase();
  return LEVELS.find((l) => l.toLowerCase() === key || LEVEL_LABELS[l].toLowerCase() === key);
}

function matchIgnoringCase(input: string, options: readonly string[]): string | undefined {
  const key = input.trim().toLowerCase();
  return options.find((o) => o.toLowerCase() === key);
}

interface Catalog {
  departments: string[];
  jobTitles: string[];
}

function catalogFrom(db: DB): Catalog {
  const rows = createReferenceRepository(db).jobCatalog();
  return { departments: [...new Set(rows.map((r) => r.department))], jobTitles: [...new Set(rows.map((r) => r.jobTitle))] };
}

function mapped(normalize: (v: string) => string | undefined, describeValid: () => string) {
  return z.string().max(80).transform((value, ctx) => {
    const result = normalize(value);
    if (result === undefined) {
      ctx.addIssue({ code: 'custom', message: `"${value}" is not valid. ${describeValid()}` });
      return z.NEVER;
    }
    return result;
  });
}

function schemas(catalog: Catalog) {
  const country = mapped(normalizeCountry, () => `Use a country code: ${COUNTRIES.map((c) => c.code).join(', ')}.`).describe(
    'Country code, e.g. AE',
  );
  const level = mapped(normalizeLevel, () => `Use ${LEVELS.map((l) => `${l} (${LEVEL_LABELS[l]})`).join(', ')}.`).describe('L1-L5');
  const department = mapped((v) => matchIgnoringCase(v, catalog.departments), () => `Departments: ${catalog.departments.join(', ')}.`);
  const jobTitle = mapped(
    (v) => matchIgnoringCase(v, catalog.jobTitles),
    () => `Job titles: ${catalog.jobTitles.join(', ')}. Seniority (e.g. "Senior") goes in "level", not the title.`,
  );
  const limit = z.number().int().min(1).max(MAX_TOOL_ROWS);
  const none = z.object({}).strict();

  return {
    search_employees: z
      .object({
        search: z.string().max(100).optional().describe('Name, email or employee code (prefix match)'),
        country: country.optional(),
        department: department.optional(),
        level: level.optional(),
        jobTitle: jobTitle.optional(),
        sort: z.enum(SORT_FIELDS).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        limit: limit.optional().describe(`Max rows, default 10, max ${MAX_TOOL_ROWS}`),
      })
      .strict(),
    get_employee: z
      .object({
        id: z.number().int().positive().optional(),
        employeeCode: z.string().regex(/^ACME-\d{5}$/i, 'Expected an employee code like ACME-00042').optional(),
      })
      .strict()
      .refine((v) => (v.id === undefined) !== (v.employeeCode === undefined), 'Provide exactly one of "id" or "employeeCode"'),
    pay_benchmark: z.object({ jobTitle, level: level.optional(), country: country.optional() }).strict(),
    pay_equity: z
      .object({
        threshold: z.number().min(0.1).max(1).optional().describe('Flag pay below this share of the peer median, default 0.8'),
        country: country.optional(),
        department: department.optional(),
        limit: limit.optional().describe(`Max rows, default 10, max ${MAX_TOOL_ROWS}`),
      })
      .strict(),
    org_summary: none,
    pay_by_country: none,
    pay_by_department: none,
    pay_by_level: none,
  };
}

type Schemas = ReturnType<typeof schemas>;
export type ToolName = keyof Schemas;

const DESCRIPTIONS: Record<ToolName, string> = {
  search_employees: 'Find employees by name/email/code and/or filters. Returns total matches and up to `limit` rows with current salary.',
  get_employee: 'One employee by id or employee code, with their salary history.',
  pay_benchmark: 'Pay stats (min, P25, median, P75, max) in local currency for a job title, per country and level.',
  pay_equity: 'Employees paid below `threshold` x the median of their peers (same title, level, country), lowest first.',
  org_summary: 'Org-wide headcount, total payroll and median/mean salary (USD).',
  pay_by_country: 'Headcount and pay per country: local-currency stats and USD median/total.',
  pay_by_department: 'Headcount and pay per department in USD, with share of total payroll.',
  pay_by_level: 'Headcount and USD pay (P25/median/P75) per level L1-L5.',
};

type Args<N extends ToolName> = z.output<Schemas[N]>;

function handlers(db: DB) {
  const employees = createEmployeeService(db);
  const insights = createInsightsService(db);

  return {
    search_employees(a: Args<'search_employees'>) {
      const { limit = 10, ...filters } = a;
      const page = employees.list(listQuerySchema.parse({ ...filters, pageSize: limit }));
      return {
        total: page.total,
        shown: page.items.length,
        employees: page.items.map((e) => ({
          employeeCode: e.employeeCode,
          name: `${e.firstName} ${e.lastName}`,
          jobTitle: e.jobTitle,
          level: e.level,
          department: e.department,
          country: e.countryCode,
          currency: e.currency,
          salary: e.salary,
          salaryUsd: e.salaryUsd,
          hireDate: e.hireDate,
        })),
      };
    },

    get_employee(a: Args<'get_employee'>) {
      const e = a.id !== undefined ? employees.get(a.id) : employees.getByCode(a.employeeCode!);
      return {
        id: e.id,
        employeeCode: e.employeeCode,
        name: `${e.firstName} ${e.lastName}`,
        email: e.email,
        jobTitle: e.jobTitle,
        level: e.level,
        department: e.department,
        country: e.countryCode,
        countryName: e.countryName,
        currency: e.currency,
        salary: e.salary,
        salaryUsd: e.salaryUsd,
        hireDate: e.hireDate,
        salaryHistoryTotal: e.salaryHistory.length,
        salaryHistory: e.salaryHistory.slice(0, MAX_TOOL_ROWS).map((h) => ({
          effectiveDate: h.effectiveDate,
          previousSalary: h.previousSalary,
          newSalary: h.newSalary,
          currency: h.currency,
          reason: h.reason,
        })),
      };
    },

    pay_benchmark(a: Args<'pay_benchmark'>) {
      const result = insights.benchmark(a);
      return result.headcount === 0 ? { ...result, note: 'No employees match. Try without level or country.' } : result;
    },

    pay_equity(a: Args<'pay_equity'>) {
      const result = insights.payEquity({
        threshold: a.threshold ?? 0.8,
        minPeers: 5,
        limit: a.limit ?? 10,
        country: a.country,
        department: a.department,
      });
      return {
        threshold: result.threshold,
        minPeers: 5,
        totalFlagged: result.totalFlagged,
        totalGapUsd: result.totalGapUsd,
        shown: result.items.length,
        items: result.items.map(({ id: _id, ...item }) => item),
      };
    },

    org_summary: () => insights.summary(),

    pay_by_country: () =>
      insights.byCountry().map((c) => ({
        country: c.countryCode,
        countryName: c.countryName,
        currency: c.currency,
        headcount: c.headcount,
        localP25: c.local.p25,
        localMedian: c.local.median,
        localP75: c.local.p75,
        medianUsd: c.medianUsd,
        totalUsd: c.totalUsd,
      })),

    pay_by_department: () => insights.byDepartment().map((d) => ({ ...d, payrollShare: Math.round(d.payrollShare * 1000) / 1000 })),

    pay_by_level: () => insights.byLevel().map((l) => ({ ...l, label: LEVEL_LABELS[l.level as Level] })),
  } satisfies { [N in ToolName]: (args: Args<N>) => unknown };
}

export interface ToolOutcome {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  content: string;
}

function readableIssues(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

export const TOOL_SPECS: ToolSpec[] = (Object.entries(schemas({ departments: [], jobTitles: [] })) as [ToolName, z.ZodType][]).map(
  ([name, schema]) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    return { type: 'function', function: { name, description: DESCRIPTIONS[name], parameters } };
  },
);

export function createAssistantTools(db: DB) {
  const run = handlers(db);

  return {
    specs: TOOL_SPECS,

    execute(name: string, rawArguments: string): ToolOutcome {
      const fail = (args: Record<string, unknown>, error: string): ToolOutcome => ({
        name, args, ok: false, content: JSON.stringify({ error }),
      });

      if (!(name in run)) return fail({}, `Unknown tool "${name}". Available tools: ${Object.keys(run).join(', ')}.`);

      let raw: unknown;
      try {
        raw = rawArguments.trim() ? JSON.parse(rawArguments) : {};
      } catch {
        return fail({}, 'Arguments must be a JSON object.');
      }
      const rawArgs = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

      const toolName = name as ToolName;
      const parsed = schemas(catalogFrom(db))[toolName].safeParse(raw);
      if (!parsed.success) return fail(rawArgs, `Invalid arguments for ${name}: ${readableIssues(parsed.error)}`);

      try {
        const result = (run[toolName] as (a: unknown) => unknown)(parsed.data);
        return { name, args: parsed.data as Record<string, unknown>, ok: true, content: JSON.stringify(result) };
      } catch (err) {
        if (err instanceof AppError) return fail(parsed.data as Record<string, unknown>, err.message);
        throw err;
      }
    },
  };
}

export type AssistantTools = ReturnType<typeof createAssistantTools>;
