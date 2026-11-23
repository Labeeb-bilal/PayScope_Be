import { Router } from 'express';
import { csvRow } from '../lib/csv';
import { ValidationError } from '../lib/errors';
import { createEmployeeSchema, listQuerySchema, salaryChangeSchema, updateEmployeeSchema } from '../schemas';
import type { EmployeeService } from '../services/employee-service';

function parseId(raw: string | string[] | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid employee id');
  return id;
}

const CSV_COLUMNS = [
  ['Employee code', 'employeeCode'], ['First name', 'firstName'], ['Last name', 'lastName'], ['Email', 'email'],
  ['Job title', 'jobTitle'], ['Level', 'level'], ['Department', 'department'], ['Country', 'countryName'],
  ['Currency', 'currency'], ['Annual salary', 'salary'], ['Annual salary (USD approx.)', 'salaryUsd'], ['Hire date', 'hireDate'],
] as const;

export function employeesRouter(service: EmployeeService): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(service.list(listQuerySchema.parse(req.query)));
  });

  router.get('/export.csv', (req, res) => {
    const { sort: _s, order: _o, page: _p, pageSize: _ps, ...filters } = listQuerySchema.parse(req.query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write(csvRow(CSV_COLUMNS.map(([label]) => label)));
    for (const e of service.exportRows(filters)) res.write(csvRow(CSV_COLUMNS.map(([, key]) => e[key])));
    res.end();
  });

  router.get('/:id', (req, res) => {
    res.json(service.get(parseId(req.params.id)));
  });

  router.post('/', (req, res) => {
    res.status(201).json(service.create(createEmployeeSchema.parse(req.body)));
  });

  router.patch('/:id', (req, res) => {
    res.json(service.update(parseId(req.params.id), updateEmployeeSchema.parse(req.body)));
  });

  router.delete('/:id', (req, res) => {
    service.remove(parseId(req.params.id));
    res.status(204).end();
  });

  router.post('/:id/salary-changes', (req, res) => {
    res.status(201).json(service.changeSalary(parseId(req.params.id), salaryChangeSchema.parse(req.body)));
  });

  return router;
}
