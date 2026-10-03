import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

function key(): Buffer {
  const hex = process.env.ENCRYPTION_KEY ?? "";
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes as hex (generate: openssl rand -hex 32)");
  return buf;
}

// AES-256-GCM envelope: base64(iv):base64(tag):base64(cipher). Only used for
// SEB Browser Exam Keys — the server must know raws to verify the SEB hash,
// so they rest encrypted (not hashed-only, which made admin registration dead).
export function sealSecret(raw: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

export function openSecret(sealed: string): string {
  const [iv, tag, data] = sealed.split(":");
  if (!iv || !tag || !data) throw new Error("bad sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// Short-lived entry codes (exam hall doors), distinct from SEB device keys:
// sha256 hex is enough — codes live for minutes and are never stored raw.
// Compare with timingSafeEqual so a wrong code yields a flat 403, no oracle.
export function hashEntryCode(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function entryCodeMatches(raw: string, hash: string): boolean {
  const a = Buffer.from(hashEntryCode(raw), "hex");
  let b: Buffer;
  try {
    b = Buffer.from(hash, "hex");
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}
