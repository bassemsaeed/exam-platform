import {
  AccountGuide,
  SupportQueue,
  Notifications,
  NotificationLink,
} from "./pages/Enhancements";
import { Preferences } from "./components/Preferences";
import { useT } from "./lib/i18n";
import { useState, useEffect } from "react";
import {
  NavLink,
  Route,
  Routes,
  Navigate,
  Link,
  useLocation,
} from "react-router-dom";
import {
  LayoutDashboard,
  ClipboardList,
  BookOpen,
  GraduationCap,
  Users,
  Building2,
  Layers,
  CalendarDays,
  FileDown,
  ShieldCheck,
  History,
  LogOut,
  Settings,
  Menu,
  X,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import type { SessionUser, Role } from "./lib/api";
import {
  previewMode,
  useResource,
  rowsOf,
  type Envelope,
  type Exam,
  type StudentResult,
  nameOf,
  date,
  time,
} from "./lib/platform";
import { queryClient, sessionKey } from "./lib/query";
import { useUIStore } from "./lib/workspace-state";
import { PageTitle, Badge, Loading, Feedback, Empty } from "./components/ui";
import {
  Exams,
  ExamDetail,
  ExamBuilder,
  Results,
  QuestionBank,
  Exports,
  Profile,
  Imports,
  Roster,
} from "./pages/Academic";
import { AdminResource, UserDetail } from "./pages/Admin";
import { ExamRunner } from "./pages/Runner";
const roles: Record<Role, string> = {
  student: "Student",
  doctor: "Educator",
  ta: "Teaching assistant",
  admin: "Administrator",
};
export default function Workspace({
  user,
  onLogout,
  logoutBusy,
  logoutError,
}: {
  user: SessionUser;
  onLogout: () => void;
  logoutBusy: boolean;
  logoutError?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!open || !mobile) return;
    document.querySelector<HTMLAnchorElement>(".sidebar nav a")?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        document.querySelector<HTMLButtonElement>(".mobile-menu")?.focus();
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, mobile]);

  const compact = useUIStore((s) => s.compact);
  const setCompact = useUIStore((s) => s.setCompact);
  const nav = [
    { to: "/", title: "Overview", icon: LayoutDashboard },
    { to: "/notifications", title: "Notifications", icon: History },
    {
      to: "/exams",
      title: user.role === "student" ? "My exams" : "Exams & quizzes",
      icon: ClipboardList,
    },
    { to: "/results", title: "Results", icon: GraduationCap },
    ...(user.role === "student"
      ? []
      : [
          { to: "/questions", title: "Question bank", icon: BookOpen },
          { to: "/roster", title: "Roster", icon: Users },
          { to: "/exports", title: "Exports", icon: FileDown },
        ]),
    ...(user.role === "admin"
      ? [
          { to: "/admin/users", title: "Users", icon: Users },
          { to: "/support", title: "Account requests", icon: ShieldCheck },
          { to: "/admin/subjects", title: "Subjects", icon: BookOpen },
          { to: "/admin/sections", title: "Sections", icon: Layers },
          { to: "/admin/departments", title: "Departments", icon: Building2 },
          { to: "/admin/terms", title: "Academic terms", icon: CalendarDays },
          {
            to: "/admin/assignments",
            title: "Assignments",
            icon: GraduationCap,
          },
          { to: "/imports", title: "Imports", icon: FileDown },
          {
            to: "/admin/seb-keys",
            title: "Browser security",
            icon: ShieldCheck,
          },
          { to: "/admin/audit", title: "Audit log", icon: History },
        ]
      : []),
    { to: "/profile", title: "My account", icon: Settings },
  ];
  function changeRole(role: Role) {
    if (!previewMode) return;
    queryClient.removeQueries({ queryKey: ["platform"] });
    const names = {
      student: "Alex Morgan",
      doctor: "Dr. Ahmed Hassan",
      ta: "Mariam Ali",
      admin: "O6U Administrator",
    };
    const next = { ...user, id: "preview-" + role, role, name: names[role] };
    sessionStorage.setItem("exam-platform-preview-role", role);
    queryClient.setQueryData(sessionKey, next);
  }
  return (
    <div className={`workspace ${compact ? "compact" : ""}`}>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        {t("Skip to main content")}
      </a>
      <aside
        id="portal-sidebar"
        inert={mobile && !open}
        className={`sidebar ${open ? "open" : ""}`}
      >
        <Link to="/" className="sidebar-brand" onClick={() => setOpen(false)}>
          <img src="/o6u-logo.png" alt={t("October 6 University")} />
        </Link>
        <div className="sidebar-section-title">{t("EXAMINATION PORTAL")}</div>
        <nav aria-label={t("Main navigation")}>
          {nav.map(({ to, title, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setOpen(false)}
            >
              <Icon size={17} />
              <span>{t(title)}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="user-avatar">
            {user.name
              .split(" ")
              .map((n) => n[0])
              .slice(0, 2)
              .join("")}
          </div>
          <div>
            <b>{user.name}</b>
            <span>{t(roles[user.role])}</span>
          </div>
          <button
            aria-label={t("Sign out")}
            className="icon-button"
            onClick={onLogout}
            disabled={logoutBusy}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      {open && (
        <button
          className="sidebar-overlay"
          aria-label={t("Close menu")}
          onClick={() => setOpen(false)}
        />
      )}
      <div className="workspace-main">
        <header className="workspace-header">
          <div>
            <button
              aria-expanded={open}
              aria-controls="portal-sidebar"
              className="mobile-menu icon-button"
              aria-label={open ? t("Close menu") : t("Open menu")}
              onClick={() => setOpen(!open)}
            >
              {open ? <X size={22} /> : <Menu size={22} />}
            </button>
            <span>
              {t(" October 6 University ")}
              <span className="header-slash">/</span>{" "}
              <b>{t("Examination Portal")}</b>
            </span>
          </div>
          <div className="header-tools">
            <Preferences />
            <NotificationLink
              user={user}
              enabled={!location.pathname.endsWith("/take")}
            />
            {previewMode ? (
              <>
                <span className="preview-chip">{t("Demo preview")}</span>
                <select
                  aria-label={t("Preview role")}
                  value={user.role}
                  onChange={(e) => changeRole(e.target.value as Role)}
                >
                  {Object.entries(roles).map(([r, label]) => (
                    <option value={r} key={r}>
                      {t(label)}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <span className="connected">
                <i />
                {t(" Connected ")}
              </span>
            )}
            <button
              className="icon-button"
              aria-label={t("Sign out")}
              disabled={logoutBusy}
              onClick={onLogout}
            >
              <LogOut size={17} />
            </button>
          </div>
        </header>
        <div className="workspace-content" id="main-content" tabIndex={-1}>
          <Feedback error={logoutError} />
          <Routes>
            <Route path="/" element={<Overview user={user} />} />
            <Route
              path="/notifications"
              element={<Notifications user={user} />}
            />
            {user.role === "admin" && (
              <Route path="/support" element={<SupportQueue user={user} />} />
            )}
            <Route path="/exams" element={<Exams user={user} />} />
            {user.role !== "student" && (
              <>
                <Route
                  path="/exams/new"
                  element={<ExamBuilder user={user} />}
                />
                <Route path="/exams/:id" element={<ExamDetail user={user} />} />
                <Route
                  path="/questions"
                  element={<QuestionBank user={user} />}
                />
                <Route path="/exports" element={<Exports user={user} />} />
                <Route path="/roster" element={<Roster user={user} />} />
                <Route path="/imports" element={<Imports user={user} />} />
              </>
            )}
            {user.role === "student" && (
              <Route
                path="/exams/:id/take"
                element={<ExamRunner user={user} />}
              />
            )}
            <Route path="/results" element={<Results user={user} />} />
            <Route path="/profile" element={<Profile user={user} />} />
            {user.role === "admin" && (
              <>
                <Route
                  path="/admin/users/:id"
                  element={<UserDetail user={user} />}
                />
                <Route
                  path="/admin/:resource"
                  element={<AdminResource user={user} />}
                />
              </>
            )}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
        <footer className="workspace-footer">
          <span>
            © {new Date().getFullYear()}
            {t(" October 6 University")}
          </span>
          <div>
            <label>
              <input
                type="checkbox"
                checked={compact}
                onChange={(e) => setCompact(e.target.checked)}
              />{" "}
              {t(" Compact tables ")}
            </label>
            {previewMode && (
              <button
                className="text-button"
                onClick={() => {
                  if (confirm(t("Reset all sample data in this browser?"))) {
                    void import("./lib/preview").then((m) => {
                      m.resetPreview();
                      void queryClient.invalidateQueries({
                        queryKey: ["platform"],
                      });
                    });
                  }
                }}
              >
                <RefreshCw size={12} />
                {t(" Reset demo ")}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
function Overview({ user }: { user: SessionUser }) {
  const t = useT();
  const student = user.role === "student";
  const exams = useResource<Exam[] | Envelope<Exam>>(
    user,
    student
      ? "/api/v1/student/exams"
      : user.role === "admin"
        ? "/api/v1/admin/exams?limit=100"
        : "/api/v1/exams/mine?limit=100",
  );
  const results = useResource<StudentResult[]>(
    user,
    "/api/v1/student/results",
    student,
  );
  const rows = rowsOf(exams.data);
  const examTotal = Array.isArray(exams.data)
    ? exams.data.length
    : (exams.data?.total ?? rows.length);
  const latest = results.data ?? [];
  const active = rows.filter((e) => e.status === "approved" || student);
  const pending = rows.filter((e) => e.status === "pending_approval");
  return (
    <>
      <PageTitle
        title={t("Welcome, {0}.", {
          "0": user.name.replace(/^(Dr\.?|Prof\.?)\s+/i, "").split(" ")[0],
        })}
        description={
          student
            ? t("Your exams and academic progress, in one place.")
            : t("Your assessment workspace for the current academic term.")
        }
        action={
          !student ? (
            <Link className="button primary" to="/exams/new">
              {t(" Create exam ")}
              <ArrowUpRight size={16} />
            </Link>
          ) : (
            <span className="today-label">
              {date(new Date().toISOString())}
            </span>
          )
        }
      />
      {previewMode && (
        <div className="info-banner">
          <span className="orange-dot" />
          <span>
            {t(
              " You\u2019re exploring sample data. Switch roles above to view each workspace. Changes are saved only in this browser. ",
            )}
          </span>
        </div>
      )}
      <AccountGuide user={user} />
      <div className="stat-grid">
        {[
          [
            student ? "Available exams" : "Exams in view",
            exams.isPending ? "—" : rows.length,
            ClipboardList,
          ],
          [
            student ? "Completed assessments" : "Approved exams",
            exams.isPending ? "—" : student ? latest.length : active.length,
            GraduationCap,
          ],
          [
            student ? "Latest grade" : "Awaiting approval",
            student ? (latest[0]?.totalGrade ?? "—") : pending.length,
            student ? BookOpen : ShieldCheck,
          ],
        ].map(([title, value, Icon]) => {
          const I = Icon as typeof BookOpen;
          return (
            <div className="stat-card" key={String(title)}>
              <div>
                <span>{t(String(title))}</span>
                <I size={19} />
              </div>
              <strong>{String(value)}</strong>
              <small>
                {student
                  ? t("Your academic activity")
                  : t("Current list · up to 100 exams")}
              </small>
              {!exams.isPending && examTotal > rows.length && (
                <small>
                  {t("Showing first {0} of {1}.", {
                    "0": rows.length,
                    "1": examTotal,
                  })}
                </small>
              )}
            </div>
          );
        })}
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>
                {student ? t("Available assessments") : t("Recent assessments")}
              </h2>
              <p>
                {student
                  ? t("Open an exam to begin or resume your attempt.")
                  : t("Review, manage, and track your latest exams.")}
              </p>
            </div>
            <Link to="/exams" className="text-button">
              {t(" View all ")}
              <ArrowUpRight size={14} />
            </Link>
          </div>
          <Feedback error={exams.error} />
          {exams.isPending ? (
            <Loading />
          ) : rows.length ? (
            <div className="assessment-list">
              {rows.slice(0, 4).map((e) => (
                <Link
                  to={student ? `/exams/${e.id}/take` : `/exams/${e.id}`}
                  key={e.id}
                >
                  <span className="assessment-icon">
                    <ClipboardList size={20} />
                  </span>
                  <div>
                    <b>{nameOf(e)}</b>
                    <small>
                      {date(e.startTime)} · {time(e.startTime)} ·{" "}
                      {e.durationMinutes}
                      {t(" min ")}
                    </small>
                  </div>
                  <Badge value={student ? "available" : e.status} />
                  <ArrowUpRight size={16} />
                </Link>
              ))}
            </div>
          ) : (
            !exams.error && (
              <Empty
                title={t("No assessments available")}
                text={t("Your assigned exams will appear here when they open.")}
              />
            )
          )}
        </section>
        <section className="panel quick-panel">
          <div className="panel-heading">
            <div>
              <h2>{t("Your workspace")}</h2>
              <p>{t("Everything you need for your next step.")}</p>
            </div>
          </div>
          {(student
            ? [
                [
                  "Results",
                  "Review completed assessments",
                  "/results",
                  GraduationCap,
                ],
                [
                  "My account",
                  "Your profile and account security",
                  "/profile",
                  Settings,
                ],
              ]
            : [
                [
                  "Question bank",
                  "Create and organize assessment questions",
                  "/questions",
                  BookOpen,
                ],
                [
                  "Results",
                  "Review grades and section rosters",
                  "/results",
                  GraduationCap,
                ],
                [
                  "Exports",
                  "Download assessment records",
                  "/exports",
                  FileDown,
                ],
              ]
          ).map(([title, copy, to, Icon]) => {
            const I = Icon as typeof BookOpen;
            return (
              <Link className="quick-link" key={String(to)} to={String(to)}>
                <I size={20} />
                <div>
                  <b>{t(String(title))}</b>
                  <small>{t(String(copy))}</small>
                </div>
                <ArrowUpRight size={15} />
              </Link>
            );
          })}
          <div className="university-note">
            <ShieldCheck size={23} />
            <p>
              {t(
                " Assessment access is managed by your university. Contact your faculty administrator if an exam or subject is missing. ",
              )}
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
