import { openDb, type DB } from '../src/db/connection';
import type { CreateEmployeeInput } from '../src/schemas';
import { createEmployeeService } from '../src/services/employee-service';

let counter = 0;

export function employeeInput(overrides: Partial<CreateEmployeeInput> = {}): CreateEmployeeInput {
  counter++;
  return {
    firstName: 'Test',
    lastName: `Person${counter}`,
    email: `test.person${counter}@acme.example`,
    jobTitle: 'Software Engineer',
    level: 'L2',
    department: 'Engineering',
    countryCode: 'US',
    salary: 100_000,
    hireDate: '2022-01-10',
    ...overrides,
  };
}

export function setup(): { db: DB; service: ReturnType<typeof createEmployeeService> } {
  const db = openDb(':memory:');
  return { db, service: createEmployeeService(db) };
}
