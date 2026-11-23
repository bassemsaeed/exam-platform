import { config } from "./config.js";

type RedisClient = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  publish(channel: string, message: string): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  duplicate(): RedisClient;
  disconnect(): void;
};

// Lazy singleton: empty REDIS_URL = single-server in-process mode (no
// connection attempted). When set, ioredis is dynamically imported so dev
// installs without a server never pay the connection cost.
let client: RedisClient | null = null;
let connecting: Promise<RedisClient | null> | null = null;
let retryAfter = 0;
let warned = false;
const RETRY_COOLDOWN_MS = 15_000;

export async function redis(): Promise<RedisClient | null> {
  if (!config.redis.url) return null;
  if (client) return client;
  if (Date.now() < retryAfter) return null;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const mod = await import("ioredis");
      const Ctor = (mod.default ?? mod) as unknown as new (
        url: string,
        opts: object,
      ) => RedisClient & { connect(): Promise<void> };
      const c = new Ctor(config.redis.url, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        lazyConnect: true,
      });
      // Prevent unhandled EventEmitter 'error' events from crashing Node.
      c.on("error", () => {});
      // Best-effort connect; failures fall back to memory with one warning.
      // Loud on purpose: the fallback splits rate-limit buckets and the SSE bus
      // per instance, so limits become bypassable and broadcasts stay local.
      try {
        await c.connect();
      } catch {
        c.disconnect();
        retryAfter = Date.now() + RETRY_COOLDOWN_MS;
        if (!warned) {
          warned = true;
          console.warn(
            "redis unavailable, falling back to in-process stores: rate limits are per-instance and SSE fan-out is local-only",
          );
        }
        return null;
      }
      client = c;
      return client;
    } catch {
      retryAfter = Date.now() + RETRY_COOLDOWN_MS;
      if (!warned) {
        warned = true;
        console.warn("ioredis not installed or redis unreachable, using in-process stores");
      }
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

export function redisSync(): RedisClient | null {
  return client;
}
