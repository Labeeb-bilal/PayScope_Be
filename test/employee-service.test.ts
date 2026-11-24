import { describe, expect, it } from 'vitest';
import { listQuerySchema } from '../src/schemas';
import { employeeInput, setup } from './helpers';

const query = (q: Record<string, unknown> = {}) => listQuerySchema.parse(q);

describe('EmployeeService.create', () => {
  it('derives currency from country and records the initial salary in history', () => {
    const { service } = setup();
    const e = service.create(employeeInput({ countryCode: 'IN', salary: 2_500_000, hireDate: '2023-04-01' }));
    expect(e.currency).toBe('INR');
    expect(e.employeeCode).toBe('ACME-00001');
    expect(e.salaryUsd).toBe(Math.round(2_500_000 / 83.5));
    expect(e.salaryHistory).toHaveLength(1);
    expect(e.salaryHistory[0]).toMatchObject({ previousSalary: null, newSalary: 2_500_000, reason: 'Initial salary', effectiveDate: '2023-04-01' });
  });

  it('assigns sequential employee codes', () => {
    const { service } = setup();
    service.create(employeeInput());
    expect(service.create(employeeInput()).employeeCode).toBe('ACME-00002');
  });

  it('rejects duplicate emails (case-insensitive)', () => {
    const { service } = setup();
    service.create(employeeInput({ email: 'dup@acme.example' }));
    expect(() => service.create(employeeInput({ email: 'DUP@Acme.example' }))).toThrow(/already in use/);
  });

  it('rejects unknown countries', () => {
    const { service } = setup();
    expect(() => service.create(employeeInput({ countryCode: 'ZZ' }))).toThrow(/Unknown country/);
  });
});

describe('EmployeeService.changeSalary', () => {
  it('updates current salary and appends history atomically', () => {
    const { service } = setup();
    const { id } = service.create(employeeInput({ salary: 100_000 }));
    const updated = service.changeSalary(id, { newSalary: 110_000, effectiveDate: '2025-01-01', reason: 'Annual review' });
    expect(updated.salary).toBe(110_000);
    expect(updated.salaryHistory[0]).toMatchObject({ previousSalary: 100_000, newSalary: 110_000, reason: 'Annual review' });
    expect(updated.salaryHistory).toHaveLength(2);
  });

  it('rejects no-op changes and dates before hire', () => {
    const { service } = setup();
    const { id } = service.create(employeeInput({ salary: 100_000, hireDate: '2022-01-10' }));
    expect(() => service.changeSalary(id, { newSalary: 100_000, effectiveDate: '2025-01-01', reason: 'none' })).toThrow(/same/);
    expect(() => service.changeSalary(id, { newSalary: 120_000, effectiveDate: '2021-01-01', reason: 'early' })).toThrow(/hire date/);
  });

  it('throws NotFound for unknown employee', () => {
    const { service } = setup();
    expect(() => service.changeSalary(999, { newSalary: 1, effectiveDate: '2025-01-01', reason: 'x y z' })).toThrow(/not found/);
  });
});

describe('EmployeeService.update', () => {
  it('updates profile fields without touching salary history', () => {
    const { service } = setup();
    const { id } = service.create(employeeInput());
    const updated = service.update(id, { jobTitle: 'Data Engineer', level: 'L3' });
    expect(updated).toMatchObject({ jobTitle: 'Data Engineer', level: 'L3' });
    expect(updated.salaryHistory).toHaveLength(1);
  });

  it('refuses a salary edit outside of a relocation', () => {
    const { service } = setup();
    const { id } = service.create(employeeInput());
    expect(() => service.update(id, { salary: 1 })).toThrow(/salary change/);
  });

  it('requires a new salary when relocating, then switches currency and logs it', () => {
    const { service } = setup();
    const { id } = service.create(employeeInput({ countryCode: 'US', salary: 100_000 }));
    expect(() => service.update(id, { countryCode: 'DE' })).toThrow(/new salary is required/);

    const moved = service.update(id, { countryCode: 'DE', salary: 85_000 });
    expect(moved).toMatchObject({ countryCode: 'DE', currency: 'EUR', salary: 85_000 });
    expect(moved.salaryHistory[0]).toMatchObject({ newSalary: 85_000, currency: 'EUR', reason: 'Relocation US → DE' });
  });

  it('rejects taking another employee’s email', () => {
    const { service } = setup();
    service.create(employeeInput({ email: 'taken@acme.example' }));
    const { id } = service.create(employeeInput());
    expect(() => service.update(id, { email: 'taken@acme.example' })).toThrow(/already in use/);
  });
});

describe('EmployeeService.remove', () => {
  it('deletes the employee and their history', () => {
    const { service, db } = setup();
    const { id } = service.create(employeeInput());
    service.remove(id);
    expect(() => service.get(id)).toThrow(/not found/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM salary_changes').get() as { n: number }).n).toBe(0);
    expect(() => service.remove(id)).toThrow(/not found/);
  });
});

describe('EmployeeService.list', () => {
  function seedFew() {
    const ctx = setup();
    ctx.service.create(employeeInput({ firstName: 'Alice', lastName: 'Zhang', countryCode: 'US', salary: 150_000, department: 'Engineering' }));
    ctx.service.create(employeeInput({ firstName: 'Bob', lastName: 'Young', countryCode: 'IN', salary: 3_000_000, department: 'Sales', jobTitle: 'Account Executive' }));
    ctx.service.create(employeeInput({ firstName: 'Carol', lastName: 'Xu', countryCode: 'GB', salary: 70_000, department: 'Engineering', level: 'L4' }));
    return ctx;
  }

  it('paginates and reports totals', () => {
    const { service } = seedFew();
    const page = service.list(query({ pageSize: 2, page: 2 }));
    expect(page).toMatchObject({ total: 3, totalPages: 2, page: 2 });
    expect(page.items).toHaveLength(1);
  });

  it('filters by country, department and level', () => {
    const { service } = seedFew();
    expect(service.list(query({ country: 'in' })).items.map((e) => e.firstName)).toEqual(['Bob']);
    expect(service.list(query({ department: 'Engineering' })).total).toBe(2);
    expect(service.list(query({ level: 'L4' })).items.map((e) => e.firstName)).toEqual(['Carol']);
  });

  it('searches by name prefix, full name and email, treating % literally', () => {
    const { service } = seedFew();
    expect(service.list(query({ search: 'ali' })).total).toBe(1);
    expect(service.list(query({ search: 'Carol X' })).total).toBe(1);
    expect(service.list(query({ search: 'test.person' })).total).toBe(3);
    expect(service.list(query({ search: '%' })).total).toBe(0);
  });

  it('sorts by USD-equivalent salary across currencies', () => {
    const { service } = seedFew();
    // US 150k USD > GB 70k GBP (~88.6k USD) > IN 3M INR (~35.9k USD)
    const names = service.list(query({ sort: 'salaryUsd', order: 'desc' })).items.map((e) => e.firstName);
    expect(names).toEqual(['Alice', 'Carol', 'Bob']);
  });

  it('sorts by salary within a country filter (asc and desc, ties broken by id)', () => {
    const { service } = setup();
    const mk = (firstName: string, salary: number, countryCode = 'IN') =>
      service.create(employeeInput({ firstName, countryCode, salary }));
    mk('Mid', 2_000_000);
    mk('High', 4_000_000);
    mk('Low', 900_000);
    mk('MidToo', 2_000_000);
    mk('Outsider', 9_000_000, 'US'); // excluded by the filter

    const names = (order: 'asc' | 'desc') =>
      service.list(query({ country: 'IN', sort: 'salaryUsd', order })).items.map((e) => e.firstName);
    expect(names('desc')).toEqual(['High', 'MidToo', 'Mid', 'Low']);
    expect(names('asc')).toEqual(['Low', 'Mid', 'MidToo', 'High']);

    const paged = service.list(query({ country: 'IN', sort: 'salaryUsd', order: 'desc', pageSize: 2, page: 2 }));
    expect(paged.items.map((e) => e.firstName)).toEqual(['Mid', 'Low']);
    expect(paged.total).toBe(4);
  });
});
