import cors from 'cors';
import type { RequestHandler } from 'express';

export type CorsOrigins = string[] | '*';

export function parseCorsOrigins(env: NodeJS.ProcessEnv = process.env): CorsOrigins {
  const raw = env.CORS_ORIGIN?.trim();
  if (!raw) return [];
  if (raw === '*') return '*';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((origin) => {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error(`CORS_ORIGIN: "${origin}" is not a valid URL. Use e.g. https://payscope.vercel.app`);
      }
      if (parsed.origin !== origin) {
        throw new Error(`CORS_ORIGIN: "${origin}" must be an origin only (no path or trailing slash), e.g. ${parsed.origin}`);
      }
      return origin;
    });
}

export function corsMiddleware(origins: CorsOrigins): RequestHandler {
  return cors({ origin: origins === '*' ? '*' : origins, maxAge: 600 });
}
