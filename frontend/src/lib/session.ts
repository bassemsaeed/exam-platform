// Client state (zustand): session mirror for sync access outside React
// (router helpers, SEB utilities) + toast queue. Server truth always comes
// from the session query; this store is only ever written by SessionSync.
import { create } from "zustand";
import type { Role, SessionUser } from "./api";

export type { Role };
export type { SessionUser };

interface AuthState {
  user: SessionUser | null;
  setUser: (u: SessionUser | null) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}));

// Global session eviction (401s, explicit logout): clears the sync mirror
// immediately and the query cache right after. Dynamic import breaks the
// api -> session -> query -> api cycle.
export function evictSession(): void {
  useAuthStore.getState().setUser(null);
  void import("./query").then(({ queryClient, sessionKey }) => {
    queryClient.removeQueries({ queryKey: ["platform"] });
    queryClient.setQueryData(sessionKey, null);
  });
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "warning" | "error";
}

interface ToastState {
  toasts: Toast[];
  push: (message: string, kind?: Toast["kind"]) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;
export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  push: (message, kind = "info") => set((s) => ({ toasts: [...s.toasts.slice(-2), { id: ++toastId, message, kind }] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const homeFor: Record<Role, string> = {
  admin: "/admin",
  doctor: "/doctor",
  ta: "/ta",
  student: "/student",
};
