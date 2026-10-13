import { Router, type Router as RouterType } from "express";
import { prisma } from "../lib/prisma.js";

export const health: RouterType = Router();
health.get("/health", (_req, res) => res.json({ ok: true }));
health.get("/ready", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false });
  }
});
