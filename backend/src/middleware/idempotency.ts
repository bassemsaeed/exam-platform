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

const MAX_STORE_ENTRIES = 10_000;
const MAX_KEY_LEN = 128;
const LOCK_TTL_SEC = 30;
const store = new Map<string, CachedResponse>();
const inFlight = new Set<string>();

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
  if (store.size >= MAX_STORE_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(cacheKey, entry);
}

async function acquireLock(lockKey: string): Promise<boolean> {
  try {
    const r = await redis();
    if (r) {
      const ok = await r.set(lockKey, "1", "EX", LOCK_TTL_SEC, "NX");
      return ok === "OK";
    }
  } catch {
    // fall through to memory
  }
  if (inFlight.has(lockKey)) return false;
  inFlight.add(lockKey);
  return true;
}

async function releaseLock(lockKey: string): Promise<void> {
  inFlight.delete(lockKey);
  try {
    const r = await redis();
    if (r) await r.del(lockKey);
  } catch {
    // lock expires via TTL
  }
}

export function idempotency(req: Request, res: Response, next: NextFunction) {
  const rawKey = req.header("Idempotency-Key");
  if (!rawKey) return next();
  const idKey = rawKey.trim();
  if (!idKey || idKey.length > MAX_KEY_LEN) {
    return res.status(400).json({ error: "invalid Idempotency-Key" });
  }

  void (async () => {
    const userId = (req as unknown as AuthedRequest).userId || req.ip || "anon";
    const cacheKey = `idem:${userId}:${req.method}:${req.baseUrl}${req.path}:${idKey}`;
    const lockKey = `${cacheKey}:lock`;

    const cached = await readCache(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      res.setHeader("Idempotent-Replay", "true");
      return res.status(cached.status).json(cached.body);
    }

    const locked = await acquireLock(lockKey);
    if (!locked) {
      // Another identical request is already in flight.
      const raced = await readCache(cacheKey);
      if (raced && Date.now() < raced.expiresAt) {
        res.setHeader("Idempotent-Replay", "true");
        return res.status(raced.status).json(raced.body);
      }
      return res.status(409).json({ error: "request with this Idempotency-Key is already in progress" });
    }

    let released = false;
    const cleanup = () => {
      if (released) return;
      released = true;
      void releaseLock(lockKey);
    };
    res.on("finish", cleanup);
    res.on("close", cleanup);

    // Intercept json() to cache 2xx responses before sending.
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
