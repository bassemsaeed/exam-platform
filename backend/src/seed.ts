import { createHash } from "node:crypto";
import { ROLE_DEFAULTS, type PermissionKey } from "./lib/domain.js";
import { assertSeedAllowed } from "./lib/seedGuard.js";
import { config } from "./lib/config.js";
import { prisma } from "./lib/prisma.js";
import { sealSecret } from "./lib/sebCrypto.js";

// Seeds: permission matrix (single source: domain.ts), current term, SEB key
// hashes from SEB_BOOTSTRAP_KEYS. Run once: pnpm seed. Rerunnable (upserts).
async function main() {
  assertSeedAllowed("seed");
  for (const [role, keys] of Object.entries(ROLE_DEFAULTS) as [string, PermissionKey[]][]) {
    for (const permissionKey of keys) {
      await prisma.permissionDefault.upsert({
        where: { role_permissionKey: { role: role as never, permissionKey } },
        update: { allowed: true },
        create: { role: role as never, permissionKey, allowed: true },
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    // Clear-then-set inside one transaction: with the single-current partial
    // unique index, setting a new current without clearing the old one 409s —
    // and re-running seed after a make-current must not leave two currents.
    await tx.term.updateMany({ where: { isCurrent: true, name: { not: config.seed.termName } }, data: { isCurrent: false } });
    await tx.term.upsert({
      where: { name: config.seed.termName },
      update: { isCurrent: true, startsOn: new Date(config.seed.termStart), endsOn: new Date(config.seed.termEnd) },
      create: {
        name: config.seed.termName,
        startsOn: new Date(config.seed.termStart),
        endsOn: new Date(config.seed.termEnd),
        isCurrent: true,
      },
    });
  });

  for (const [index, raw] of config.seb.bootstrapKeys.entries()) {
    const label = `bootstrap-lab-${index + 1}`;
    const keyHash = createHash("sha256").update(raw).digest("hex");
    // Rotation-idempotent: upsert by stable label, not by keyHash. Rotating
    // SEB_BOOTSTRAP_KEYS updates the stored hash in place instead of
    // orphaning the old row and violating the label unique constraint.
    await prisma.sebKey.upsert({
      where: { label },
      update: { keyHash, isActive: true, encryptedKey: sealSecret(raw) },
      create: { label, keyHash, encryptedKey: sealSecret(raw), isActive: true },
    });
  }
  console.log("seed ok");
}
await main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
