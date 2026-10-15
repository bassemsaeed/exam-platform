import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bell, CheckCircle2, LifeBuoy, ShieldCheck } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import type { SessionUser } from "../lib/api";
import { useT } from "../lib/i18n";
import {
  request,
  useResource,
  useAction,
  date,
  time,
  previewMode,
  type Entity,
  type Envelope,
} from "../lib/platform";
import {
  Dialog,
  Feedback,
  Loading,
  Empty,
  PageTitle,
  Badge,
  FieldsForm,
  Pagination,
} from "../components/ui";
export function AccountHelp({
  onClose,
  initialKind = "access",
}: {
  onClose: () => void;
  initialKind?: "access" | "password";
}) {
  const t = useT();
  const [kind, setKind] = useState(initialKind);
  const [form, setForm] = useState(false);
  const send = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      request<{ reference: string }>("/api/v1/support/requests", "POST", {
        ...body,
        kind,
      }),
  });
  return (
    <Dialog title={t("Account help")} onClose={onClose}>
      <div className="segmented" role="group" aria-label={t("Help topic")}>
        <button
          aria-pressed={kind === "access"}
          className={kind === "access" ? "active" : ""}
          onClick={() => {
            setKind("access");
            setForm(false);
            send.reset();
          }}
        >
          {t("Get an account")}
        </button>
        <button
          aria-pressed={kind === "password"}
          className={kind === "password" ? "active" : ""}
          onClick={() => {
            setKind("password");
            setForm(false);
            send.reset();
          }}
        >
          {t("Reset password")}
        </button>
      </div>
      {send.data ? (
        <div className="support-success" role="status">
          <CheckCircle2 size={32} />
          <h3>{t("Request received")}</h3>
          <p>
            {t("Reference")}: <code dir="ltr">{send.data.reference}</code>
          </p>
          <p>
            {t(
              "An administrator will review your request and verify your identity before making changes. Keep this reference and contact your faculty if you need urgent help.",
            )}
          </p>
          {previewMode && (
            <p className="info-banner">
              {t(
                "This demo request is saved only in this browser. No university staff are contacted.",
              )}
            </p>
          )}
        </div>
      ) : (
        <>
          <ol className="onboarding-steps">
            <li>
              <b>
                {t(
                  kind === "access"
                    ? "Contact your faculty"
                    : "Identify your account",
                )}
              </b>
              <p>
                {t(
                  kind === "access"
                    ? "Your faculty administrator creates your account and assigns your subjects and section."
                    : "Provide your university username and a contact email. Never include a password in your request.",
                )}
              </p>
            </li>
            <li>
              <b>{t("Verify your identity")}</b>
              <p>
                {t(
                  "Your faculty verifies your student or staff identity through its usual channels. A request alone does not grant account access.",
                )}
              </p>
            </li>
            <li>
              <b>{t("Receive your credentials")}</b>
              <p>
                {t(
                  "Your administrator shares your username and initial or reset password securely. Sign in with the username, not your email.",
                )}
              </p>
            </li>
          </ol>
          {previewMode && (
            <div className="info-banner">
              {t(
                "Exploring the demo? Close this window and use the demo credentials button on the login page.",
              )}
            </div>
          )}
          {!form ? (
            <button className="primary" onClick={() => setForm(true)}>
              {t("Send an account request")}
            </button>
          ) : (
            <>
              <p className="dialog-copy">
                {t(
                  "This creates a request in the administrator’s queue. It does not reset a password or send an automated email.",
                )}
              </p>
              <FieldsForm
                fields={[
                  { key: "name", label: "Full name", required: true },
                  {
                    key: "username",
                    label: "University username (if known)",
                    required: kind === "password",
                  },
                  {
                    key: "contact",
                    label: "Contact email",
                    type: "email",
                    required: true,
                  },
                  {
                    key: "details",
                    label: "Faculty and student/staff ID",
                    type: "textarea",
                    required: true,
                    hint: "Include enough information for your faculty to identify you. Do not include passwords.",
                  },
                ]}
                busy={send.isPending}
                error={send.error}
                onSubmit={(body) => send.mutate(body)}
                submitLabel="Submit request"
              />
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
export function AccountGuide({ user }: { user: SessionUser }) {
  const t = useT();
  const location = useLocation();
  const [show, setShow] = useState(false);
  const onProfile = location.pathname === "/profile";
  return (
    <>
      <section className="account-guide">
        <ShieldCheck size={22} />
        <div>
          <h2>{t("Your account is ready")}</h2>
          <p>
            {t(
              "Use your university username to sign in. Your faculty manages account access and enrollment.",
            )}
          </p>
        </div>
        <button className="secondary" onClick={() => setShow(true)}>
          {t("Account help")}
        </button>
        {!onProfile && (
          <Link className="text-button" to="/profile">
            {t("Review my profile")}
          </Link>
        )}
      </section>
      {show && <AccountHelp onClose={() => setShow(false)} />}
      <span className="sr-only">
        {t("Signed in as")}: {user.username ?? user.name}
      </span>
    </>
  );
}
interface SupportRequest extends Entity {
  kind: string;
  name: string;
  username?: string;
  contact: string;
  details: string;
  status: string;
  createdAt: string;
  adminNote?: string;
}
export function SupportQueue({ user }: { user: SessionUser }) {
  const t = useT();
  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SupportRequest | null>(null);
  const query = useResource<Envelope<SupportRequest>>(
    user,
    `/api/v1/admin/support?status=${status}&page=${page}&limit=20`,
    true,
    60000,
  );
  const action = useAction(user, [
    "/api/v1/admin/support",
    "/api/v1/notifications",
  ]);
  return (
    <>
      <PageTitle
        title={t("Account requests")}
        description={t(
          "Review access and password-reset requests. Verify identity before changing an account.",
        )}
      />
      <div className="toolbar">
        <select
          aria-label={t("Request status")}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          {["pending", "resolved", "closed"].map((s) => (
            <option key={s} value={s}>
              {t(s)}
            </option>
          ))}
        </select>
        <span className="subtle">
          {query.data?.total ?? 0} {t("requests")}
        </span>
      </div>
      <Feedback error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : query.data?.rows.length ? (
        <section className="panel table-wrap">
          <table>
            <caption className="sr-only">{t("Account requests")}</caption>
            <thead>
              <tr>
                {[
                  "Name",
                  "Request type",
                  "Username",
                  "Created",
                  "Status",
                  "Actions",
                ].map((c) => (
                  <th scope="col" key={c}>
                    {t(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.name}</b>
                  </td>
                  <td>
                    {t(
                      r.kind === "password"
                        ? "Password reset"
                        : "Account access",
                    )}
                  </td>
                  <td>
                    <bdi>{r.username ?? "—"}</bdi>
                  </td>
                  <td>{date(r.createdAt)}</td>
                  <td>
                    <Badge value={r.status} />
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => {
                        action.reset();
                        setSelected(r);
                      }}
                    >
                      {t("Review request")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <Empty
          title={t("No account requests")}
          text={t("Requests submitted from the login page appear here.")}
        />
      )}
      <Pagination data={query.data} page={page} setPage={setPage} />
      {selected && (
        <Dialog title={t("Review request")} onClose={() => setSelected(null)}>
          <dl className="details-list">
            <div>
              <dt>{t("Reference")}</dt>
              <dd>
                <code>{selected.id.slice(0, 8).toUpperCase()}</code>
              </dd>
            </div>
            <div>
              <dt>{t("Contact email")}</dt>
              <dd>
                <bdi>{selected.contact}</bdi>
              </dd>
            </div>
          </dl>
          <p className="support-details">{selected.details}</p>
          <p className="info-banner">
            {t(
              "Confirm identity through your faculty’s trusted records. The email and username in this request are unverified. Use existing user controls to create an account or reset a password.",
            )}
          </p>
          <Link
            className="button secondary"
            to={`/admin/users?search=${encodeURIComponent(selected.username ?? selected.name)}`}
            onClick={() => setSelected(null)}
          >
            {t("Find matching accounts")}
          </Link>
          <FieldsForm
            fields={[
              {
                key: "status",
                label: "Request status",
                required: true,
                options: ["pending", "resolved", "closed"].map((v) => ({
                  value: v,
                  label: v,
                })),
              },
              {
                key: "adminNote",
                label: "Administrator note",
                type: "textarea",
                hint: "Record verification and follow-up. Never store a password here.",
              },
            ]}
            initial={selected}
            busy={action.isPending}
            error={action.error}
            onSubmit={(body) =>
              action.mutate(
                {
                  path: `/api/v1/admin/support/${selected.id}`,
                  method: "PATCH",
                  body,
                },
                { onSuccess: () => setSelected(null) },
              )
            }
          />
        </Dialog>
      )}
    </>
  );
}
export interface Notice {
  key: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
  createdAt: string;
  read: boolean;
}
export function NotificationLink({
  user,
  enabled = true,
}: {
  user: SessionUser;
  enabled?: boolean;
}) {
  const t = useT();
  const query = useResource<Notice[]>(
    user,
    "/api/v1/notifications",
    enabled,
    60000,
  );
  const unread = query.data?.filter((n) => !n.read).length ?? 0;
  return (
    <Link
      className="notification-link"
      to="/notifications"
      aria-label={`${t("Open notifications")}${unread ? ` (${unread})` : ""}`}
    >
      <Bell size={18} />
      {unread > 0 && <span>{unread > 99 ? "99+" : unread}</span>}
    </Link>
  );
}
export function Notifications({ user }: { user: SessionUser }) {
  const t = useT();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const query = useResource<Notice[]>(
    user,
    "/api/v1/notifications",
    true,
    60000,
  );
  const action = useAction(user, ["/api/v1/notifications"]);
  const unread = query.data?.filter((n) => !n.read) ?? [];
  const rows = unreadOnly ? unread : (query.data ?? []);
  return (
    <>
      <PageTitle
        title={t("Notifications")}
        description={t(
          "Upcoming exams, assessment decisions, and new results in one inbox.",
        )}
        action={
          <button
            className="secondary"
            disabled={!unread.length || action.isPending}
            onClick={() =>
              action.mutate({
                path: "/api/v1/notifications/read",
                body: { keys: unread.map((n) => n.key) },
              })
            }
          >
            {t("Mark all as read")}
          </button>
        }
      />
      <div className="toolbar">
        <label className="inline-check">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />
          {t("Unread only")}
        </label>
        <span className="subtle">
          {unread.length} {t("unread")}
        </span>
      </div>
      <Feedback error={query.error} />
      <Feedback error={action.error} />
      {query.isPending ? (
        <Loading />
      ) : rows.length ? (
        <section className="panel notification-list">
          {rows.map((n) => (
            <article key={n.key} className={n.read ? "read" : "unread"}>
              <span className="assessment-icon">
                {n.kind === "support" ? (
                  <LifeBuoy size={20} />
                ) : (
                  <Bell size={20} />
                )}
              </span>
              <div>
                <h2>{t(n.title)}</h2>
                <p>
                  <bdi>{n.detail}</bdi> · {date(n.createdAt)} ·{" "}
                  {time(n.createdAt)}
                </p>
                <Link
                  className="text-button"
                  to={n.href}
                  onClick={() => {
                    if (!n.read)
                      action.mutate({
                        path: "/api/v1/notifications/read",
                        body: { keys: [n.key] },
                      });
                  }}
                >
                  {t("Open details")}
                </Link>
              </div>
              {!n.read && (
                <button
                  className="text-button"
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: "/api/v1/notifications/read",
                      body: { keys: [n.key] },
                    })
                  }
                >
                  {t("Mark as read")}
                </button>
              )}
            </article>
          ))}
        </section>
      ) : (
        <Empty
          title={t("You’re all caught up")}
          text={t(
            "New activity will appear here. Notifications are scoped to your account.",
          )}
        />
      )}
    </>
  );
}
