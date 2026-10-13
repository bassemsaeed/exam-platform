import { useT } from "../lib/i18n";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

export interface ComboOption {
  value: string;
  label: string;
  sub?: string;
}

// Searchable combobox replacing native <select>.
export function Combo({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  options: ComboOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open ]);
  const current = options.find((o) => o.value === value);
  const filtered = options.filter((o) =>
    `${o.label} ${o.sub ?? ""}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div className="combo" ref={box}>
      <button
        type="button"
        className="combo-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? placeholder}
        onClick={() => {
          setQ("");
          setOpen((v) => !v);
        }}
      >
        <span className={current ? "" : "combo-empty"}>
          {current ? current.label : t(placeholder ?? "Select…")}
        </span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="combo-pop" role="listbox" id={listId}>
          <div className="combo-search">
            <Search size={14} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("Type to search…")}
              aria-label={t("Type to search…")}
            />
          </div>
          <div className="combo-list">
            {filtered.length ? (
              filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`combo-item ${o.value === value ? "picked" : ""}`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <span>
                    <b>{o.label}</b>
                    {o.sub && <small>{o.sub}</small>}
                  </span>
                  {o.value === value && <Check size={15} />}
                </button>
              ))
            ) : (
              <p className="subtle combo-none">{t("No matches.")}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Modern date-time field: button opens calendar popover (date grid +
// time chips + presets). Works with local "YYYY-MM-DDTHH:mm" strings.
export function DateTimeField({
  value,
  onChange,
  label,
  min,
  base,
  offsets,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  min?: string;
  /** When set, show "+30m / +1h…" chips relative to this local datetime. */
  base?: string;
  offsets?: { label: string; minutes: number }[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open ]);
  const [d, tm] = value ? value.split("T") : ["", ""];
  const [hh = "", mm = ""] = (tm ?? "").split(":");
  function set(date: string, h: string, m: string) {
    if (!date) {
      onChange("");
      return;
    }
    onChange(`${date}T${h.padStart(2, "0")}:${m.padStart(2, "0")}`);
  }
  function preset(days: number, h: string, m: string) {
    const dt = new Date();
    dt.setDate(dt.getDate() + days);
    dt.setHours(Number(h), Number(m), 0, 0);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}T${h}:${m}`;
    onChange(iso);
  }
  function shift(minutes: number) {
    const b = new Date(base as string).getTime();
    if (Number.isNaN(b)) return;
    const dt = new Date(b + minutes * 60000);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}T${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
    onChange(iso);
  }
  const pretty = value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const mins = ["00", "15", "30", "45"];
  return (
    <div className="dt" ref={box}>
      <span className="field-label">{t(label)}</span>
      <button
        type="button"
        className={`combo-button dt-button ${value ? "" : "combo-empty"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{pretty || t("Pick date & time")}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="combo-pop dt-pop" role="dialog" aria-label={t(label)}>
          <input
            type="date"
            value={d}
            min={min ? min.split("T")[0] : undefined}
            onChange={(e) => set(e.target.value, hh || "09", mm || "00")}
            aria-label={t("Date")}
          />
          <div className="dt-row">
            <select
              aria-label={t("Hour")}
              value={hh}
              onChange={(e) => set(d, e.target.value, mm || "00")}
            >
              <option value="">{t("HH")}</option>
              {hours.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
            <select
              aria-label={t("Minute")}
              value={mm}
              onChange={(e) => set(d, hh || "09", e.target.value)}
            >
              <option value="">{t("MM")}</option>
              {mins.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="chip-row">
            {base && offsets?.map((o) => (
              <button
                key={o.label}
                type="button"
                className="chip smart"
                onClick={() => shift(o.minutes)}
              >
                {t(o.label)}
              </button>
            ))}
            {[
              { k: "Tomorrow 9:00", days: 1, h: "09", m: "00" },
              { k: "Today 14:00", days: 0, h: "14", m: "00" },
              { k: "+7 days 9:00", days: 7, h: "09", m: "00" },
            ].map((p) => (
              <button
                key={p.k}
                type="button"
                className="chip"
                onClick={() => preset(p.days, p.h, p.m)}
              >
                {t(p.k)}
              </button>
            ))}
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              {t(" Clear ")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!value}
              onClick={() => setOpen(false)}
            >
              {t(" Done ")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Right-hand slide-over sheet used by the question editor.
export function Sheet({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const t = useT();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = "";
    };
  }, [onClose ]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside
        className={`sheet ${wide ? "wide" : ""}`}
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{t(title)}</h2>
          <button
            className="icon-button"
            aria-label={t("Close panel")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </aside>
    </div>
  );
}

export interface PickOption {
  id: string;
  name: string;
  username?: string;
  sub?: string;
}

// Visual multi-picker: searchable list of named people (never raw IDs).
// Selected become chips; submit sends IDs behind the scenes.
export function MultiPicker({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
}: {
  options: PickOption[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  emptyText?: string;
}) {
  const t = useT();
  const [q, setQ] = useState("");
  const sel = new Set(value);
  const filtered = options.filter((o) =>
    `${o.name} ${o.username ?? ""} ${o.sub ?? ""}`
      .toLowerCase()
      .includes(q.toLowerCase()),
  );
  const picked = options.filter((o) => sel.has(o.id));
  return (
    <div className="mpick">
      {picked.length > 0 && (
        <div className="chip-pick picked">
          {picked.map((o) => (
            <button
              key={o.id}
              type="button"
              className="on"
              onClick={() => onChange(value.filter((x) => x !== o.id))}
              title={t("Remove")}
            >
              <Check size={13} /> {o.name}
              {o.username ? (
                <>
                  {" ("}
                  <bdi>{o.username}</bdi>
                  {")"}
                </>
              ) : null}
            </button>
          ))}
        </div>
      )}
      <div className="combo-search mpick-search">
        <Search size={14} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t(placeholder ?? "Search by name…")}
          aria-label={t(placeholder ?? "Search by name…")}
        />
      </div>
      <div className="mpick-list">
        {filtered.length ? (
          filtered.map((o) => (
            <label key={o.id} className={sel.has(o.id) ? "on" : ""}>
              <input
                type="checkbox"
                checked={sel.has(o.id)}
                onChange={() =>
                  onChange(
                    sel.has(o.id)
                      ? value.filter((x) => x !== o.id)
                      : [...value, o.id],
                  )
                }
              />
              <span>
                <b>{o.name}</b>
                <small>
                  <bdi>{[o.username, o.sub].filter(Boolean).join(" · ")}</bdi>
                </small>
              </span>
            </label>
          ))
        ) : (
          <p className="subtle">{t(emptyText ?? "No matches.")}</p>
        )}
      </div>
      <p className="subtle">
        {value.length} {t("selected")}
      </p>
    </div>
  );
}
