// Typed fetch wrapper (cookie session) + Better Auth actions.
// Prisma browser types are avoided here on purpose: the frontend owns small
// explicit DTOs so backend refactors can't silently shift the UI contract.
import { authClient } from "./auth-client";
import { evictSession } from "./session";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export type Role = "admin" | "doctor" | "ta" | "student";

export interface SessionUser {
  id: string;
  username?: string | null;
  name: string;
  email: string;
  role: Role;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = init?.body instanceof FormData;
  const defaultHeaders: Record<string, string> = {};
  if (!isFormData) {
    defaultHeaders["Content-Type"] = "application/json";
  }
  const r = await fetch(`${API}${path}`, {
    credentials: "include",
    ...init,
    // init.headers must MERGE, not replace: a spread would drop Content-Type
    // whenever callers pass Idempotency-Key / SEB headers.
    headers: { ...defaultHeaders, ...(init?.headers as Record<string, string> ?? {}) },
  });
  // Dead session (expiry) or disabled account: evict the cached user
  // everywhere so guards redirect to /login instead of serving stale identity.
  // 403 "account disabled" is the realtime-kill signal after an admin disable.
  if (r.status === 401) evictSession();
  if (r.status === 403) {
    try {
      const text = await r.clone().text();
      if (text.includes("account disabled")) {
        evictSession();
        window.dispatchEvent(new CustomEvent("account-disabled"));
      }
    } catch {
      // clone/read must never break the error path
    }
  }
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const text = await r.text();
      const parsed = JSON.parse(text);
      msg = parsed.error ?? parsed.message ?? text;
    } catch {
      // not JSON
    }
    throw new ApiError(r.status, msg);
  }
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export const api = {
  // Session truth goes through the backend (requireAuth checks isActive),
  // NOT Better Auth's raw get-session which still returns disabled sessions.
  // Returns null when signed out OR disabled (both redirect to /login).
  getSession: async (): Promise<SessionUser | null> => {
    try {
      const me = await req<SessionUser>("/api/v1/me");
      return me && me.id ? me : null;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return null;
      throw e;
    }
  },
  signIn: (username: string, password: string) =>
    authClient.signIn.username({ username: username.trim().toLowerCase(), password }),
  signOut: () => authClient.signOut(),
  get: <T>(path: string, headers?: Record<string, string>) => req<T>(path, headers ? { headers } : undefined),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    req<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), ...(headers ? { headers } : {}) }),
  patch: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    req<T>(path, { method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body), ...(headers ? { headers } : {}) }),
  delete: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    req<T>(path, { method: "DELETE", body: body === undefined ? undefined : JSON.stringify(body), ...(headers ? { headers } : {}) }),
  upload: <T>(path: string, formData: FormData) =>
    req<T>(path, { method: "POST", body: formData }),
};
