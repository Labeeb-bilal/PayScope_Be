import type { RequestHandler } from 'express';

export interface RateLimitOptions {
  /** Requests allowed per window, per client IP. */
  max: number;
  windowMs: number;
  now?: () => number;
}

/**
 * Minimal fixed-window, in-memory rate limiter. Enough for a single-process deployment; with several
 * instances this would move to a shared store (e.g. Redis) or the reverse proxy.
 */
export function rateLimit({ max, windowMs, now = Date.now }: RateLimitOptions): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>();

  return (req, res, next) => {
    const t = now();
    if (windows.size > 10_000) {
      for (const [key, w] of windows) if (t - w.start >= windowMs) windows.delete(key);
    }
    const key = req.ip ?? 'unknown';
    let w = windows.get(key);
    if (!w || t - w.start >= windowMs) {
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    w.count++;
    if (w.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((w.start + windowMs - t) / 1000)));
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many questions. Please wait a minute and try again.' } });
      return;
    }
    next();
  };
}
