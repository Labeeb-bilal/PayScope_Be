import { z } from 'zod';
import { LEVELS } from './db/reference-data';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const salary = z.number().int('Salary must be a whole number').positive('Salary must be positive').max(1_000_000_000);
const name = z.string().trim().min(1).max(80);

export const SORT_FIELDS = ['name', 'salaryUsd', 'hireDate', 'jobTitle', 'country', 'department', 'employeeCode'] as const;

export const listQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  country: z.string().length(2).toUpperCase().optional(),
  department: z.string().max(80).optional(),
  jobTitle: z.string().max(80).optional(),
  level: z.enum(LEVELS).optional(),
  sort: z.enum(SORT_FIELDS).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
export type ListFilters = Omit<ListQuery, 'sort' | 'order' | 'page' | 'pageSize'>;

export const createEmployeeSchema = z.object({
  firstName: name,
  lastName: name,
  email: z.email().max(120).transform((s) => s.toLowerCase()),
  jobTitle: z.string().trim().min(1).max(80),
  level: z.enum(LEVELS),
  department: z.string().trim().min(1).max(80),
  countryCode: z.string().length(2).toUpperCase(),
  salary,
  hireDate: isoDate,
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/**
 * Salary is not editable here on purpose: it changes through /salary-changes so every
 * change has a reason and an effective date. The one exception is relocation: changing
 * country changes currency, so a new salary in the new currency is required.
 */
export const updateEmployeeSchema = createEmployeeSchema
  .omit({ salary: true })
  .partial()
  .extend({ salary: salary.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

export const salaryChangeSchema = z.object({
  newSalary: salary,
  effectiveDate: isoDate,
  reason: z.string().trim().min(3, 'Please give a reason').max(200),
});
export type SalaryChangeInput = z.infer<typeof salaryChangeSchema>;

export const benchmarkQuerySchema = z.object({
  jobTitle: z.string().min(1),
  level: z.enum(LEVELS).optional(),
  country: z.string().length(2).toUpperCase().optional(),
});

export const payEquityQuerySchema = z.object({
  threshold: z.coerce.number().min(0.1).max(1).default(0.8),
  country: z.string().length(2).toUpperCase().optional(),
  department: z.string().optional(),
  minPeers: z.coerce.number().int().min(2).max(100).default(5),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
