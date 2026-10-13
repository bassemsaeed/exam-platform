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
  const sent = req.header(config.seb.header);
  if (!sent) return res.status(403).json({ error: "Please open this exam from Safe Exam Browser." });

  const raws = await activeRawKeys();
  if (raws.length === 0) return res.status(500).json({ error: "SEB keys not configured" });

  // req.protocol respects trust-proxy setting in index.ts — must be https
  // behind TLS-terminating proxies or every hash mismatches.
  // Host is client-supplied: validate its shape and fall back to the
  // configured public URL when missing/invalid instead of hashing garbage.
  const rawHost = req.get("host");
  const host = rawHost && /^[A-Za-z0-9.:-]+$/.test(rawHost) ? rawHost : null;
  const base = host ? `${req.protocol}://${host}` : config.authUrl.replace(/\/+$/, "");
  const url = `${base}${req.originalUrl}`;
  if (!/^[0-9a-fA-F]+$/.test(sent) || sent.length % 2 !== 0) {
    return res.status(403).json({ error: "Please open this exam from Safe Exam Browser." });
  }
  const got = Buffer.from(sent, "hex");
  const ok = raws.some((raw) => {
    const expect = createHash("sha256").update(url + raw).digest();
    return got.length === expect.length && timingSafeEqual(got, expect);
  });
  if (!ok) return res.status(403).json({ error: "Please open this exam from Safe Exam Browser." });
  next();
}
