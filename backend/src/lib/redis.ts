import { config } from "./config.js";

type RedisClient = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  duplicate(): RedisClient;
};

// Lazy singleton: empty REDIS_URL = single-server in-process mode (no
// connection attempted). When set, ioredis is dynamically imported so dev
// installs without a server never pay the connection cost.
let client: RedisClient | null = null;
let warned = false;

export async function redis(): Promise<RedisClient | null> {
  if (!config.redis.url) return null;
  if (client) return client;
  try {
    const mod = await import("ioredis");
    const Ctor = (mod.default ?? mod) as unknown as new (url: string, opts: object) => RedisClient & { connect(): Promise<void> };
    const c = new Ctor(config.redis.url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    // Best-effort connect; failures fall back to memory with one warning.
    // Loud on purpose: the fallback splits rate-limit buckets and the SSE bus
    // per instance, so limits become bypassable and broadcasts stay local.
    try {
      await c.connect();
    } catch {
      if (!warned) {
        warned = true;
        console.warn("redis unavailable, falling back to in-process stores: rate limits are per-instance and SSE fan-out is local-only");
      }
      return null;
    }
    client = c;
    return client;
  } catch {
    if (!warned) {
      warned = true;
      console.warn("ioredis not installed or redis unreachable, using in-process stores");
    }
    return null;
  }
}

export function redisSync(): RedisClient | null {
  return client;
}
