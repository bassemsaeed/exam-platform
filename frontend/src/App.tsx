import { useState, type FormEvent } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "./lib/api";
import { queryClient, refreshSession, useSessionUser } from "./lib/query";
import { sebEnabled } from "./lib/seb";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

function Starter() {
  const { data: user, isLoading, error } = useSessionUser();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoginError(null);
    try {
      const r = await api.signIn(username, password);
      if (r.error) {
        const err = r.error as { message?: string };
        setLoginError(err.message ?? "Sign-in failed.");
        return;
      }
      await refreshSession();
    } catch (err) {
      setLoginError(err instanceof ApiError ? err.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    await api.signOut();
    await refreshSession();
  }

  return (
    <main>
      <h1>Exam Platform — API client starter</h1>
      <p>
        Backend: <code>{API}</code>
        <br />
        SEB dev header: <code>{sebEnabled ? "enabled" : "not set"}</code>
      </p>

      {isLoading ? (
        <p>Checking session…</p>
      ) : error ? (
        <p className="error">Backend unreachable. Start it with `pnpm --filter backend dev`.</p>
      ) : user ? (
        <section>
          <p>
            Signed in as <strong>{user.username ?? user.name}</strong> ({user.role})
          </p>
          <pre>{JSON.stringify(user, null, 2)}</pre>
          <button type="button" onClick={onLogout}>
            Sign out
          </button>
        </section>
      ) : (
        <form onSubmit={onLogin}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
            autoComplete="username"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password"
            autoComplete="current-password"
          />
          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {loginError ? <p className="error">{loginError}</p> : null}
        </form>
      )}

      <p>
        Contract: <code>src/lib/auth-client.ts</code>, <code>src/lib/api.ts</code>,{" "}
        <code>src/lib/query.ts</code>, <code>src/lib/session.ts</code>, <code>src/lib/seb.ts</code>.
        Build your own pages/components on top — nothing else is required from the old
        frontend.
      </p>
    </main>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Starter />
    </QueryClientProvider>
  );
}
