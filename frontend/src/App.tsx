import {
  verifyDemoPassword,
  demoPasswordChanged,
  resetDemoPassword,
} from "./lib/demo-auth";
import { AccountHelp } from "./pages/Enhancements";
import { useT } from "./lib/i18n";
import { BrowserRouter, HashRouter, Navigate, useLocation, useNavigate } from "react-router-dom";
import Workspace from "./Workspace";
import { Preferences } from "./components/Preferences";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { api, ApiError, type SessionUser } from "./lib/api";
import { queryClient, sessionKey } from "./lib/query";
import { useAuthStore } from "./lib/session";
// Demo sessions are deliberately separate from authenticated API sessions.
const demo = import.meta.env.VITE_PREVIEW_MODE === "true";
const demoKey = "exam-platform-preview-session";
const savedUsernameKey = "exam-platform-remembered-username";
const demoUser: SessionUser = {
  id: "preview-student",
  name: "Alex Morgan",
  username: "alex.morgan",
  email: "alex.morgan@example.edu",
  role: "student",
};
function readDemoSession(): SessionUser | null {
  try {
    const role = (sessionStorage.getItem("exam-platform-preview-role") ??
      "student") as SessionUser["role"];
    const names = {
      student: "Alex Morgan",
      doctor: "Dr. Ahmed Hassan",
      ta: "Mariam Ali",
      admin: "O6U Administrator",
    };
    return sessionStorage.getItem(demoKey) === "signed-in"
      ? {
          ...demoUser,
          id: "preview-" + role,
          role,
          name: names[role] ?? demoUser.name,
        }
      : null;
  } catch {
    return null;
  }
}
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    arrow: (
      <>
        <path d="M5 12h14M13 6l6 6-6 6" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    hidden: (
      <>
        <path d="m3 3 18 18M10.5 5.1C17.5 4 22 12 22 12a20 20 0 0 1-3.1 3.9M6.2 6.2A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.7-1.5M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="3" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    book: (
      <>
        <path d="M3 4c5-1 9 2 9 2s4-3 9-2v15c-5-1-9 2-9 2s-4-3-9-2V4ZM12 6v15" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01" />
      </>
    ),
    alert: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 17h.01" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    logout: (
      <>
        <path d="M9 4H4v16h5M9 12h12m-5-5 5 5-5 5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.book}
    </svg>
  );
}
function Brand() {
  const t = useT();
  return (
    <a
      className="brand"
      href="/"
      aria-label={t("October 6 University exam portal")}
    >
      <img
        src="/o6u-logo.png"
        alt={t("October 6 University")}
        width="280"
        height="120"
      />
    </a>
  );
}
function Modal({
  onClose,
  kind,
}: {
  onClose: () => void;
  kind: "access" | "password";
}) {
  return <AccountHelp onClose={onClose} initialKind={kind} />;
}
function Login() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  // Deep link to restore after sign-in (unauthenticated visits land on /login).
  const from = (location.state as { from?: string } | null)?.from;
  const [username, setUsername] = useState(() => {
    try {
      return localStorage.getItem(savedUsernameKey) ?? "";
    } catch {
      return "";
    }
  });
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(() => Boolean(username));
  const [help, setHelp] = useState<"access" | "password" | null>(null);
  const [capsLock, setCapsLock] = useState(false);
  const [validation, setValidation] = useState<{
    username?: string;
    password?: string;
  }>({});
  const [logoutError, setLogoutError] = useState("");
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const session = useQuery({
    queryKey: sessionKey,
    queryFn: demo ? async () => readDemoSession() : api.getSession,
    retry: false,
    refetchInterval: demo ? false : 20000,
  });
  const setUser = useAuthStore((s) => s.setUser);
  useEffect(() => {
    setUser(session.data ?? null);
  }, [session.data, setUser]);
  const login = useMutation({
    mutationFn: async () => {
      if (demo) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        if (!(await verifyDemoPassword(username, password)))
          throw new Error(
            "That username or password isn’t quite right. Please try again.",
          );
        sessionStorage.setItem(demoKey, "signed-in");
        sessionStorage.setItem("exam-platform-preview-role", "student");
        return demoUser;
      }
      const result = await api.signIn(username, password);
      if (result.error) {
        if (result.error.status === 429)
          throw new Error(
            "Too many sign-in attempts. Please wait a minute and try again.",
          );
        throw new Error(
          "That username or password isn’t quite right. Please try again.",
        );
      }
      const user = await api.getSession();
      if (!user)
        throw new Error(
          "Your account is unavailable. Please contact your exam administrator.",
        );
      return user;
    },
    onSuccess: (user) => {
      // Navigate FIRST, before the cache update re-renders Workspace:
      // otherwise the catch-all route bounces /login to / and wins the race.
      navigate(from && from.startsWith("/") ? from : "/", { replace: true });
      // Never persist a password or cache an authenticated identity on disk.
      try {
        if (remember) localStorage.setItem(savedUsernameKey, username.trim());
        else localStorage.removeItem(savedUsernameKey);
      } catch {
        /* Optional preference */
      }
      queryClient.clear();
      queryClient.setQueryData(sessionKey, user);
      setPassword("");
    },
  });
  const logout = useMutation({
    mutationFn: async () => {
      if (demo) sessionStorage.removeItem(demoKey);
      else {
        const response = await api.signOut();
        if (response.error)
          throw new Error("We couldn’t sign you out. Please try again.");
      }
    },
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(sessionKey, null);
      setUser(null);
      login.reset();
      setLogoutError("");
      // Never linger on a protected URL after sign-out.
      navigate("/login", { replace: true });
    },
    onError: () =>
      setLogoutError("We couldn’t sign you out. Please try again."),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const errors = {
      username: username.trim() ? undefined : "Enter your university username.",
      password: password ? undefined : "Enter your password.",
    };
    setValidation(errors);
    if (errors.username) {
      usernameRef.current?.focus();
      return;
    }
    if (errors.password) {
      passwordRef.current?.focus();
      return;
    }
    login.mutate();
  }
  const errorMessage =
    login.error instanceof ApiError
      ? login.error.message
      : login.error instanceof TypeError
        ? "We couldn’t reach the server. Check your connection and try again."
        : login.error?.message;
  if (session.data)
    return (
      <Workspace
        user={session.data}
        onLogout={() => logout.mutate()}
        logoutBusy={logout.isPending}
        logoutError={logoutError}
      />
    );
  // While the session is being restored (refresh), show a branded splash —
  // never the sign-in form, so authenticated users don't see a login flicker.
  if (session.isPending && !session.isError)
    return (
      <main className="login-layout">
        <div className="boot-splash" role="status" aria-label={t("Loading")}>
          <img src="/o6u-logo.png" alt={t("October 6 University")} />
          <span className="spinner" aria-hidden="true" />
          <p>{t("Checking session…")}</p>
        </div>
      </main>
    );
  // Any unauthenticated visit (deep link, expired session, post-logout)
  // normalizes to /login instead of rendering the form at a stale URL.
  if (!session.data && !session.isPending && location.pathname !== "/login")
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <main className="login-layout">
      <header className="site-header">
        <Brand />
        <div className="login-header-tools">
          <span className="portal-title">{t("Examination Portal")}</span>
          <Preferences />
        </div>
      </header>
      <section className="form-panel">
        <div className="form-center">
          <>
            <div className="form-eyebrow">{t("OCTOBER 6 UNIVERSITY")}</div>
            <h2>{t("Sign in")}</h2>
            <p className="form-description">
              {t(" Access your exams with your university account. ")}
            </p>
            <form onSubmit={submit} noValidate aria-label={t("Sign in")}>
              <label htmlFor="username">{t("Username")}</label>
              <div
                className={`input-wrap ${validation.username ? "invalid" : ""}`}
              >
                <Icon name="user" size={19} />
                <input
                  ref={usernameRef}
                  dir="ltr"
                  id="username"
                  name="username"
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  placeholder={t("Enter your university username")}
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setValidation((v) => ({ ...v, username: undefined }));
                    login.reset();
                  }}
                  aria-invalid={Boolean(validation.username)}
                  aria-describedby={
                    validation.username ? "username-error" : undefined
                  }
                  disabled={login.isPending}
                />
              </div>
              {validation.username && (
                <p id="username-error" className="field-error">
                  {t(validation.username ?? "")}
                </p>
              )}
              <div className="password-label">
                <label htmlFor="password">{t("Password")}</label>
                <button
                  type="button"
                  className="text-button forgot"
                  onClick={() => setHelp("password")}
                >
                  {t(" Forgot password? ")}
                </button>
              </div>
              <div
                className={`input-wrap ${validation.password ? "invalid" : ""}`}
              >
                <Icon name="lock" size={19} />
                <input
                  ref={passwordRef}
                  dir="ltr"
                  id="password"
                  name="password"
                  autoComplete="current-password"
                  type={showPassword ? "text" : "password"}
                  placeholder={t("Enter your password")}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setValidation((v) => ({ ...v, password: undefined }));
                    login.reset();
                  }}
                  onKeyUp={(e) => setCapsLock(e.getModifierState("CapsLock"))}
                  onKeyDown={(e) => setCapsLock(e.getModifierState("CapsLock"))}
                  onBlur={() => setCapsLock(false)}
                  aria-invalid={Boolean(validation.password)}
                  aria-describedby={
                    validation.password ? "password-error" : undefined
                  }
                  disabled={login.isPending}
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={
                    showPassword ? t("Hide password") : t("Show password")
                  }
                  aria-pressed={showPassword}
                >
                  <Icon name={showPassword ? "hidden" : "eye"} size={19} />
                </button>
              </div>
              {validation.password && (
                <p id="password-error" className="field-error">
                  {t(validation.password ?? "")}
                </p>
              )}
              {capsLock && (
                <p className="field-hint">{t("Caps Lock is on.")}</p>
              )}
              <label className="remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>{t("Remember my username")}</span>
              </label>
              {login.isError && (
                <div className="error-banner" role="alert">
                  <Icon name="alert" size={19} />
                  <span>{t(errorMessage ?? "")}</span>
                </div>
              )}
              <button
                type="submit"
                className="primary"
                disabled={login.isPending || session.isPending}
              >
                {login.isPending ? (
                  <>
                    <span className="spinner" />
                    {t(" Signing you in\u2026 ")}
                  </>
                ) : session.isPending ? (
                  t("Checking session…")
                ) : (
                  <>
                    {t(" Sign in ")}
                    <Icon name="arrow" size={20} />
                  </>
                )}
              </button>
            </form>
            <div className="secure-note">
              <Icon name="shield" size={16} />
              <span>{t("Secure university sign-in")}</span>
            </div>
            <div className="account-note">
              {t(" Need access?")}{" "}
              <button className="text-button" onClick={() => setHelp("access")}>
                {t(" Contact your administrator ")}
                <Icon name="arrow" size={13} />
              </button>
            </div>
            {demo && (
              <div className="demo-box">
                <div>
                  <span className="demo-dot" />
                  <b>{t("Explore the preview")}</b>
                  <span className="demo-pill">{t("DEMO")}</span>
                </div>
                <p>{t("Try the sign-in experience with a sample account.")}</p>
                {demoPasswordChanged() && (
                  <p>
                    {t(
                      "You changed the demo password on this browser. Sign in using your new password.",
                    )}
                  </p>
                )}
                <button
                  className="demo-fill"
                  onClick={() => {
                    setUsername("alex.morgan");
                    setPassword(demoPasswordChanged() ? "" : "Preview123!");
                    setValidation({});
                    login.reset();
                    passwordRef.current?.focus();
                  }}
                >
                  {t(
                    demoPasswordChanged()
                      ? "Use demo username"
                      : "Use demo credentials",
                  )}
                  <Icon name="arrow" size={16} />
                </button>
                {demoPasswordChanged() && (
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          t(
                            "Restore Preview123! for this browser’s demo account?",
                          ),
                        )
                      ) {
                        resetDemoPassword();
                        setUsername("alex.morgan");
                        setPassword("Preview123!");
                        setValidation({});
                        login.reset();
                      }
                    }}
                  >
                    {t("Reset demo password")}
                  </button>
                )}
              </div>
            )}
            {!demo && session.isError && (
              <p className="connection-note" role="status">
                {t(" Unable to check your session. You can retry signing in. ")}
              </p>
            )}
          </>
        </div>
        <footer className="form-footer">
          <span>
            © {new Date().getFullYear()}
            {t(" October 6 University")}
          </span>
          <span>
            <Icon name="lock" size={13} />
            {t(" Examination Portal ")}
          </span>
        </footer>
      </section>
      {help && <Modal kind={help} onClose={() => setHelp(null)} />}
    </main>
  );
}
export default function App() {
  const Router = demo ? HashRouter : BrowserRouter;
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <Login />
      </Router>
    </QueryClientProvider>
  );
}
