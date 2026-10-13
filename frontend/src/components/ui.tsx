import { useT } from "../lib/i18n";
import {
  useEffect,
  useRef,
  useState,
  useId,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  X,
  Search,
} from "lucide-react";
import type { Entity, Envelope } from "../lib/platform";
import { ApiError } from "../lib/api";
import { label } from "../lib/platform";
export function Badge({ value }: { value: unknown }) {
  const t = useT();
  return (
    <span className={`badge badge-${String(value)}`}>{t(label(value))}</span>
  );
}
export function Empty({
  title = "Nothing here yet",
  text = "New records will appear here.",
}: {
  title?: string;
  text?: string;
}) {
  const t = useT();
  return (
    <div className="empty-state" role="status">
      <div className="empty-symbol" aria-hidden="true">
        ○
      </div>
      <h3>{t(title)}</h3>
      <p>{t(text)}</p>
    </div>
  );
}
const LOCK_REASONS: Record<string, string> = {
  "exam window has started":
    "The opening time passed while it was still pending — edits are frozen, but approval can still rescue it before it ends.",
  "exam window has ended":
    "The closing time already passed — create a fresh exam instead.",
};
export function Feedback({ error }: { error: unknown }) {
  const t = useT();
  if (!error) return null;
  const text = error instanceof Error ? error.message : String(error);
  const reason =
    error instanceof ApiError && typeof error.reason === "string"
      ? error.reason
      : null;
  return (
    <div className="error-banner" role="alert">
      <AlertCircle size={18} />
      <span>
        {/safe exam browser/i.test(text)
          ? t(
              "Open this portal in Safe Exam Browser to view and take your available exams. Your university provides the browser configuration.",
            )
          : text === "locked"
            ? (
              <>
                {t("locked")}
                {reason && (
                  <>
                    <br />
                    {t(LOCK_REASONS[reason] ?? reason)}
                  </>
                )}
              </>
            )
            : t(text)}
      </span>
    </div>
  );
}
export function Loading({ text }: { text?: string }) {
  const t = useT();
  return (
    <div
      className="skeleton-stack"
      role="status"
      aria-busy="true"
      aria-label={t(text ?? "Loading")}
    >
      <span />
      <span />
      <span />
    </div>
  );
}

export function Success({ message }: { message: unknown }) {
  const t = useT();
  if (!message) return null;
  const text = typeof message === "string" ? message : String(message);
  if (!text) return null;
  return (
    <div className="success-banner" role="status">
      {t(text)}
    </div>
  );
}
export function PageTitle({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="page-heading">
      <div>
        <span className="page-kicker">{t("EXAMINATION PORTAL")}</span>
        <h1>{t(title)}</h1>
        <p>{t(description)}</p>
      </div>
      {action}
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = "Search…",
}: {
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
}) {
  const t = useT();
  return (
    <div className="search-box">
      <Search size={17} />
      <input
        aria-label={t(placeholder)}
        placeholder={t(placeholder)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
export function Pagination({
  data,
  page,
  setPage,
}: {
  data?: Envelope<unknown>;
  page: number;
  setPage: (n: number) => void;
}) {
  const t = useT();
  if (!data) return null;
  return (
    <div className="pagination">
      <span>
        {data.total}
        {t(" records \u00B7 Page ")}
        {page}
        {t(" of")} {Math.max(1, Math.ceil(data.total / data.limit))}
      </span>
      <div>
        <button
          aria-label={t("Previous page")}
          disabled={page <= 1}
          onClick={() => setPage(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          aria-label={t("Next page")}
          disabled={page * data.limit >= data.total}
          onClick={() => setPage(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const t = useT();
  const headingId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dlg = ref.current;
    if (dlg && !dlg.open) {
      try {
        dlg.showModal();
      } catch {
        /* already open */
      }
    }
    // Focus trap-lite: focus the first focusable button on open.
    dlg?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      try {
        dlg?.close();
      } catch {
        /* already closed */
      }
      previous?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={headingId}
      className={`app-dialog ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-header">
        <h2 id={headingId}>{t(title)}</h2>
        <button
          className="icon-button"
          aria-label={t("Close dialog")}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export interface Field {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
  /** Render options as pill buttons instead of a dropdown. */
  segmented?: boolean;
  options?: {
    value: string;
    label: string;
  }[];
  min?: number;
  max?: number;
  hint?: string;
  value?: unknown;
}
export function FieldsForm({
  fields,
  initial = {},
  onSubmit,
  busy,
  error,
  submitLabel = "Save changes",
}: {
  fields: Field[];
  initial?: Entity | Record<string, unknown>;
  onSubmit: (v: Record<string, unknown>) => void;
  busy?: boolean;
  error?: unknown;
  submitLabel?: string;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.key,
        initial[f.key] ?? f.value ?? (f.type === "checkbox" ? false : ""),
      ]),
    ),
  );
  const [submitError, setSubmitError] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitError("");
    const result: Record<string, unknown> = {};
    for (const f of fields) {
      let v = values[f.key];
      if (v === "" && !f.required) continue;
      if (f.type === "number") {
        const n = Number(v);
        if (Number.isNaN(n)) {
          setSubmitError(`Enter a valid number for ${f.label}.`);
          return;
        }
        v = n;
      }
      if (f.type === "datetime-local") {
        const d = new Date(String(v));
        if (Number.isNaN(d.getTime())) {
          setSubmitError(`Enter a valid date and time for ${f.label}.`);
          return;
        }
        v = d.toISOString();
      }
      if (f.type === "list")
        v = String(v)
          .split(/[\n,]/)
          .map((x) => x.trim())
          .filter(Boolean);
      result[f.key] = v;
    }
    onSubmit(result);
  }
  return (
    <form className="fields-form" onSubmit={submit}>
      {fields.map((f) => (
        <div className="field" key={f.key}>
          <label htmlFor={"field-" + f.key}>
            {t(f.label)}
            {f.required && (
              <span className="required" aria-hidden="true">
                {" "}
                *
              </span>
            )}
          </label>
          {f.type === "textarea" || f.type === "list" ? (
            <textarea
              aria-describedby={f.hint ? "hint-" + f.key : undefined}
              id={"field-" + f.key}
              value={String(values[f.key] ?? "")}
              required={f.required}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }
            />
          ) : f.options ? (
            f.segmented ? (
              <div
                className="seg-pick"
                role="radiogroup"
                aria-label={t(f.label)}
              >
                {f.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={String(values[f.key] ?? "") === o.value}
                    className={
                      String(values[f.key] ?? "") === o.value ? "on" : ""
                    }
                    onClick={() =>
                      setValues((v) => ({ ...v, [f.key]: o.value }))
                    }
                  >
                    {t(o.label)}
                  </button>
                ))}
              </div>
            ) : (
            <select
              aria-describedby={f.hint ? "hint-" + f.key : undefined}
              id={"field-" + f.key}
              required={f.required}
              value={String(values[f.key] ?? "")}
              onChange={(e) =>
                setValues((v) => ({ ...v, [f.key]: e.target.value }))
              }
            >
              <option value="">{t("Select\u2026")}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.label)}
                </option>
              ))}
            </select>
            )
          ) : (
            <input
              aria-describedby={f.hint ? "hint-" + f.key : undefined}
              id={"field-" + f.key}
              type={f.type === "checkbox" ? "checkbox" : (f.type ?? "text")}
              checked={
                f.type === "checkbox" ? Boolean(values[f.key]) : undefined
              }
              value={
                f.type === "checkbox" ? undefined : String(values[f.key] ?? "")
              }
              min={f.min}
              max={f.max}
              step={f.type === "number" ? "any" : undefined}
              required={f.required}
              onChange={(e) =>
                setValues((v) => ({
                  ...v,
                  [f.key]:
                    f.type === "checkbox" ? e.target.checked : e.target.value,
                }))
              }
            />
          )}{" "}
          {f.hint && <small id={"hint-" + f.key}>{t(f.hint)}</small>}
        </div>
      ))}
      <Feedback error={error || submitError || undefined} />
      <div className="dialog-actions">
        <button className="primary" disabled={busy} type="submit">
          {busy ? t("Saving…") : t(submitLabel)}
        </button>
      </div>
    </form>
  );
}
export function Confirm({
  title,
  text,
  onClose,
  onConfirm,
  busy,
  error,
}: {
  title: string;
  text: string;
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
  error?: unknown;
}) {
  const t = useT();
  return (
    <Dialog title={t(title)} onClose={onClose}>
      <p className="dialog-copy">{t(text)}</p>
      <Feedback error={error} />
      <div className="dialog-actions">
        <button className="secondary" onClick={onClose}>
          {t(" Cancel ")}
        </button>
        <button className="danger" disabled={busy} onClick={onConfirm}>
          {busy ? t("Working…") : t("Confirm")}
        </button>
      </div>
    </Dialog>
  );
}
