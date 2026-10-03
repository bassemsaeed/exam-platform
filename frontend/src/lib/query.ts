// Server state: TanStack Query is the single cache for everything from the
// API (session, exams, banks, results). No ad-hoc fetch in components.
// Window-focus refetch is OFF: an exam runner must never revalidate mid-exam;
// screens refetch on mount and on explicit invalidate.
import { QueryClient, useQuery } from "@tanstack/react-query";
import { api, type SessionUser } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export const sessionKey = ["session"] as const;

export function useSessionUser() {
  return useQuery<SessionUser | null>({
    queryKey: sessionKey,
    queryFn: api.getSession,
    staleTime: 30_000,
    // Realtime kill-switch: a disable revokes sessions server-side, so the
    // next poll 403s → evict → RequireAuth drops to /login within ~20s.
    // Cheap (one tiny row) and safe for exam screens (no focus refetch).
    refetchInterval: 20_000,
    retry: false,
  });
}

export function refreshSession() {
  return queryClient.invalidateQueries({ queryKey: sessionKey });
}
