import { Router } from 'express';
import { z } from 'zod';
import { benchmarkQuerySchema, payEquityQuerySchema } from '../schemas';
import type { InsightsService } from '../services/insights-service';

const countryQuery = z.object({ country: z.string().length(2).toUpperCase().optional() });

export function insightsRouter(service: InsightsService): Router {
  const router = Router();
  router.get('/summary', (_req, res) => res.json(service.summary()));
  router.get('/by-country', (_req, res) => res.json(service.byCountry()));
  router.get('/by-department', (_req, res) => res.json(service.byDepartment()));
  router.get('/by-level', (_req, res) => res.json(service.byLevel()));
  router.get('/distribution', (req, res) => res.json(service.distribution(countryQuery.parse(req.query).country)));
  router.get('/benchmark', (req, res) => res.json(service.benchmark(benchmarkQuerySchema.parse(req.query))));
  router.get('/pay-equity', (req, res) => res.json(service.payEquity(payEquityQuerySchema.parse(req.query))));
  return router;
}
