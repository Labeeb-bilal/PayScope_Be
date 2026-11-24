import express, { type ErrorRequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { DB } from './db/connection';
import { LEVEL_LABELS, LEVELS } from './db/reference-data';
import { corsMiddleware, type CorsOrigins } from './lib/cors';
import { AppError } from './lib/errors';
import type { LlmClient } from './lib/llm-client';
import type { RateLimitOptions } from './lib/rate-limit';
import { assistantRouter } from './routes/assistant';
import { createReferenceRepository } from './repositories/reference-repository';
import { employeesRouter } from './routes/employees';
import { insightsRouter } from './routes/insights';
import { createAssistantService } from './services/assistant-service';
import { createEmployeeService } from './services/employee-service';
import { createInsightsService } from './services/insights-service';

export interface AppOptions {
  /** Built frontend to serve at '/'. Omitted in tests and in dev (Next dev server runs separately). */
  staticDir?: string;
  /** Browser origins allowed to call the API cross-origin (from CORS_ORIGIN, see parseCorsOrigins). Default: none (same-origin only). */
  corsOrigins?: CorsOrigins;
  /** LLM for the HR assistant. Omitted or null: the assistant is disabled and the rest of the app is unaffected. */
  llm?: LlmClient | null;
  /** Rate limit for POST /api/assistant/chat (default 20 per minute per IP). */
  chatRateLimit?: RateLimitOptions;
}

export function createApp(db: DB, options: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Only listed sites get CORS headers; browsers block cross-origin calls from anywhere else.
  // Same-origin requests (UI served by this API) and non-browser clients are unaffected by CORS.
  app.use(corsMiddleware(options.corsOrigins ?? []));
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
  app.use('/api/assistant', assistantRouter(options.llm ? createAssistantService({ db, llm: options.llm }) : null, options.chatRateLimit));
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
