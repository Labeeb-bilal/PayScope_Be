import cors from 'cors';
import type { RequestHandler } from 'express';

/** Browser origins allowed to call the API cross-origin, or '*' for any. */
export type CorsOrigins = string[] | '*';

/**
 * CORS_ORIGIN, set per environment (.env.development for dev, host settings or .env.production for prod):
 * comma-separated origins (scheme + host + optional port, no path), e.g.
 * "https://payscope.vercel.app,https://staging.example.com", or "*" to allow any site.
 * Unset: no cross-origin access at all (only same-origin, i.e. the UI served by this API). There is
 * deliberately no hard-coded default, so what is allowed is always visible in the environment.
 * Invalid values throw at startup, because a wrong origin otherwise fails silently in the browser.
 */
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

/** CORS middleware that only answers listed origins; other sites get no CORS headers, so browsers block them. */
export function corsMiddleware(origins: CorsOrigins): RequestHandler {
  return cors({ origin: origins === '*' ? '*' : origins, maxAge: 600 });
}
