import type { DB } from '../db/connection';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { createEmployeeRepository, type EmployeeRow, type SalaryChangeRow } from '../repositories/employee-repository';
import { createReferenceRepository } from '../repositories/reference-repository';
import type { CreateEmployeeInput, ListFilters, ListQuery, SalaryChangeInput, UpdateEmployeeInput } from '../schemas';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export type EmployeeDetail = EmployeeRow & { salaryHistory: SalaryChangeRow[] };

export function createEmployeeService(db: DB) {
  const employees = createEmployeeRepository(db);
  const reference = createReferenceRepository(db);

  function requireCountry(code: string) {
    const country = reference.country(code);
    if (!country) throw new ValidationError(`Unknown country code: ${code}`);
    return country;
  }

  function ensureEmailFree(email: string, exceptId?: number) {
    const ownerId = employees.findIdByEmail(email);
    if (ownerId !== undefined && ownerId !== exceptId) throw new ConflictError(`Email ${email} is already in use`);
  }

  function get(id: number): EmployeeDetail {
    const employee = employees.findById(id);
    if (!employee) throw new NotFoundError('Employee');
    return { ...employee, salaryHistory: employees.salaryHistory(id) };
  }

  return {
    list(query: ListQuery): Page<EmployeeRow> {
      const { items, total } = employees.list(query);
      return { items, total, page: query.page, pageSize: query.pageSize, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) };
    },

    exportRows(filters: ListFilters) {
      return employees.iterate(filters);
    },

    get,

    create(input: CreateEmployeeInput): EmployeeDetail {
      const country = requireCountry(input.countryCode);
      ensureEmailFree(input.email);
      const id = db.transaction(() => {
        const newId = employees.insert({ ...input, currency: country.currency, employeeCode: employees.nextEmployeeCode() });
        employees.insertSalaryChange({
          employeeId: newId,
          previousSalary: null,
          newSalary: input.salary,
          currency: country.currency,
          effectiveDate: input.hireDate,
          reason: 'Initial salary',
        });
        return newId;
      })();
      return get(id);
    },

    update(id: number, input: UpdateEmployeeInput): EmployeeDetail {
      const current = get(id);
      if (input.email) ensureEmailFree(input.email, id);

      const relocating = input.countryCode !== undefined && input.countryCode !== current.countryCode;
      if (input.salary !== undefined && !relocating) {
        throw new ValidationError('Use a salary change (with a reason) to change salary');
      }
      const newCountry = relocating ? requireCountry(input.countryCode!) : undefined;
      if (relocating && input.salary === undefined) {
        throw new ValidationError(`Moving to ${newCountry!.name} changes the currency to ${newCountry!.currency}; a new salary is required`);
      }

      db.transaction(() => {
        const { salary, ...rest } = input;
        employees.update(id, relocating ? { ...rest, salary, currency: newCountry!.currency } : rest);
        if (relocating) {
          employees.insertSalaryChange({
            employeeId: id,
            previousSalary: null, // different currency: a numeric "previous" would be misleading
            newSalary: salary!,
            currency: newCountry!.currency,
            effectiveDate: new Date().toISOString().slice(0, 10),
            reason: `Relocation ${current.countryCode} → ${newCountry!.code}`,
          });
        }
      })();
      return get(id);
    },

    remove(id: number): void {
      if (!employees.delete(id)) throw new NotFoundError('Employee');
    },

    changeSalary(id: number, input: SalaryChangeInput): EmployeeDetail {
      const current = get(id);
      if (input.newSalary === current.salary) throw new ValidationError('New salary is the same as the current salary');
      if (input.effectiveDate < current.hireDate) throw new ValidationError('Effective date cannot be before the hire date');
      db.transaction(() => {
        employees.insertSalaryChange({
          employeeId: id,
          previousSalary: current.salary,
          newSalary: input.newSalary,
          currency: current.currency,
          effectiveDate: input.effectiveDate,
          reason: input.reason,
        });
        employees.update(id, { salary: input.newSalary });
      })();
      return get(id);
    },
  };
}

export type EmployeeService = ReturnType<typeof createEmployeeService>;
