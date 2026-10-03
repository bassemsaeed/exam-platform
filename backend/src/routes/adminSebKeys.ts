import { createHash } from "node:crypto";
import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { audit } from "../lib/audit.js";
import { config } from "../lib/config.js";
import { sealSecret } from "../lib/sebCrypto.js";
import { prisma } from "../lib/prisma.js";
import { invalidateSebCache } from "../middleware/seb.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";

export const adminSebKeys: RouterType = Router();
adminSebKeys.use(requireAuth, requireRole("admin"));

adminSebKeys.get("/", async (_req, res) => {
  res.json(await prisma.sebKey.findMany({ select: { id: true, label: true, isActive: true, createdAt: true }, orderBy: { createdAt: "desc" } }));
});

const keyInput = z.object({ label: z.string().min(2), rawKey: z.string().min(config.seb.minKeyLength) });

// Register a lab key by LABEL + raw key. Stores sha256 (rotation index) AND
// AES-256-GCM sealed raw (for verification). Plaintext never stored.
// Duplicate label/raw is a 409, not a raw 500.
adminSebKeys.post("/", async (req, res) => {
  const { label, rawKey } = keyInput.parse(req.body);
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  try {
    const row = await prisma.sebKey.create({ data: { label, keyHash, encryptedKey: sealSecret(rawKey), isActive: true } });
    invalidateSebCache();
    await audit((req as unknown as AuthedRequest).userId, "seb.register", "seb_key", row.id, { label });
    res.status(201).json({ id: row.id, label, isActive: true });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "label or key already registered" });
    }
    throw e;
  }
});

// Rotate: register the new raw, then deactivate the old row — atomically, so
// a crash can never leave two active keys (or a dead rotation).
adminSebKeys.post("/:id/rotate", async (req, res) => {
  const { label, rawKey } = keyInput.parse(req.body);
  const old = await prisma.sebKey.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ error: "not found" });
  try {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.sebKey.create({
        data: { label, keyHash: createHash("sha256").update(rawKey).digest("hex"), encryptedKey: sealSecret(rawKey), isActive: true },
      });
      await tx.sebKey.update({ where: { id: old.id }, data: { isActive: false } });
      return created;
    });
    invalidateSebCache();
    await audit((req as unknown as AuthedRequest).userId, "seb.rotate", "seb_key", row.id, { from: old.id });
    res.status(201).json({ id: row.id, label });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return res.status(409).json({ error: "label or key already registered" });
    }
    throw e;
  }
});

adminSebKeys.patch("/:id", async (req, res) => {
  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
  const row = await prisma.sebKey.update({ where: { id: req.params.id }, data: { isActive } });
  invalidateSebCache();
  res.json({ id: row.id, isActive: row.isActive });
});
