import { useEffect, useMemo, useRef, useState } from "react";
import { request, type Sitting } from "../lib/platform";
import { useT } from "../lib/i18n";
import { Feedback } from "./ui";
import {
  evaluate,
  formatValue,
  clean,
  type NumBase,
  type AngleMode,
} from "../lib/calculator";

export function ExamTools({ userId, examId, sitting, disabled }: {
  userId: string; examId: string; sitting: Sitting; disabled: boolean;
}) {
  const t = useT();
  const [tool, setTool] = useState<"calculator" | "notes" | "doctor-notes" | null>(null);
  const key = `exam-notes-${userId}-${sitting.id}`;
  const [notes, setNotes] = useState(() => {
    try { return sessionStorage.getItem(key) ?? sitting.notes ?? ""; }
    catch { return sitting.notes ?? ""; }
  });
  const [saved, setSaved] = useState(sitting.notes ?? "");
  const doctorKey = `exam-doctor-notes-${userId}-${sitting.id}`;
  const [doctorNotes, setDoctorNotes] = useState(() => {
    try { return sessionStorage.getItem(doctorKey) ?? sitting.notesForDoctor ?? ""; }
    catch { return sitting.notesForDoctor ?? ""; }
  });
  const [doctorSaved, setDoctorSaved] = useState(sitting.notesForDoctor ?? "");
  const [error, setError] = useState<unknown>(null);
  const [doctorError, setDoctorError] = useState<unknown>(null);
  const [retry, setRetry] = useState(0);
  const [doctorRetry, setDoctorRetry] = useState(0);
  const saving = useRef(false);
  const doctorSaving = useRef(false);
  useEffect(() => {
    if (!sitting.notesEnabled || disabled || notes === saved) return;
    try { sessionStorage.setItem(key, notes); } catch { /* server save still works */ }
    const timer = setTimeout(async () => {
      if (saving.current) { setRetry((n) => n + 1); return; }
      saving.current = true;
      try {
        await request(`/api/v1/student/exams/${examId}/notes`, "PATCH", { notes });
        setSaved(notes); setError(null);
      } catch (err) { setError(err); }
      finally { saving.current = false; }
    }, 700);
    return () => clearTimeout(timer);
  }, [notes, saved, retry, sitting.notesEnabled, disabled, key, examId]);
  useEffect(() => {
    if (!sitting.notesForDoctorEnabled || disabled || doctorNotes === doctorSaved) return;
    try { sessionStorage.setItem(doctorKey, doctorNotes); } catch { /* server save still works */ }
    const timer = setTimeout(async () => {
      if (doctorSaving.current) { setDoctorRetry((n) => n + 1); return; }
      doctorSaving.current = true;
      try {
        await request(`/api/v1/student/exams/${examId}/notes-for-doctor`, "PATCH", { notes: doctorNotes });
        setDoctorSaved(doctorNotes); setDoctorError(null);
      } catch (err) { setDoctorError(err); }
      finally { doctorSaving.current = false; }
    }, 700);
    return () => clearTimeout(timer);
  }, [doctorNotes, doctorSaved, doctorRetry, sitting.notesForDoctorEnabled, disabled, doctorKey, examId]);
  // Calculator follows the exam-tools toggle; each notes box follows only its
  // own flag, so disabling tools never hides an enabled notes box.
  const calcOn = sitting.examToolsEnabled !== false;
  if (!calcOn && !sitting.notesEnabled && !sitting.notesForDoctorEnabled) return null;
  return <section className="exam-tools">
    <h3>{t("Exam tools")}</h3>
    <div className="action-row">
      {calcOn && <button type="button" className="secondary" aria-pressed={tool === "calculator"} onClick={() => setTool(tool === "calculator" ? null : "calculator")}>{t("Calculator")}</button>}
      {sitting.notesEnabled && <button type="button" className="secondary" aria-pressed={tool === "notes"} onClick={() => setTool(tool === "notes" ? null : "notes")}>{t("Notes")}</button>}
      {sitting.notesForDoctorEnabled && <button type="button" className="secondary" aria-pressed={tool === "doctor-notes"} onClick={() => setTool(tool === "doctor-notes" ? null : "doctor-notes")}>{t("Notes for doctor")}</button>}
    </div>
    {tool === "calculator" && calcOn && <Calculator />}
    {tool === "notes" && sitting.notesEnabled && <div className="field">
      <label htmlFor="exam-notes">{t("Private scratch notes (not graded)")}</label>
      <textarea id="exam-notes" rows={9} maxLength={20000} disabled={disabled} value={notes} onChange={(e) => setNotes(e.target.value)} />
      <small role="status">{notes === saved ? t("Notes saved") : t("Notes not yet saved")}</small>
      <Feedback error={error} />
      {error != null && <button type="button" onClick={() => setRetry((n) => n + 1)}>{t("Retry saves")}</button>}
    </div>}
    {tool === "doctor-notes" && sitting.notesForDoctorEnabled && <div className="field">
      <label htmlFor="exam-doctor-notes">{t("Notes for the doctor")}</label>
      <textarea id="exam-doctor-notes" rows={9} maxLength={20000} disabled={disabled} value={doctorNotes} onChange={(e) => setDoctorNotes(e.target.value)} />
      <small role="status">{doctorNotes === doctorSaved ? t("Notes saved") : t("Notes not yet saved")}</small>
      <Feedback error={doctorError} />
      {doctorError != null && <button type="button" onClick={() => setDoctorRetry((n) => n + 1)}>{t("Retry saves")}</button>}
    </div>}
  </section>;
}

function Calculator() {
  const t = useT();
  const [base, setBase] = useState<NumBase>(10);
  const [angle, setAngle] = useState<AngleMode>("deg");
  const [inv, setInv] = useState(false);
  const [expr, setExpr] = useState("");
  const [ans, setAns] = useState(0);
  const [hist, setHist] = useState<{ expr: string; out: string; value: number | null }[]>([]);
  const [done, setDone] = useState<null | { expr: string; out: string }>(null);
  // Exact decimal of the last base conversion (fractional parts don't survive
  // integer bases — the readout keeps showing the true value until next edit).
  const [pinnedDec, setPinnedDec] = useState<string | null>(null);
  // Live preview while typing; errors stay silent until = is pressed.
  const live = useMemo(() => {
    if (!expr.trim()) return null;
    const r = evaluate(expr, base, angle, ans);
    return typeof r === "number" ? formatValue(r, base) : null;
  }, [expr, base, angle, ans]);
  const shownExpr = done ? done.expr : expr || "0";
  const shownOut = done ? done.out : (live ?? "");
  function smartInsert(text: string, continues: boolean) {
    setPinnedDec(null);
    if (done && !continues) {
      setDone(null);
      setExpr(text);
      return;
    }
    if (done && continues) {
      // Continue with the previous answer when it parses in this base.
      const continued = base === 10 ? `${trimNum(ans)}${text}` : text;
      setDone(null);
      setExpr(continued);
      return;
    }
    setDone(null);
    setExpr((old) => old + text);
  }
  function press(key: string) {
    if (key === "C") { setExpr(""); setDone(null); setPinnedDec(null); return; }
    if (key === "⌫") {
      if (done) { setDone(null); setExpr(""); setPinnedDec(null); return; }
      setExpr((old) => old.slice(0, -1));
      setPinnedDec(null);
      return;
    }
    if (key === "=") {
      if (!expr.trim()) return;
      const r = evaluate(expr, base, angle, ans);
      if (typeof r === "number") {
        const out = formatValue(r, base);
        setAns(clean(r));
        setHist((h) => [{ expr, out, value: clean(r) }, ...h].slice(0, 5));
        setDone({ expr, out });
      } else {
        setDone({ expr, out: `Error: ${r.error}` });
      }
      return;
    }
    if (key === "±") {
      if (done) return;
      // Negate the trailing number, else append a minus.
      setExpr((old) => {
        const m = old.match(/(\d+\.?\d*(E[+-]?\d+)?)\s*$/i);
        if (!m) return old + "-";
        const num = m[1];
        const head = old.slice(0, old.length - num.length);
        const neg = head.match(/-\s*$/);
        if (neg) return head.slice(0, -1) + num;
        return `${head}-${num}`;
      });
      return;
    }
    if (key === "x²") return smartInsert(done ? "ans^2" : "^2", true);
    if (key === "xʸ") return smartInsert("^", true);
    if (key === "1/x") return smartInsert("recip(", false);
    if (key === "√") return smartInsert("sqrt(", false);
    if (key === "EXP") return smartInsert("E", true);
    if (key === "Ans") return smartInsert("ans", false);
    if (key === "π") return smartInsert("pi", false);
    if (["sin", "cos", "tan", "asin", "acos", "atan", "log", "ln"].includes(key))
      return smartInsert(`${key}(`, false);
    smartInsert(key, /^[+\-*/^!%)]$/.test(key));
  }
  const digitOk = (d: string): boolean =>
    base === 10 || (base === 16 ? /^[0-9A-Fa-f]$/.test(d) : base === 8 ? /^[0-7]$/.test(d) : /^[01]$/.test(d));
  // Decimal value of whatever is showing, for the base-conversion readout.
  // A pinned exact value (from a base switch) wins until the next edit.
  const decReadout = (() => {
    if (base === 10 || done?.out?.startsWith("Error")) return null;
    if (pinnedDec) return `= ${pinnedDec}`;
    const src = done ? done.expr : expr;
    if (!src.trim()) return null;
    const r = evaluate(src, base, angle, ans);
    return typeof r === "number" ? `= ${formatValue(r, 10)}` : null;
  })();
  // Switching bases converts the current value instead of erasing it.
  // Unparseable text can't convert, so it clears (nothing valid to keep).
  function convertBase(nb: NumBase) {
    if (nb === base) return;
    let value: number | null = null;
    if (done && !done.out.startsWith("Error")) value = ans;
    else if (expr.trim()) {
      const r = evaluate(expr, base, angle, ans);
      if (typeof r === "number") value = r;
    } else {
      setBase(nb);
      setDone(null);
      setPinnedDec(null);
      return;
    }
    setBase(nb);
    setDone(null);
    if (value === null) {
      setExpr("");
      setPinnedDec(null);
      return;
    }
    setExpr(nb === 10 ? trimNum(value) : formatValue(value, nb));
    setPinnedDec(Number.isInteger(value) ? null : formatValue(value, 10));
  }
  function onKey(e: { key: string; stopPropagation: () => void }) {
    const k = e.key;
    const map: Record<string, string> = { "*": "×", "/": "÷", Enter: "=", Escape: "C", Backspace: "⌫" };
    if (k === "Enter" || k === "Escape" || k === "Backspace") {
      e.stopPropagation();
      press(map[k]);
      return;
    }
    let key: string | null = null;
    if (/^[0-9a-fA-F]$/.test(k) && digitOk(k.toUpperCase()) && (base === 10 || base === 16 || /^[01]$/.test(k) || /^[0-7]$/.test(k))) {
      if (base === 10 || digitOk(k.toUpperCase())) key = k.toUpperCase();
    } else if (".+-^%()!".includes(k)) {
      key = k === "." && base !== 10 ? null : k;
    } else if (k === "*" || k === "/") {
      key = map[k];
    }
    if (key) {
      e.stopPropagation();
      press(key);
    }
  }
  const dec = base === 10;
  const hexDigits = ["A", "B", "C", "D", "E", "F"];
  return <div className="exam-calculator" aria-label={t("Calculator")} onKeyDown={onKey}>
    <div className="calc-modes" role="group" aria-label={t("Calculator modes")}>
      {([["DEC", 10], ["HEX", 16], ["OCT", 8], ["BIN", 2]] as [string, NumBase][]).map(([label, b]) => (
        <button key={label} type="button" className={base === b ? "on" : ""} aria-pressed={base === b}
          onClick={() => convertBase(b)}>
          {label}
        </button>
      ))}
      {dec && (
        <button type="button" className="calc-angle" aria-pressed={angle === "rad"}
          title={t("Toggle degrees / radians")}
          onClick={() => setAngle((a) => (a === "deg" ? "rad" : "deg"))}>
          {angle === "deg" ? t("DEG") : t("RAD")}
        </button>
      )}
    </div>
    <div className="calc-display" aria-live="polite" dir="ltr" tabIndex={0}>
      <div className="calc-expr">{shownExpr}</div>
      <output className="calc-out">{shownOut}{decReadout ? <span className="calc-dec"> ({t("DEC")} {decReadout.slice(2)})</span> : null}</output>
    </div>
    {dec ? (
      <div className="calculator-keys calc-sci" dir="ltr">
        {(inv ? ["asin", "acos", "atan", "√"] : ["sin", "cos", "tan", "√"]).map((key) => <button key={key} type="button" className="calc-fn" onClick={() => press(key)}>{key}</button>)}
        {["log", "ln", "x²", "xʸ"].map((key) => <button key={key} type="button" className="calc-fn" onClick={() => press(key)}>{key}</button>)}
        {["π", "e", "1/x", "!"].map((key) => <button key={key} type="button" className="calc-fn" onClick={() => press(key)}>{key}</button>)}
        <button type="button" className="calc-fn" onClick={() => setInv((v) => !v)} aria-pressed={inv} title={t("Inverse functions")}>INV</button>
        {["(", ")", "C", "⌫"].map((key) => <button key={key} type="button" className="calc-fn" onClick={() => press(key)}>{key}</button>)}
        {["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ".", "EXP", "+", "%", "±", "Ans", "="].map((key) => <button key={key} type="button" className={key === "=" ? "calc-eq" : ""} onClick={() => press(key)}>{key}</button>)}
      </div>
    ) : (
      <div className="calculator-keys" dir="ltr">
        {base === 16 && hexDigits.map((d) => <button key={d} type="button" onClick={() => press(d)}>{d}</button>)}
        {["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", "C", "⌫", "+", "(", ")", "Ans", "="].map((key) => (
          <button
            key={key}
            type="button"
            className={key === "=" ? "calc-eq" : ""}
            disabled={!(key === "=" || key === "C" || key === "⌫" || key === "Ans" || "+−×÷()".includes(key) || digitOk(key))}
            onClick={() => press(key === "Ans" ? "Ans" : key)}
          >
            {key}
          </button>
        ))}
      </div>
    )}
    {hist.length > 0 && <ol className="calc-history" aria-label={t("History")}>
      {hist.map((h, i) => (
        <li key={`${h.expr}-${i}`}>
          <button type="button" title={t("Reuse result")} onClick={() => { setDone(null); setPinnedDec(null); setExpr(h.value === null ? h.out : formatValue(h.value, base)); }}>
            <span dir="ltr">{h.expr} =</span> <b dir="ltr">{h.out}</b>
          </button>
        </li>
      ))}
    </ol>}
  </div>;
}

/** Shortest decimal text that re-parses to the same value. */
function trimNum(n: number): string {
  return formatValue(n, 10);
}
