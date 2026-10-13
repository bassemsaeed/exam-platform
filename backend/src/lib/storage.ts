import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

export interface StoredFile {
  key: string;
  url: string;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function contentTypeFor(filename: string): string {
  return MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

// Magic-byte image sniffing: extensions and client-supplied MIME are
// attacker-controlled, so polyglot files (HTML/SVG renamed to .png) must be
// rejected by content. Served from same-origin /uploads, a stored script
// could otherwise run in the app's origin.
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: ".png", mime: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: ".jpg", mime: "image/jpeg" };
  }
  if (buf.length >= 6 && (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")) {
    return { ext: ".gif", mime: "image/gif" };
  }
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { ext: ".webp", mime: "image/webp" };
  }
  return null;
}

function keyFor(prefix: string, filename: string, buf: Buffer): string {
  if (prefix.includes("..")) throw new Error("path traversal forbidden");
  const safePrefix = prefix
    .split("/")
    .map((seg) => seg.replace(/[^a-zA-Z0-9_.-]/g, "_"))
    .filter(Boolean)
    .join("/");
  const safe = filename.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  return `${safePrefix}/${hash}-${safe}`;
}

export interface Storage {
  put(prefix: string, filename: string, buf: Buffer): Promise<StoredFile>;
  delete(key: string): Promise<void>;
  readonly publicBase: string; // served prefix for local driver ("" when S3)
}

class LocalStorage implements Storage {
  readonly publicBase = "/uploads";
  private dir: string;

  constructor() {
    this.dir = localUploadsDir();
  }

  async put(prefix: string, filename: string, buf: Buffer): Promise<StoredFile> {
    const key = keyFor(prefix, filename, buf);
    // Path-traversal containment: subject codes / filenames are attacker-shaped
    // (admin input, Excel imports). Resolve and verify the destination stays
    // inside the uploads root before touching the filesystem.
    const dest = resolve(join(this.dir, key));
    if (dest !== resolve(this.dir) && !dest.startsWith(resolve(this.dir) + "/")) {
      throw new Error("path traversal forbidden");
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    return { key, url: `${this.publicBase}/${key}` };
  }

  async delete(key: string): Promise<void> {
    if (key.includes("..")) throw new Error("path traversal forbidden");
    const dest = resolve(join(this.dir, key));
    if (dest !== resolve(this.dir) && !dest.startsWith(resolve(this.dir) + "/")) {
      throw new Error("path traversal forbidden");
    }
    const { rm } = await import("node:fs/promises");
    await rm(dest, { force: true });
  }
}

class S3Storage implements Storage {
  readonly publicBase = "";
  private client: S3Client;
  private bucket: string;
  private base: string;

  constructor() {
    const s = config.storage;
    this.client = new S3Client({
      region: s.s3Region,
      endpoint: s.s3Endpoint,
      credentials: { accessKeyId: s.s3AccessKey, secretAccessKey: s.s3SecretKey },
      forcePathStyle: true,
    });
    this.bucket = s.s3Bucket;
    this.base = (s.s3PublicUrl || `${s.s3Endpoint}/${s.s3Bucket}`).replace(/\/$/, "");
  }

  async put(prefix: string, filename: string, buf: Buffer): Promise<StoredFile> {
    const key = keyFor(prefix, filename, buf);
    // Serve the sniffed image type, not the claimed extension: a renamed
    // payload must never be stored or served as something it isn't.
    const contentType = sniffImage(buf)?.mime ?? contentTypeFor(filename);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buf, ContentType: contentType }),
    );
    return { key, url: `${this.base}/${key}` };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

export const storage: Storage = config.storage.s3Endpoint ? new S3Storage() : new LocalStorage();

export function isLocalStorage(): boolean {
  return !config.storage.s3Endpoint;
}

export function localUploadsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // src/lib
  return config.storage.dir || resolve(here, "..", "..", "uploads");
}
