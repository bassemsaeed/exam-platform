import { useEffect, useRef, useState } from "react";
import { request, type Sitting } from "../lib/platform";
import { useT } from "../lib/i18n";
import { Feedback } from "./ui";

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
  const [display, setDisplay] = useState("0");
  const [stored, setStored] = useState<number | null>(null);
  const [operator, setOperator] = useState<string | null>(null);
  const [fresh, setFresh] = useState(true);
  function press(key: string) {
    if (key === "C") { setDisplay("0"); setStored(null); setOperator(null); setFresh(true); return; }
    if (/^[0-9.]$/.test(key)) {
      setDisplay((old) => {
        if (fresh || old === "Error") return key === "." ? "0." : key;
        if (key === "." && old.includes(".")) return old;
        return old.length < 16 ? (old === "0" && key !== "." ? key : old + key) : old;
      });
      setFresh(false); return;
    }
    if (key === "±") { setDisplay(String(-Number(display))); return; }
    if (key === "√") {
      const r = Math.sqrt(Number(display));
      if (!Number.isFinite(r)) { setDisplay("Error"); setStored(null); setOperator(null); setFresh(true); return; }
      setDisplay(String(Number(r.toPrecision(12)))); setFresh(true); return;
    }
    if (key === "%") {
      setDisplay(String(Number((Number(display) / 100).toPrecision(12)))); setFresh(true); return;
    }
    const value = Number(display);
    let result = value;
    if (stored !== null && operator && !fresh) {
      result =
        operator === "+" ? stored + value :
        operator === "-" ? stored - value :
        operator === "×" ? stored * value :
        operator === "÷" ? stored / value :
        operator === "^" ? Math.pow(stored, value) : value;
    }
    if (!Number.isFinite(result)) { setDisplay("Error"); setStored(null); setOperator(null); setFresh(true); return; }
    setDisplay(String(Number(result.toPrecision(12))));
    setStored(key === "=" ? null : result);
    setOperator(key === "=" ? null : key); setFresh(true);
  }
  return <div className="exam-calculator" aria-label={t("Calculator")}>
    <output aria-live="polite" dir="ltr">{display}</output>
    <div className="calculator-keys" dir="ltr">
      {["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "-", "0", ".", "=", "+", "C", "±", "√", "^", "%"].map((key) => <button key={key} type="button" onClick={() => press(key)}>{key}</button>)}
    </div>
  </div>;
}
