import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { rateLimit } from '../src/lib/rate-limit';

describe('rateLimit', () => {
  it('allows max requests per window, then 429 until the window resets', async () => {
    let now = 1_000_000;
    const app = express().get('/', rateLimit({ max: 2, windowMs: 60_000, now: () => now }), (_req, res) => {
      res.send('ok');
    });
    expect((await request(app).get('/')).status).toBe(200);
    expect((await request(app).get('/')).status).toBe(200);
    const limited = await request(app).get('/');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    now += 30_000;
    expect((await request(app).get('/')).headers['retry-after']).toBe('30');
    now += 30_000;
    expect((await request(app).get('/')).status).toBe(200);
  });
});
