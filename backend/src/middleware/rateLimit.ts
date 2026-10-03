import type { NextFunction, Request, Response } from "express";
import type { AuthedRequest } from "./auth.js";
import { redis } from "../lib/redis.js";

// Token bucket: Redis cluster-wide when REDIS_URL is set, in-process Map
// otherwise (single-server dev). Keyed by authenticated user when known: an
// entire computer lab behind one NAT IP must not share a single bucket.
const buckets = new Map<string, { count: number; reset: number }>();

// Evict expired buckets so the map can't grow with unique ip:path keys.
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets.entries()) {
    if (now > b.reset) buckets.delete(key);
  }
}, 5 * 60_000).unref();

export function rateLimit(max: number, windowMs: number, scope?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const actor = (req as unknown as AuthedRequest).userId ?? req.ip ?? "anon";
    // Explicit scope groups a logical operation across URL variants: per-exam
    // path keys let callers multiply the budget by rotating exam IDs.
    const key = `rl:${actor}:${scope ?? `${req.baseUrl}${req.path}`}`;
    // Cluster path: INCR + first-hit expiry = fixed-window counter shared by
    // every app instance behind the LB. Fail-closed to memory on redis errors
    // so a cache blip never 500s an exam start.
    try {
      const r = await redis();
      if (r) {
        const count = await r.incr(key);
        if (count === 1) await r.pexpire(key, windowMs);
        if (count > max) return res.status(429).json({ error: "too many requests" });
        return next();
      }
    } catch {
      // fall through to memory bucket
    }
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.reset) {
      buckets.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++b.count > max) return res.status(429).json({ error: "too many requests" });
    next();
  };
}
