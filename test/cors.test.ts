import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { openDb } from '../src/db/connection';
import { parseCorsOrigins } from '../src/lib/cors';

const envFile = (name: string) => parseEnv(fs.readFileSync(path.join(__dirname, '..', name), 'utf8')) as NodeJS.ProcessEnv;

describe('parseCorsOrigins', () => {
  it('has no hard-coded default: unset means same-origin only, in every environment', () => {
    expect(parseCorsOrigins({})).toEqual([]);
    expect(parseCorsOrigins({ NODE_ENV: 'development' })).toEqual([]);
    expect(parseCorsOrigins({ NODE_ENV: 'production', CORS_ORIGIN: '  ' })).toEqual([]);
  });

  it('the committed env files are valid: dev allows the Next dev server, prod has a placeholder to replace', () => {
    const dev = envFile('.env.development');
    expect(dev.NODE_ENV).toBe('development');
    expect(parseCorsOrigins(dev)).toEqual(['http://localhost:3000', 'http://127.0.0.1:3000']);
    const prod = envFile('.env.production.example');
    expect(prod.NODE_ENV).toBe('production');
    expect(parseCorsOrigins(prod)).toEqual(['https://your-frontend.example.com']);
  });

  it('never commits secrets in the development env file', () => {
    expect(envFile('.env.development').LLM_API_KEY).toBeUndefined();
  });

  it('reads a comma-separated list, or * for any site', () => {
    expect(parseCorsOrigins({ CORS_ORIGIN: 'https://payscope.vercel.app, http://localhost:3000' })).toEqual([
      'https://payscope.vercel.app',
      'http://localhost:3000',
    ]);
    expect(parseCorsOrigins({ CORS_ORIGIN: '*' })).toBe('*');
  });

  it.each([
    ['payscope.vercel.app', /not a valid URL/],
    ['https://payscope.vercel.app/', /no path or trailing slash.*https:\/\/payscope\.vercel\.app$/],
    ['https://example.com/app', /no path or trailing slash/],
  ])('rejects %s at startup with a helpful message', (value, message) => {
    expect(() => parseCorsOrigins({ CORS_ORIGIN: value })).toThrow(message);
  });
});

describe('CORS headers', () => {
  const app = createApp(openDb(), { corsOrigins: ['https://payscope.vercel.app'] });

  it('allows the configured site', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://payscope.vercel.app');
    expect(res.headers['access-control-allow-origin']).toBe('https://payscope.vercel.app');
  });

  it('sends no CORS header to other sites, so browsers block them', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the browser preflight for the assistant chat POST (JSON body)', async () => {
    const res = await request(app)
      .options('/api/assistant/chat')
      .set('Origin', 'https://payscope.vercel.app')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://payscope.vercel.app');
    expect(res.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(res.headers['access-control-allow-methods']).toMatch(/PATCH/);
    expect(res.headers['access-control-allow-methods']).toMatch(/DELETE/);
  });

  it('without configured origins, sends no CORS headers at all (same-origin only)', async () => {
    for (const app of [createApp(openDb()), createApp(openDb(), { corsOrigins: [] })]) {
      const res = await request(app).get('/api/health').set('Origin', 'http://localhost:3000');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });
});
