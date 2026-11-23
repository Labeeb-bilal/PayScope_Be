import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { openDb } from '../src/db/connection';
import { seedDatabase } from '../src/db/seed';
import { csvField } from '../src/lib/csv';
import { employeeInput } from './helpers';

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  const db = openDb(':memory:');
  seedDatabase(db, 200, 7);
  app = createApp(db);
});

describe('GET /api/employees', () => {
  it('returns a paginated list with defaults', async () => {
    const res = await request(app).get('/api/employees');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 200, page: 1, pageSize: 25, totalPages: 8 });
    expect(res.body.items).toHaveLength(25);
    expect(res.body.items[0]).toHaveProperty('salaryUsd');
  });

  it('filters and validates query params', async () => {
    const res = await request(app).get('/api/employees?country=IN&pageSize=200');
    expect(res.body.items.every((e: { countryCode: string }) => e.countryCode === 'IN')).toBe(true);

    const bad = await request(app).get('/api/employees?pageSize=5000');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('employee lifecycle over HTTP', () => {
  it('creates, reads, changes salary, updates and deletes', async () => {
    const created = await request(app).post('/api/employees').send(employeeInput({ email: 'new.hire@acme.example' }));
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(created.body.employeeCode).toBe('ACME-00201');

    const raised = await request(app)
      .post(`/api/employees/${id}/salary-changes`)
      .send({ newSalary: 120_000, effectiveDate: '2026-01-01', reason: 'Promotion' });
    expect(raised.status).toBe(201);
    expect(raised.body.salary).toBe(120_000);

    const patched = await request(app).patch(`/api/employees/${id}`).send({ jobTitle: 'Data Engineer' });
    expect(patched.body.jobTitle).toBe('Data Engineer');

    const detail = await request(app).get(`/api/employees/${id}`);
    expect(detail.body.salaryHistory).toHaveLength(2);

    expect((await request(app).delete(`/api/employees/${id}`)).status).toBe(204);
    expect((await request(app).get(`/api/employees/${id}`)).status).toBe(404);
  });

  it('maps errors to status codes', async () => {
    expect((await request(app).post('/api/employees').send({ firstName: 'x' })).status).toBe(400);
    expect((await request(app).get('/api/employees/abc')).status).toBe(400);
    const dupe = employeeInput({ email: 'same@acme.example' });
    await request(app).post('/api/employees').send(dupe);
    expect((await request(app).post('/api/employees').send(dupe)).status).toBe(409);
    const badJson = await request(app).post('/api/employees').set('Content-Type', 'application/json').send('{oops');
    expect(badJson.status).toBe(400);
  });
});

describe('GET /api/employees/export.csv', () => {
  it('streams filtered rows as CSV', async () => {
    const res = await request(app).get('/api/employees/export.csv?country=US');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toContain('Employee code,First name');
    const usCount = (await request(app).get('/api/employees?country=US')).body.total;
    expect(lines).toHaveLength(usCount + 1);
  });
});

describe('csvField', () => {
  it('quotes commas/quotes and neutralises formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField(-5)).toBe('-5');
    expect(csvField(null)).toBe('');
  });
});

describe('insights and meta endpoints', () => {
  it('serve consistent numbers', async () => {
    const summary = (await request(app).get('/api/insights/summary')).body;
    const countries = (await request(app).get('/api/insights/by-country')).body as { headcount: number }[];
    expect(summary.headcount).toBe(200);
    expect(countries.reduce((s, c) => s + c.headcount, 0)).toBe(200);

    for (const path of ['by-department', 'by-level', 'distribution', 'pay-equity', 'benchmark?jobTitle=Software%20Engineer']) {
      expect((await request(app).get(`/api/insights/${path}`)).status).toBe(200);
    }
    expect((await request(app).get('/api/insights/benchmark')).status).toBe(400);

    const meta = (await request(app).get('/api/meta')).body;
    expect(meta.countries.length).toBeGreaterThan(5);
    expect(meta.levels[0]).toEqual({ code: 'L1', label: 'Associate' });
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
