import { prisma } from "./prisma.js";

export function audit(actorId: string, action: string, entityType: string, entityId: string, metadata?: unknown) {
  return prisma.auditLog.create({ data: { actorId, action, entityType, entityId, metadata: metadata as never } });
}
