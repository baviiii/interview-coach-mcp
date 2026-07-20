import { createHash } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Minimal fixed-window in-memory rate limiter (single instance — enough for
 * one server process; put a shared limiter in front if you ever scale out).
 * Keyed on the hashed Authorization header when present (per user/token),
 * else the client IP.
 */
export function rateLimit(opts: { windowMs: number; max: number }) {
  const windows = new Map<string, Window>();

  // Drop expired windows so the map can't grow unbounded.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
  }, opts.windowMs);
  sweeper.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers["authorization"];
    const key = auth
      ? createHash("sha256").update(auth).digest("hex").slice(0, 16)
      : (req.ip ?? "anon");

    const now = Date.now();
    let w = windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + opts.windowMs };
      windows.set(key, w);
    }
    w.count += 1;

    if (w.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((w.resetAt - now) / 1000)));
      res.status(429).json({
        error: `Rate limit exceeded: max ${opts.max} requests per ${Math.round(opts.windowMs / 1000)}s`,
      });
      return;
    }
    next();
  };
}
