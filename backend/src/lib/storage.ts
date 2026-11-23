import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
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
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
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

// Magic-byte audio/video sniffing for pre-exam briefing media. Rejects HTML/JS/
// executables masquerading as media files before anything touches storage.
export function sniffMedia(
  buf: Buffer,
  hint?: "audio" | "video",
): { kind: "audio" | "video"; ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  // WAV: RIFF....WAVE
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    return { kind: "audio", ext: ".wav", mime: "audio/wav" };
  }
  // OGG (Opus/Vorbis/Theora): OggS
  if (buf.toString("ascii", 0, 4) === "OggS") {
    const kind = hint === "video" ? "video" : "audio";
    return { kind, ext: ".ogg", mime: kind === "video" ? "video/ogg" : "audio/ogg" };
  }
  // MP3: ID3 tag or MPEG audio frame sync
  if (
    buf.toString("ascii", 0, 3) === "ID3" ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0)
  ) {
    return { kind: "audio", ext: ".mp3", mime: "audio/mpeg" };
  }
  // WebM / Matroska (EBML header: 1A 45 DF A3) — browser MediaRecorder outputs
  // both audio/webm and video/webm with this header.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    const kind = hint === "audio" ? "audio" : "video";
    return { kind, ext: ".webm", mime: kind === "audio" ? "audio/webm" : "video/webm" };
  }
  // ISO BMFF (MP4 / M4A / MOV): bytes 4..8 === "ftyp"
  if (buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (brand === "M4A " || brand === "M4B " || hint === "audio") {
      return { kind: "audio", ext: ".m4a", mime: "audio/mp4" };
    }
    if (brand === "qt  ") {
      return { kind: "video", ext: ".mov", mime: "video/quicktime" };
    }
    return { kind: "video", ext: ".mp4", mime: "video/mp4" };
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
  keyFromUrl(url: string): string | null;
  readonly publicBase: string; // served prefix for local driver ("" when S3)
}

class LocalStorage implements Storage {
  readonly publicBase = "/uploads";
  private dir: string;

  constructor() {
    this.dir = localUploadsDir();
  }

  keyFromUrl(url: string): string | null {
    return url.startsWith(`${this.publicBase}/`) ? url.slice(this.publicBase.length + 1) : null;
  }

  async put(prefix: string, filename: string, buf: Buffer): Promise<StoredFile> {
    const key = keyFor(prefix, filename, buf);
    // Path-traversal containment: subject codes / filenames are attacker-shaped
    // (admin input, Excel imports). Resolve and verify the destination stays
    // inside the uploads root before touching the filesystem.
    const root = resolve(this.dir);
    const dest = resolve(join(root, key));
    const rel = relative(root, dest);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("path traversal forbidden");
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    return { key, url: `${this.publicBase}/${key}` };
  }

  async delete(key: string): Promise<void> {
    if (key.includes("..")) throw new Error("path traversal forbidden");
    const root = resolve(this.dir);
    const dest = resolve(join(root, key));
    const rel = relative(root, dest);
    if (rel.startsWith("..") || isAbsolute(rel)) {
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

  keyFromUrl(url: string): string | null {
    return url.startsWith(`${this.base}/`) ? url.slice(this.base.length + 1) : null;
  }

  async put(prefix: string, filename: string, buf: Buffer): Promise<StoredFile> {
    const key = keyFor(prefix, filename, buf);
    // Serve the sniffed content type, not the claimed extension: a renamed
    // payload must never be stored or served as something it isn't.
    const contentType = sniffImage(buf)?.mime ?? sniffMedia(buf)?.mime ?? contentTypeFor(filename);
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
