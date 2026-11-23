import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { DB } from './db/connection';
import { LEVEL_LABELS, LEVELS } from './db/reference-data';
import { AppError } from './lib/errors';
import { createReferenceRepository } from './repositories/reference-repository';
import { employeesRouter } from './routes/employees';
import { insightsRouter } from './routes/insights';
import { createEmployeeService } from './services/employee-service';
import { createInsightsService } from './services/insights-service';

export interface AppOptions {
  /** Built frontend to serve at '/'. Omitted in tests and in dev (Next dev server runs separately). */
  staticDir?: string;
}

export function createApp(db: DB, options: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors()); // dev only matters: in production UI and API share an origin
  app.use(express.json({ limit: '100kb' }));

  const reference = createReferenceRepository(db);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/meta', (_req, res) => {
    const catalog = reference.jobCatalog();
    const departments = [...new Set(catalog.map((c) => c.department))];
    res.json({
      countries: reference.countries(),
      levels: LEVELS.map((code) => ({ code, label: LEVEL_LABELS[code] })),
      departments: departments.map((name) => ({ name, jobTitles: catalog.filter((c) => c.department === name).map((c) => c.jobTitle) })),
    });
  });
  app.use('/api/employees', employeesRouter(createEmployeeService(db)));
  app.use('/api/insights', insightsRouter(createInsightsService(db)));
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } }));

  if (options.staticDir && fs.existsSync(options.staticDir)) {
    const dir = options.staticDir;
    app.use(express.static(dir, { extensions: ['html'] }));
    app.use((_req, res) => res.sendFile(path.join(dir, 'index.html')));
  }

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), details: err.issues },
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  };
  app.use(errorHandler);
  return app;
}
