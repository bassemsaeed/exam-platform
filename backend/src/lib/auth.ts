import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { username } from "better-auth/plugins";
import { config } from "./config.js";
import { prisma } from "./prisma.js";

// Excel is the source of truth: usernames come from import, login by username.
// Email is synthesized as <username>@<placeholder domain> because emailAndPassword
// (required by the username plugin) mandates an email column. Passwords live in Account.
export const auth = betterAuth({
  baseURL: config.authUrl,
  secret: config.authSecret,
  trustedOrigins: config.frontendOrigins,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  // Second rate-limit layer, inside the auth handler: strict per-path budgets
  // so credential stuffing trips at 10/min/IP long before the outer 60/min
  // blanket. Memory store = single-server (same documented limit as the
  // in-process buckets). IP resolution honors AUTH_TRUSTED_PROXY_CIDRS only.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: "memory",
    customRules: {
      "/sign-in/*": { window: 60, max: 10 },
      "/change-password": { window: 60, max: 10 },
    },
  },
  advanced: {
    database: { joins: true }, // 2-3x faster get-session (researched)
    ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: config.authProxyCidrs },
  },
  emailAndPassword: { enabled: true, autoSignIn: true, requireEmailVerification: false, disableSignUp: true },
  plugins: [
    username({
      displayUsername: false, // no extra column; username only
      usernameValidator: (u) => /^[a-zA-Z0-9_.-]+$/.test(u),
    }),
  ],
  databaseHooks: {
    user: {
      // Usernames are case-insensitive identity: normalize every creation path
      // (prevents John_Doe vs john_doe duplicates; import already lowercases).
      create: {
        async before(user) {
          const u = user as unknown as Record<string, unknown>;
          if (typeof u["username"] === "string") {
            return { data: { ...u, username: (u["username"] as string).toLowerCase() } };
          }
        },
      },
    },
    session: {
      // Disabled accounts can never hold a session: returning false aborts
      // the create, so sign-in as a deactivated user fails instead of
      // minting a cookie that requireAuth would 403 on every call.
      create: {
        async before(session) {
          const s = session as unknown as Record<string, unknown>;
          const userId = typeof s["userId"] === "string" ? (s["userId"] as string) : null;
          if (!userId) return;
          try {
            const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true } });
            if (!u || !u.isActive) {
              try {
                await prisma.auditLog.create({
                  data: { actorId: userId, action: "auth.signin-blocked", entityType: "user", entityId: userId, metadata: { reason: "account disabled" } },
                });
              } catch {
                // audit must never break auth
              }
              return false;
            }
          } catch {
            // DB blip: fail closed (no session) rather than minting one we cannot vet.
            return false;
          }
        },
        async after(session) {
          const s = session as unknown as Record<string, unknown>;
          const userId = typeof s["userId"] === "string" ? (s["userId"] as string) : null;
          if (!userId) return;
          try {
            await prisma.auditLog.create({
              data: { actorId: userId, action: "auth.signin", entityType: "user", entityId: userId },
            });
          } catch {
            // audit must never break auth
          }
        },
      },
    },
  },
  user: {
    // All server-owned: Excel import / admin set them via Prisma, never the client.
    // input:false is load-bearing — without it anyone could sign up as admin.
    additionalFields: {
      role: { type: "string", required: true, defaultValue: "student", input: false },
      canChangePassword: { type: "boolean", required: true, defaultValue: true, input: false },
      isActive: { type: "boolean", required: true, defaultValue: true, input: false },
      departmentId: { type: "string", required: false, input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * config.sessionHours, // lab day default — forces daily re-login
    // Sliding window for ACTIVE users: hourly activity pushes expiry out, so a
    // long exam day never kills a session mid-attempt. Idle users still expire.
    updateAge: 60 * 60 * 6,
  },
});
