import type { NextFunction, Request, Response } from "express";
import { config } from "../lib/config.js";
import { redis } from "../lib/redis.js";
import type { AuthedRequest } from "./auth.js";

// Idempotency store: Redis cluster-wide when REDIS_URL is set (SET ... EX NX),
// in-process Map otherwise (single-server dev). Keyed by user+method+path+key.
// Only 2xx is cached: error responses (e.g. submit 409 "unanswered questions
// remain") must NOT stick — the client retries the same key after answering
// and must reach the handler again.
interface CachedResponse {
  status: number;
  body: unknown;
  expiresAt: number;
}

const store = new Map<string, CachedResponse>();

// Periodic eviction of expired idempotency keys
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, 5 * 60_000).unref();

async function readCache(cacheKey: string): Promise<CachedResponse | null> {
  try {
    const r = await redis();
    if (r) {
      const raw = await r.get(cacheKey);
      if (!raw) return null;
      return JSON.parse(raw) as CachedResponse;
    }
  } catch {
    // fall through to memory
  }
  const entry = store.get(cacheKey) ?? null;
  if (entry && Date.now() > entry.expiresAt) {
    store.delete(cacheKey);
    return null;
  }
  return entry;
}

async function writeCache(cacheKey: string, entry: CachedResponse): Promise<void> {
  const ttlSec = Math.max(1, Math.ceil(config.idempotencyTtlMs / 1000));
  try {
    const r = await redis();
    if (r) {
      await r.set(cacheKey, JSON.stringify(entry), "EX", ttlSec, "NX");
      return;
    }
  } catch {
    // fall through to memory
  }
  store.set(cacheKey, entry);
}

export function idempotency(req: Request, res: Response, next: NextFunction) {
  const idKey = req.header("Idempotency-Key");
  if (!idKey) return next();

  void (async () => {
    const userId = (req as unknown as AuthedRequest).userId || req.ip || "anon";
    const cacheKey = `idem:${userId}:${req.method}:${req.baseUrl}${req.path}:${idKey}`;

    const cached = await readCache(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      res.setHeader("Idempotent-Replay", "true");
      return res.status(cached.status).json(cached.body);
    }

    // Intercept json() to cache the response before sending.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void writeCache(cacheKey, {
          status: res.statusCode,
          body,
          expiresAt: Date.now() + config.idempotencyTtlMs,
        });
      }
      return originalJson(body);
    };

    next();
  })().catch(next);
}
