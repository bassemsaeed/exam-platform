import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../lib/config.js";
import { prisma } from "../lib/prisma.js";
import { openSecret } from "../lib/sebCrypto.js";

// Keyring = env bootstrap raws (whose sha256 is registered+active) + raws
// decrypted from seb_key.encrypted_key. Hashes alone can never verify —
/// that was the dead-admin-key bug. Decrypt failures fail closed per row.
// Keys are near-static: cached in memory with a short TTL (rotation worst-case
// delay = SEB_CACHE_MS) so a 5k start storm doesn't pay a DB round-trip +
// AES-GCM decrypt per request. Mutations must call invalidateSebCache().

let keyCache: { keys: string[]; exp: number } | null = null;

export function invalidateSebCache(): void {
  keyCache = null;
}

async function activeRawKeys(): Promise<string[]> {
  if (keyCache && Date.now() < keyCache.exp) return keyCache.keys;
  const rows = await prisma.sebKey.findMany({ where: { isActive: true } });
  const registered = new Set(rows.map((k) => k.keyHash));
  const out: string[] = [];
  for (const raw of config.seb.bootstrapKeys) {
    if (registered.has(createHash("sha256").update(raw).digest("hex"))) out.push(raw);
  }
  for (const row of rows) {
    if (!row.encryptedKey) continue;
    try {
      out.push(openSecret(row.encryptedKey));
    } catch {
      continue;
    }
  }
  keyCache = { keys: out, exp: Date.now() + config.sebCacheMs };
  return out;
}

export async function requireSeb(req: Request, res: Response, next: NextFunction) {
  // Safe Exam Browser is no longer required: exams can be opened in a normal
  // browser. Keep this middleware as a pass-through for existing route wiring.
  return next();
}
