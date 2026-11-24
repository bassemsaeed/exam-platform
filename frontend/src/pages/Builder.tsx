import { useT } from "../lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  FileText,
  KeyRound,
  Layers,
  ListChecks,
  Minus,
  Plus,
  Settings2,
  Users,
  Video,
  Volume2,
} from "lucide-react";
import { api, type SessionUser } from "../lib/api";
import {
  label,
  rowsOf,
  useAction,
  useResource,
  type Entity,
  type Envelope,
  type Exam,
  type Question,
  type Subject,
} from "../lib/platform";
import { apiUrl } from "../lib/seb";
import { Badge, Dialog, Empty, Feedback, Loading, PageTitle } from "../components/ui";
import { Combo, DateTimeField, MultiPicker, Sheet } from "../components/builder";
import { InstructionsEditor } from "../components/Instructions";
import { ExamStudentImport } from "../components/ExamStudentImport";
import { QuestionMediaPlayer, questionDisplayText } from "../components/QuestionMedia";
import {
  ALL_QUESTION_TYPES,
  QuestionOptionsSummary,
  extractPairs,
  questionTypeLabel,
  safeJsonParse,
} from "../components/QuestionTypesUI";

const STEPS = ["Settings", "Audience", "Blueprint", "Review"];

const DRAFT_KEY = (uid: string) => `exam-draft-${uid}`;

function loadDraft(uid: string) {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY(uid));
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Student-view preview of the exam being built: hand-picked questions in
// author order, or the pool the mix will sample from (actual sit samples
// randomly at start time).
function ExamPreview({
  manual,
  picked,
  mix,
  questions,
}: {
  manual: boolean;
  picked: string[];
  mix: { easy: number; medium: number; hard: number };
  questions: {
    id: string;
    text: string;
    questionType?: string;
    options: Question["options"];
    correctAnswer?: string;
    grade: number;
    difficulty: string;
    imageUrl?: string | null;
    mediaUrl?: string | null;
    mediaType?: "audio" | "video" | null;
  }[];
}) {
  const t = useT();
  const byId = new Map(questions.map((q) => [q.id, q]));
  const list = manual
    ? picked.map((id) => byId.get(id)).filter((q) => q !== undefined)
    : (["easy", "medium", "hard"] as const).flatMap((d) =>
        questions.filter((q) => q.difficulty === d).slice(0, mix[d]),
      );
  if (!list.length)
    return (
      <Empty
        title={t("Nothing to preview yet")}
        text={
          manual
            ? t("Hand-pick at least one question in the Blueprint step.")
            : t("Raise the difficulty mix or add questions to the bank.")
        }
      />
    );
  return (
    <>
      {!manual && (
        <p className="subtle">
          {t("Pool sample — the server draws fresh random questions per student at start time.")}
        </p>
      )}
      <div className="live-preview">
        {list.map((q, i) => (
          <div className="preview-card" key={q.id}>
            <p>
              <b>{i + 1}. </b>
              {questionDisplayText(q, t)}
            </p>
            {q.mediaUrl && q.mediaType && (
              <QuestionMediaPlayer
                mediaUrl={q.mediaUrl}
                mediaType={q.mediaType}
                compact
              />
            )}
            {q.imageUrl && (
              <img
                className="question-image"
                src={q.imageUrl.startsWith("/") ? apiUrl(q.imageUrl) : q.imageUrl}
                alt={t("Question diagram")}
              />
            )}
            <QuestionOptionsSummary
              questionType={q.questionType ?? "mcq"}
              options={q.options}
              correctAnswer={q.correctAnswer}
            />
            <small>
              {q.grade} {t("marks")} · {t(label(q.difficulty))} ·{" "}
              {questionTypeLabel(q.questionType ?? "mcq", t)}
            </small>
          </div>
        ))}
      </div>
    </>
  );
}

export function ExamWizard({ user }: { user: SessionUser }) {
  const t = useT();
  const navigate = useNavigate();
  const subjects = useResource<Envelope<Subject>>(
    user,
    "/api/v1/exams/subjects?limit=100",
  );
  const subjectOpts = useMemo(
    () =>
      rowsOf(subjects.data).map((s) => ({
        value: s.id,
        label: `${s.code} · ${s.name}`,
        sub: s.name,
      })),
    [subjects.data],
  );
  const [step, setStep] = useState(0);
  const [subject, setSubject] = useState("");
  const [duration, setDuration] = useState(45);
  // Kind: doctors/admins choose midterm (approved) or quiz (instant);
  // TAs only ever make quizzes.
  const canMidterm = user.role !== "ta";
  const [purpose, setPurpose] = useState<"midterm" | "quiz">(canMidterm ? "midterm" : "quiz");
  const [title, setTitle] = useState("");
  const [sebRequired, setSebRequired] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [instructionsText, setInstructionsText] = useState("");
  const [instructionsRequireCompletion, setInstructionsRequireCompletion] = useState(false);
  const [pendingMediaFile, setPendingMediaFile] = useState<File | null>(null);
  const [pendingMediaType, setPendingMediaType] = useState<"audio" | "video" | null>(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [createdWarn, setCreatedWarn] = useState<{ id: string; warnings: string[] } | null>(null);
  const [notesEnabled, setNotesEnabled] = useState(false);
  const [resultsReleased, setResultsReleased] = useState(false);
  const [examToolsEnabled, setExamToolsEnabled] = useState(true);
  const [notesForDoctorEnabled, setNotesForDoctorEnabled] = useState(false);
  const [maxReentries, setMaxReentries] = useState(3);
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [scope, setScope] = useState(user.role === "ta" ? "sections" : "subject");
  const [sectionSel, setSectionSel] = useState<string[]>([]);
  const [pickedStudents, setPickedStudents] = useState<string[]>([]);
  const [importedStudentsMeta, setImportedStudentsMeta] = useState<
    { id: string; name: string; username?: string | null; sub?: string }[]
  >([]);
  const [source, setSource] = useState("shared");
  const [manual, setManual] = useState(false);
  const [mix, setMix] = useState({ easy: 3, medium: 2, hard: 1 });
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);
  const [qSearch, setQSearch] = useState("");
  // Draft autosave: a refresh never wipes the wizard. Restored once on mount.
  useEffect(() => {
    const d = loadDraft(user.id);
    if (!d) return;
    if (
      !d.subject && !d.startLocal && !d.endLocal && !d.title && !d.instructionsText &&
      !(Array.isArray(d.picked) && d.picked.length) &&
      !(Array.isArray(d.sectionSel) && d.sectionSel.length) &&
      !(Array.isArray(d.pickedStudents) && d.pickedStudents.length)
    )
      return;
    if (typeof d.subject === "string") setSubject(d.subject);
    if (typeof d.notesEnabled === "boolean") setNotesEnabled(d.notesEnabled);
    if (typeof d.resultsReleased === "boolean") setResultsReleased(d.resultsReleased);
    if (typeof d.examToolsEnabled === "boolean") setExamToolsEnabled(d.examToolsEnabled);
    if (typeof d.notesForDoctorEnabled === "boolean") setNotesForDoctorEnabled(d.notesForDoctorEnabled);
    if (typeof d.maxReentries === "number") setMaxReentries(d.maxReentries);
    if (typeof d.duration === "number") setDuration(d.duration);
    if (d.purpose === "midterm" || d.purpose === "quiz") setPurpose(canMidterm ? d.purpose : "quiz");
    if (typeof d.title === "string") setTitle(d.title);
    if (typeof d.sebRequired === "boolean") setSebRequired(d.sebRequired);
    if (typeof d.instructionsText === "string") setInstructionsText(d.instructionsText);
    if (typeof d.instructionsRequireCompletion === "boolean") setInstructionsRequireCompletion(d.instructionsRequireCompletion);
    if (typeof d.startLocal === "string") setStartLocal(d.startLocal);
    if (typeof d.endLocal === "string") setEndLocal(d.endLocal);
    if (typeof d.scope === "string") setScope(d.scope);
    if (Array.isArray(d.sectionSel)) setSectionSel(d.sectionSel as string[]);
    if (Array.isArray(d.pickedStudents)) setPickedStudents(d.pickedStudents as string[]);
    if (typeof d.source === "string") setSource(d.source);
    if (typeof d.manual === "boolean") setManual(d.manual);
    if (d.mix && typeof d.mix === "object")
      setMix({ easy: 0, medium: 0, hard: 0, ...(d.mix as object) });
    if (Array.isArray(d.picked)) setPicked(d.picked as string[]);
    if (typeof d.step === "number") setStep(Math.min(3, Math.max(0, d.step)));
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const draftDirty =
    !!subject || !!startLocal || !!endLocal || !!title || !!instructionsText || sectionSel.length > 0 ||
    pickedStudents.length > 0 || picked.length > 0;
  useEffect(() => {
    try {
      if (!draftDirty) {
        sessionStorage.removeItem(DRAFT_KEY(user.id));
        return;
      }
      sessionStorage.setItem(
        DRAFT_KEY(user.id),
        JSON.stringify({
          subject, duration, purpose, title, sebRequired, instructionsText, instructionsRequireCompletion,
          notesEnabled, resultsReleased, notesForDoctorEnabled, examToolsEnabled, maxReentries, startLocal, endLocal, scope, sectionSel,
          pickedStudents, source, manual, mix, picked, step,
        }),
      );
    } catch {
      // storage full/blocked: builder still works, just not resumable
    }
  }, [user.id, draftDirty, subject, duration, purpose, title, sebRequired, instructionsText, instructionsRequireCompletion, notesEnabled, resultsReleased, notesForDoctorEnabled, examToolsEnabled, maxReentries, startLocal, endLocal, scope, sectionSel, pickedStudents, source, manual, mix, picked, step]);

  const sections = useResource<Envelope<Entity>>(
    user,
    `/api/v1/exams/sections?subject_id=${subject}`,
    !!subject && (step >= 1 || scope === "sections"),
  );
  const roster = useResource<{
    totalEnrolled: number;
    enrolledStudents?: { id: string; username: string; name: string }[];
    sections: {
      id: string;
      name: string;
      students: { id: string; username: string; name: string }[];
    }[];
  }>(
    user,
    `/api/v1/exams/roster?subject_id=${subject}`,
    !!subject && scope === "student_list",
  );
  const bank = useResource<Envelope<Question>>(
    user,
    `/api/v1/question-bank?subject_id=${subject}&limit=100${user.role === "ta" && source === "mine" ? "&mine=true" : ""}`,
    !!subject && (manual || step === 3) && step >= 2,
  );
  const action = useAction<Exam>(user, ["/api/v1/exams", "/api/v1/admin/exams"]);
  // Own exams (for the quiz-number suggestion + duplicate-name nudge).
  const mine = useResource<Envelope<Exam>>(user, "/api/v1/exams/mine?limit=100");
  const sameSubject = rowsOf(mine.data).filter((e) => e.subjectId === subject);
  const quizNumbers = sameSubject
    .map((e) => /^quiz\s+(\d+)\b/i.exec(e.title ?? "")?.[1])
    .filter((n): n is string => !!n)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const suggestedQuiz = `Quiz ${quizNumbers.length ? Math.max(...quizNumbers) + 1 : 1}`;
  const dupeName =
    title.trim() &&
    sameSubject.some(
      (e) => (e.title ?? "").trim().toLowerCase() === title.trim().toLowerCase(),
    );
  const totalQ = mix.easy + mix.medium + mix.hard;
  // Smart close: picking Opens auto-fills Closes (opens + duration, min 60m
  // window) until the user overrides it by hand.
  const [closeTouched, setCloseTouched] = useState(false);
  useEffect(() => {
    if (!startLocal || closeTouched) return;
    const b = new Date(startLocal).getTime();
    if (Number.isNaN(b)) return;
    const dt = new Date(b + Math.max(60, duration) * 60000);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}T${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
    setEndLocal(iso);
  }, [startLocal, duration, closeTouched]);

  const studentPickerOptions = useMemo(() => {
    const secNamesByStudent = new Map<string, string[]>();
    for (const sec of roster.data?.sections ?? []) {
      for (const st of sec.students) {
        const list = secNamesByStudent.get(st.id) ?? [];
        if (!list.includes(sec.name)) list.push(sec.name);
        secNamesByStudent.set(st.id, list);
      }
    }
    const base: { id: string; name: string; username?: string; sub: string }[] = [];
    const seen = new Set<string>();
    if (roster.data?.enrolledStudents?.length) {
      for (const st of roster.data.enrolledStudents) {
        seen.add(st.id);
        base.push({
          id: st.id,
          name: st.name,
          username: st.username,
          sub: secNamesByStudent.get(st.id)?.join(", ") || t("Enrolled"),
        });
      }
    } else {
      for (const sec of roster.data?.sections ?? []) {
        for (const st of sec.students) {
          if (seen.has(st.id)) continue;
          seen.add(st.id);
          base.push({
            id: st.id,
            name: st.name,
            username: st.username,
            sub: secNamesByStudent.get(st.id)?.join(", ") || sec.name,
          });
        }
      }
    }
    for (const imp of importedStudentsMeta) {
      if (seen.has(imp.id)) continue;
      seen.add(imp.id);
      base.push({
        id: imp.id,
        name: imp.name,
        username: imp.username ?? undefined,
        sub: imp.sub || t("Imported via spreadsheet"),
      });
    }
    return base;
  }, [roster.data, importedStudentsMeta, t]);

  function valid(s: number): string {
    if (s === 0) {
      if (!subject) return "Choose a subject to continue.";
      if (!title.trim()) return "Give this assessment a title.";
      if (title.trim().length > 120) return "Title must be 120 characters or less.";
      if (!duration || duration < 1) return "Set a duration of at least 1 minute.";
      if (!startLocal || !endLocal) return "Pick opening and closing times.";
      const a = new Date(startLocal).getTime();
      const b = new Date(endLocal).getTime();
      if (Number.isNaN(a) || Number.isNaN(b)) return "Pick valid opening and closing times.";
      if (b <= a) return "Closing time must be after opening time.";
      if (duration * 60_000 > b - a) return "Duration cannot exceed the exam window.";
      const effPurpose = canMidterm ? purpose : "quiz";
      if (effPurpose === "quiz" && accessCode.trim() && accessCode.trim().length < 4) {
        return "Quiz entry code must be at least 4 characters (or leave blank for open entry).";
      }
    }
    if (s === 1) {
      if (scope === "sections" && !sectionSel.length)
        return "Select at least one section.";
      if (scope === "student_list" && !pickedStudents.length)
        return "Pick at least one enrolled student.";
    }
    if (s === 2) {
      if (manual && !picked.length) return "Hand-pick at least one question.";
      if (!manual && totalQ < 1) return "Add at least one question to the mix.";
      if (!manual && Object.values(mix).some((n) => !Number.isFinite(n) || n < 0))
        return "Difficulty counts must be zero or positive.";
    }
    return "";
  }
  function next() {
    const v = valid(step);
    setError(v);
    if (!v) setStep((x) => Math.min(3, x + 1));
  }
  function submit() {
    setError("");
    const startTime = new Date(startLocal).toISOString();
    const endTime = new Date(endLocal).toISOString();
    const effectivePurpose = canMidterm ? purpose : "quiz";
    action.mutate(
      {
        path: "/api/v1/exams",
        body: {
          subjectId: subject,
          type: user.role === "ta" ? "ta_quiz" : "doctor_exam",
          title: title.trim(),
          purpose: effectivePurpose,
          sebRequired,
          ...(effectivePurpose === "quiz" && accessCode.trim()
            ? { accessCode: accessCode.trim() }
            : {}),
          instructionsText: instructionsText.trim() || null,
          instructionsRequireCompletion: Boolean(pendingMediaFile && instructionsRequireCompletion),
          startTime,
          endTime,
          durationMinutes: duration,
          notesEnabled, notesForDoctorEnabled, examToolsEnabled, maxReentries, resultsReleased,
          targetScope: scope,
          ...(scope === "sections" ? { targetSections: sectionSel } : {}),
          ...(scope === "student_list"
            ? { targetStudents: pickedStudents }
            : {}),
          questionSource: user.role === "ta" ? source : "own",
          ...(manual ? { manualQuestionIds: picked } : { difficultyMix: mix }),
        },
      },
      {
        onSuccess: async (e) => {
          try {
            sessionStorage.removeItem(DRAFT_KEY(user.id));
          } catch {
            // ignore
          }
          if (pendingMediaFile && pendingMediaType) {
            setUploadingMedia(true);
            try {
              const fd = new FormData();
              fd.append("media", pendingMediaFile);
              fd.append("mediaType", pendingMediaType);
              await api.upload(`/api/v1/exams/${e.id}/instructions-media`, fd);
            } catch (uploadErr) {
              setError(
                uploadErr instanceof Error
                  ? `Assessment created, but media upload failed: ${uploadErr.message}. You can re-upload from the assessment page.`
                  : "Assessment created, but media upload failed.",
              );
            } finally {
              setUploadingMedia(false);
            }
          }
          const warnings = (e as unknown as { warnings?: string[] })?.warnings;
          if (warnings?.length) setCreatedWarn({ id: e.id, warnings });
          else navigate("/exams/" + e.id);
        },
      },
    );
  }
  const mixNudge = (k: keyof typeof mix, d: number) =>
    setMix((m) => ({ ...m, [k]: Math.max(0, (m[k] ?? 0) + d) }));
  const subjName =
    rowsOf(subjects.data).find((s) => s.id === subject)?.name ?? "";
  const filteredBankRows = rowsOf(bank.data).filter((q) =>
    !qSearch.trim() ||
    q.text.toLowerCase().includes(qSearch.trim().toLowerCase()) ||
    q.difficulty.toLowerCase().includes(qSearch.trim().toLowerCase()),
  );

  return (
    <>
      <PageTitle
        title={t("Create assessment")}
        description={t("Settings → audience → blueprint → review.")}
      />
      <Link className="back-link" to="/exams">
        {t(" ← Back to exams ")}
      </Link>
      {restored && (
        <div className="info-banner" role="status">
          <span className="orange-dot" />
          <span>{t("Draft restored from your last visit.")}</span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              try {
                sessionStorage.removeItem(DRAFT_KEY(user.id));
              } catch {
                // ignore
              }
              setSubject("");
              setTitle("");
              setPurpose(canMidterm ? "midterm" : "quiz");
              setSebRequired(false);
              setNotesEnabled(false);
              setResultsReleased(false);
              setExamToolsEnabled(true);
              setNotesForDoctorEnabled(false);
              setMaxReentries(3);
              setDuration(45);
              setStartLocal("");
              setEndLocal("");
              setCloseTouched(false);
              setScope(user.role === "ta" ? "sections" : "subject");
              setSectionSel([]);
              setPickedStudents([]);
              setSource("shared");
              setManual(false);
              setMix({ easy: 3, medium: 2, hard: 1 });
              setPicked([]);
              setStep(0);
              setRestored(false);
            }}
          >
            {t(" Discard draft ")}
          </button>
        </div>
      )}
      <div className="wizard">
        <ol className="wizard-steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "on" : i < step ? "done" : ""}>
              <button type="button" onClick={() => i < step && setStep(i)}>
                <span>{i < step ? <Check size={13} /> : i + 1}</span>
                {t(s)}
              </button>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <section className="panel">
            <h2>
              <Settings2 size={16} /> {t("Assessment settings")}
            </h2>
            {canMidterm && (
              <div className="field">
                <span className="field-label">{t("What are you making?")}</span>
                <div className="scope-cards two">
                  <button
                    type="button"
                    className={purpose === "midterm" ? "on" : ""}
                    aria-pressed={purpose === "midterm"}
                    onClick={() => setPurpose("midterm")}
                  >
                    <b>{t("Midterm exam")}</b>
                    <small>
                      {t("Needs admin approval. One live per subject.")}
                    </small>
                  </button>
                  <button
                    type="button"
                    className={purpose === "quiz" ? "on" : ""}
                    aria-pressed={purpose === "quiz"}
                    onClick={() => setPurpose("quiz")}
                  >
                    <b>{t("Quiz")}</b>
                    <small>{t("Goes live immediately, no approval.")}</small>
                  </button>
                </div>
              </div>
            )}
            <div className="field">
              <label htmlFor="exam-title">{t("Title")}</label>
              <input
                id="exam-title"
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={
                  purpose === "quiz" ? suggestedQuiz : t("Midterm – Algebra")
                }
                autoComplete="off"
              />
              {purpose === "quiz" && !title.trim() && (
                <small>
                  {t("Suggestion: {0}", { "0": suggestedQuiz })}
                </small>
              )}
              {dupeName ? (
                <small role="status">
                  {t(
                    "Another assessment already uses this title — students will tell them apart by date, but consider renaming.",
                  )}
                </small>
              ) : null}
            </div>
            <div className="field">
              <span className="field-label">{t("Subject")}</span>
              <Combo
                value={subject}
                options={subjectOpts}
                onChange={(v) => {
                  setSubject(v);
                  setSectionSel([]);
                  setPicked([]);
                  setPickedStudents([]);
                }}
                placeholder="Search subjects…"
                ariaLabel={t("Subject")}
              />
            </div>
            <div className="settings-section">
              <span className="field-label">{t("Assessment policies & tools")}</span>
              <div className="toggle-card-grid">
                <div className={`toggle-card ${sebRequired ? "on" : ""}`}>
                  <input
                    id="wiz-seb"
                    type="checkbox"
                    checked={sebRequired}
                    onChange={(e) => setSebRequired(e.target.checked)}
                  />
                  <div>
                    <label htmlFor="wiz-seb">{t("Require Safe Exam Browser")}</label>
                    <small>{t("Locks students into SEB with registered lab keys.")}</small>
                  </div>
                </div>
                <div className={`toggle-card ${resultsReleased ? "on" : ""}`}>
                  <input
                    id="wiz-release"
                    type="checkbox"
                    checked={resultsReleased}
                    onChange={(e) => setResultsReleased(e.target.checked)}
                  />
                  <div>
                    <label htmlFor="wiz-release">{t("Show grades to students immediately")}</label>
                    <small>{t("Otherwise scores stay hidden until you publish them.")}</small>
                  </div>
                </div>
                <div className={`toggle-card ${examToolsEnabled ? "on" : ""}`}>
                  <input
                    id="wiz-tools"
                    type="checkbox"
                    checked={examToolsEnabled}
                    onChange={(e) => setExamToolsEnabled(e.target.checked)}
                  />
                  <div>
                    <label htmlFor="wiz-tools">{t("Allow exam tools")}</label>
                    <small>{t("Enables the scientific/base calculator inside the runner.")}</small>
                  </div>
                </div>
                <div className={`toggle-card ${notesEnabled ? "on" : ""}`}>
                  <input
                    id="wiz-notes"
                    type="checkbox"
                    checked={notesEnabled}
                    onChange={(e) => setNotesEnabled(e.target.checked)}
                  />
                  <div>
                    <label htmlFor="wiz-notes">{t("Allow student notes")}</label>
                    <small>{t("Private scratchpad saved during the attempt (not graded).")}</small>
                  </div>
                </div>
                <div className={`toggle-card ${notesForDoctorEnabled ? "on" : ""}`}>
                  <input
                    id="wiz-doc-notes"
                    type="checkbox"
                    checked={notesForDoctorEnabled}
                    onChange={(e) => setNotesForDoctorEnabled(e.target.checked)}
                  />
                  <div>
                    <label htmlFor="wiz-doc-notes">{t("Allow student notes for the doctor")}</label>
                    <small>{t("Students can leave a short note visible in Results.")}</small>
                  </div>
                </div>
              </div>
            </div>

            <div className="form-grid">
              <div className="field">
                <label htmlFor="wiz-reentries">
                  {t("Maximum re-entries (excluding the first entry)")}
                </label>
                <input
                  id="wiz-reentries"
                  type="number"
                  min={0}
                  max={20}
                  value={maxReentries}
                  onChange={(e) =>
                    setMaxReentries(
                      Math.min(
                        20,
                        Math.max(
                          0,
                          Number.isFinite(Number(e.target.value))
                            ? Number(e.target.value)
                            : 0,
                        ),
                      ),
                    )
                  }
                  required
                />
              </div>
              {(!canMidterm || purpose === "quiz") ? (
                <div className="field">
                  <label htmlFor="wiz-quiz-code">
                    <KeyRound size={13} /> {t("Quiz entry code (optional)")}
                  </label>
                  <input
                    id="wiz-quiz-code"
                    value={accessCode}
                    maxLength={64}
                    onChange={(e) => setAccessCode(e.target.value)}
                    placeholder={t("Leave blank for open entry (or 4+ characters)")}
                    autoComplete="off"
                  />
                </div>
              ) : (
                <div className="field">
                  <span className="field-label">
                    <KeyRound size={13} /> {t("Midterm entry code")}
                  </span>
                  <p className="subtle field-static-note">
                    {t("Administrators set or rotate midterm entry codes during approval.")}
                  </p>
                </div>
              )}
            </div>

            <div className="field">
              <span className="field-label">{t("Duration")}</span>
              <div className="stepper">
                {[15, 30, 45, 60, 90, 120].map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={duration === m ? "on" : ""}
                    onClick={() => setDuration(m)}
                  >
                    {m}m
                  </button>
                ))}
                <span className="stepper-custom">
                  <button type="button" onClick={() => setDuration(Math.max(1, duration - 5))} aria-label={t("Shorter")}>
                    <Minus size={13} />
                  </button>
                  <b>{duration}m</b>
                  <button type="button" onClick={() => setDuration(duration + 5)} aria-label={t("Longer")}>
                    <Plus size={13} />
                  </button>
                </span>
              </div>
            </div>
            <div className="form-grid">
              <DateTimeField value={startLocal} onChange={setStartLocal} label="Opens at" />
              <DateTimeField
                value={endLocal}
                onChange={(v) => {
                  setEndLocal(v);
                  setCloseTouched(true);
                }}
                label="Closes at"
                min={startLocal}
                base={startLocal}
                offsets={[
                  { label: "+30m after opens", minutes: 30 },
                  { label: "+1h after opens", minutes: 60 },
                  { label: "+2h after opens", minutes: 120 },
                  { label: "+3h after opens", minutes: 180 },
                ]}
              />
            </div>
            {startLocal && endLocal && (
              <div className="window-bar" aria-hidden>
                <Clock size={13} />
                <span>
                  {t("Window")} ·{" "}
                  {Math.max(0, Math.round((new Date(endLocal).getTime() - new Date(startLocal).getTime()) / 60000))}{t(" min")} ·
                  {t(" sitting")} {duration}
                  {t(" min")}
                </span>
              </div>
            )}
            <p className="subtle">{t("Times use your browser's timezone.")}</p>

            <div className="wizard-divider" />
            <h3 className="wizard-subhead">
              <FileText size={15} /> {t("Pre-exam instructions")}
            </h3>
            <p className="subtle">
              {t("Optional briefing shown to students before they click Start. Add written guidance, a voice note, or a short video.")}
            </p>
            <InstructionsEditor
              text={instructionsText}
              onTextChange={setInstructionsText}
              requireCompletion={instructionsRequireCompletion}
              onRequireCompletionChange={setInstructionsRequireCompletion}
              pendingFile={pendingMediaFile}
              pendingMediaType={pendingMediaType}
              onPendingMediaChange={(file, mediaType) => {
                setPendingMediaFile(file);
                setPendingMediaType(mediaType);
              }}
              busy={action.isPending || uploadingMedia}
            />
          </section>
        )}

        {step === 1 && (
          <section className="panel">
            <h2>
              <Users size={16} /> {t("Audience")}
            </h2>
            <div className="scope-cards">
              {(user.role === "ta"
                ? ["sections", "student_list"]
                : ["subject", "sections", "student_list"]
              ).map((o) => (
                <button
                  key={o}
                  type="button"
                  className={scope === o ? "on" : ""}
                  onClick={() => setScope(o)}
                >
                  <b>{t(label(o))}</b>
                  <small>
                    {o === "subject"
                      ? t("Everyone enrolled")
                      : o === "sections"
                        ? t("Chosen sections only")
                        : t("Pick or import Excel (.xlsx)")}
                  </small>
                </button>
              ))}
            </div>
            {scope === "sections" && (
              <div className="chip-pick">
                <Feedback error={sections.error} />
                {rowsOf(sections.data).map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={sectionSel.includes(s.id) ? "on" : ""}
                    onClick={() =>
                      setSectionSel((v) =>
                        v.includes(s.id)
                          ? v.filter((x) => x !== s.id)
                          : [...v, s.id],
                      )
                    }
                  >
                    {sectionSel.includes(s.id) && <Check size={13} />}
                    {String(s.name)}
                  </button>
                ))}
                {!rowsOf(sections.data).length && !sections.isPending && (
                  <p className="subtle">{t("No sections for this subject yet.")}</p>
                )}
              </div>
            )}
            {scope === "student_list" && (
              <div className="student-list-step">
                <ExamStudentImport
                  subjectId={subject}
                  selectedIds={pickedStudents}
                  onApplyStudents={(ids, meta, mode) => {
                    setImportedStudentsMeta((prev) => {
                      const map = new Map(prev.map((p) => [p.id, p]));
                      for (const m of meta) map.set(m.id, m);
                      return [...map.values()];
                    });
                    setPickedStudents((prev) =>
                      mode === "merge"
                        ? [...new Set([...prev, ...ids])]
                        : [...new Set(ids)],
                    );
                  }}
                />
                <div className="field">
                  <span className="field-label">
                    {t("Target students")} ({pickedStudents.length} {t("selected")}
                    {roster.data?.totalEnrolled
                      ? ` · ${roster.data.totalEnrolled} ${t("enrolled")}`
                      : ""}
                    )
                  </span>
                  <Feedback error={roster.error} />
                  {roster.isPending ? (
                    <p className="subtle">{t("Loading enrolled students…")}</p>
                  ) : (
                    <MultiPicker
                      options={studentPickerOptions}
                      value={pickedStudents}
                      onChange={setPickedStudents}
                      placeholder="Search enrolled or imported students…"
                      emptyText="No students yet — import an .xlsx / .csv file above or select enrolled students."
                    />
                  )}
                </div>
              </div>
            )}
            {user.role === "ta" && (
              <div className="field">
                <span className="field-label">{t("Question source")}</span>
                <div className="scope-cards two">
                  {["shared", "mine"].map((o) => (
                    <button
                      key={o}
                      type="button"
                      className={source === o ? "on" : ""}
                      onClick={() => {
                        setSource(o);
                        setPicked([]);
                      }}
                    >
                      <b>{t(o === "shared" ? "Shared TA bank" : "My contributions")}</b>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {step === 2 && (
          <section className="panel">
            <h2>
              <Layers size={16} /> {t("Question blueprint")}
            </h2>
            <div className="segmented">
              <button type="button" className={!manual ? "active" : ""} onClick={() => setManual(false)}>
                {t(" Difficulty mix ")}
              </button>
              <button type="button" className={manual ? "active" : ""} onClick={() => setManual(true)}>
                {t(" Hand-pick ")}
              </button>
            </div>
            {!manual ? (
              <>
                <div className="mix-cards">
                  {(["easy", "medium", "hard"] as const).map((d) => (
                    <div className={`mix-card mix-${d}`} key={d}>
                      <b>{t(label(d))}</b>
                      <div>
                        <button type="button" onClick={() => mixNudge(d, -1)} aria-label={t("Fewer")}>
                          <Minus size={14} />
                        </button>
                        <strong>{mix[d]}</strong>
                        <button type="button" onClick={() => mixNudge(d, 1)} aria-label={t("More")}>
                          <Plus size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="subtle">
                  {t("Total")}: <b>{totalQ}</b>
                </p>
              </>
            ) : (
              <>
                <Feedback error={bank.error} />
                {bank.isPending ? (
                  <Loading />
                ) : !bank.error && !rowsOf(bank.data).length ? (
                  <Empty
                    title={t("Your bank for {0} is empty", { "0": subjName || t("this subject") })}
                    text={t("Doctors hand-pick from their own questions in this subject — other educators' banks stay private. Add questions (or import the spreadsheet) and come back; your draft is saved.")}
                  />
                ) : (
                <>
                {!bank.isPending && !bank.error && (
                  <div className="toolbar">
                    <input
                      type="search"
                      value={qSearch}
                      onChange={(e) => setQSearch(e.target.value)}
                      placeholder={t("Filter questions by text or difficulty…")}
                      aria-label={t("Filter questions")}
                    />
                    <span className="subtle">
                      {t("{0} questions in your bank", {
                        "0": bank.data?.total ?? rowsOf(bank.data).length,
                      })}
                    </span>
                  </div>
                )}
                <div className="question-pick-list modern">
                  {filteredBankRows.map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      className={picked.includes(q.id) ? "on" : ""}
                      onClick={() =>
                        setPicked((v) =>
                          v.includes(q.id)
                            ? v.filter((x) => x !== q.id)
                            : [...v, q.id],
                        )
                      }
                    >
                      <span className="pick-n">
                        {picked.includes(q.id) ? <Check size={13} /> : <ListChecks size={13} />}
                      </span>
                      <span>
                        {questionDisplayText(q, t)}
                        {q.mediaType === "video" && (
                          <span className="meta-pill inline-pill">
                            <Video size={11} /> {t("Video")}
                          </span>
                        )}
                        {q.mediaType === "audio" && (
                          <span className="meta-pill inline-pill">
                            <Volume2 size={11} /> {t("Audio")}
                          </span>
                        )}
                      </span>
                      <Badge value={q.difficulty} />
                    </button>
                  ))}
                </div>
                </>
                )}
                <p className="subtle">
                  {picked.length}
                  {t(" selected · order kept as picked")}
                </p>
              </>
            )}
          </section>
        )}

        {step === 3 && (
          <section className="panel">
            <h2>
              <Check size={16} /> {t("Review & create")}
            </h2>
            <dl className="details-list">
              <div><dt>{t("Subject")}</dt><dd>{subjName || "—"}</dd></div>
              <div><dt>{t("Duration")}</dt><dd>{duration}{t(" min")}</dd></div>
              <div><dt>{t("Opens")}</dt><dd>{startLocal || "—"}</dd></div>
              <div><dt>{t("Closes")}</dt><dd>{endLocal || "—"}</dd></div>
              <div><dt>{t("Audience")}</dt><dd>{t(label(scope))}{scope === "sections" ? ` (${sectionSel.length})` : scope === "student_list" ? ` (${pickedStudents.length} ${t("students")})` : ""}</dd></div>
              <div>
                <dt>{t("Questions")}</dt>
                <dd>{manual ? `${picked.length} hand-picked` : `${totalQ} (E${mix.easy}/M${mix.medium}/H${mix.hard})`}</dd>
              </div>
            </dl>
            <h2 className="preview-title">
              <ListChecks size={16} /> {t("Student preview")} —{" "}
              {t("exactly what the exam will look like")}
            </h2>
            <Feedback error={bank.error} />
            {bank.isPending ? (
              <Loading />
            ) : (
              <ExamPreview
                manual={manual}
                picked={picked}
                mix={mix}
                questions={rowsOf(bank.data)}
              />
            )}
          </section>
        )}

        <Feedback error={error || action.error} />
        {createdWarn && (
          <Dialog
            title={t("Created with a scheduling note")}
            onClose={() => setCreatedWarn(null)}
          >
            <p className="dialog-copy">{createdWarn.warnings.join(" ")}</p>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setCreatedWarn(null)}
              >
                {t(" Keep editing ")}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => navigate("/exams/" + createdWarn.id)}
              >
                {t(" View exam ")}
              </button>
            </div>
          </Dialog>
        )}
        <div className="builder-actions wizard-nav">
          <span>
            {step > 0 && (
              <button type="button" className="secondary" onClick={() => { setError(""); setStep((x) => x - 1); }}>
                <ArrowLeft size={14} /> {t(" Back ")}
              </button>
            )}
          </span>
          <span className="action-row">
            <Link className="button secondary" to="/exams">{t(" Cancel ")}</Link>
            {step < 3 ? (
              <button type="button" className="primary" onClick={next}>
                {t(" Continue ")} <ArrowRight size={14} />
              </button>
            ) : (
              <button type="button" className="primary" disabled={action.isPending} onClick={submit}>
                {action.isPending
                  ? t("Creating…")
                  : user.role === "ta" || purpose === "quiz"
                    ? t("Create quiz")
                    : user.role === "admin"
                      ? t("Create assessment")
                      : t("Submit for approval")}
              </button>
            )}
          </span>
        </div>
      </div>
    </>
  );
}

export interface QDraft {
  text: string;
  questionType: string;
  options: string[];
  correctAnswer: string;
  grade: number;
  difficulty: string;
}

// Modern side-sheet question editor supporting all 7 question types with live student-view preview.
export function QuestionSheet({
  initial,
  subjectLocked,
  busy,
  error,
  onClose,
  onSubmit,
  imageUpload,
  mediaUpload,
  hasPendingAttachment = false,
  pendingMedia = null,
  pendingImageUrl = null,
}: {
  initial: Partial<Question> & { options?: Question["options"] | string };
  subjectLocked?: boolean;
  busy?: boolean;
  error?: unknown;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  imageUpload?: React.ReactNode;
  mediaUpload?: React.ReactNode;
  hasPendingAttachment?: boolean;
  pendingMedia?: { url: string; type: "audio" | "video" } | null;
  pendingImageUrl?: string | null;
}) {
  const t = useT();
  const initType = String(initial.questionType ?? "mcq");
  const [text, setText] = useState(String(initial.text ?? ""));
  const [qtype, setQtype] = useState(initType);
  const [options, setOptions] = useState<string[]>(() => {
    if (initType === "true_false") return ["True", "False"];
    if (Array.isArray(initial.options)) return initial.options.map(String);
    if (typeof initial.options === "string") return initial.options.split("\n");
    return ["", "", ""];
  });
  const [correct, setCorrect] = useState(String(initial.correctAnswer ?? ""));
  const [multiCorrect, setMultiCorrect] = useState<string[]>(() => {
    if (initType !== "multi_select") return [];
    return safeJsonParse<string[]>(initial.correctAnswer) ?? [];
  });
  const [shortAnswers, setShortAnswers] = useState<string[]>(() => {
    if (initType === "short_answer") {
      if (Array.isArray(initial.options) && initial.options.length) return initial.options.map(String);
      if (initial.correctAnswer) return [String(initial.correctAnswer)];
    }
    return [""];
  });
  const [essayRubric, setEssayRubric] = useState(
    initType === "essay" ? String(initial.correctAnswer ?? "") : "",
  );
  const [pairs, setPairs] = useState<{ left: string; right: string }[]>(() => {
    if (initType === "matching") {
      const existing = extractPairs(initial.options);
      if (existing.length >= 2) return existing;
    }
    return [
      { left: "", right: "" },
      { left: "", right: "" },
      { left: "", right: "" },
    ];
  });
  const [orderItems, setOrderItems] = useState<string[]>(() => {
    if (initType === "ordering" && Array.isArray(initial.options) && initial.options.length >= 2) {
      return initial.options.map(String);
    }
    return ["", "", ""];
  });
  const [grade, setGrade] = useState(Number(initial.grade ?? 2));
  const [diff, setDiff] = useState(String(initial.difficulty ?? "easy"));
  const [localErr, setLocalErr] = useState("");
  const clean = options.map((o) => o.trim()).filter(Boolean);
  const cleanShort = shortAnswers.map((s) => s.trim()).filter(Boolean);
  const cleanPairs = pairs
    .map((p) => ({ left: p.left.trim(), right: p.right.trim() }))
    .filter((p) => p.left || p.right);
  const cleanOrder = orderItems.map((s) => s.trim()).filter(Boolean);
  const hasAnyMedia = Boolean(
    hasPendingAttachment || initial.mediaUrl || initial.imageUrl || pendingMedia || pendingImageUrl,
  );

  function setOpt(i: number, v: string) {
    const prevVal = options[i]?.trim();
    setOptions((o) => o.map((x, j) => (j === i ? v : x)));
    if (prevVal && multiCorrect.includes(prevVal)) {
      setMultiCorrect((mc) => mc.map((x) => (x === prevVal ? v.trim() : x)).filter(Boolean));
    }
    if (prevVal && correct === prevVal) setCorrect(v.trim());
  }

  function switchType(nextType: string) {
    setQtype(nextType);
    setLocalErr("");
    if (nextType === "true_false") {
      setOptions(["True", "False"]);
      if (correct !== "True" && correct !== "False") setCorrect("True");
    } else if (nextType === "mcq" && options.length < 2) {
      setOptions(["", "", ""]);
    } else if (nextType === "multi_select" && options.length < 2) {
      setOptions(["", "", "", ""]);
    }
  }

  function save() {
    if (!text.trim() && !hasAnyMedia) {
      return setLocalErr(t("Write the question text or attach an audio/video recording or image."));
    }
    if (!Number.isFinite(grade) || grade <= 0) {
      return setLocalErr(t("Marks must be a positive number."));
    }

    let payloadOptions: unknown = [];
    let payloadCorrect = "";

    if (qtype === "mcq" || qtype === "true_false") {
      if (clean.length < 2) return setLocalErr(t("Add at least two answer options."));
      if (new Set(clean).size !== clean.length) return setLocalErr(t("Answer options must be unique."));
      if (!correct.trim() || !clean.includes(correct.trim())) {
        return setLocalErr(t("Pick the correct answer from the options."));
      }
      payloadOptions = clean;
      payloadCorrect = correct.trim();
    } else if (qtype === "multi_select") {
      if (clean.length < 2) return setLocalErr(t("Add at least two answer options."));
      if (new Set(clean).size !== clean.length) return setLocalErr(t("Answer options must be unique."));
      const picked = [...new Set(multiCorrect.map((x) => x.trim()).filter((x) => clean.includes(x)))];
      if (!picked.length) return setLocalErr(t("Check at least one correct answer."));
      payloadOptions = clean;
      payloadCorrect = JSON.stringify(picked.sort());
    } else if (qtype === "short_answer") {
      const uniqueShort = [...new Set(cleanShort)];
      if (!uniqueShort.length) return setLocalErr(t("Add at least one accepted short answer."));
      payloadOptions = uniqueShort;
      payloadCorrect = uniqueShort[0];
    } else if (qtype === "essay") {
      payloadOptions = [];
      payloadCorrect = essayRubric.trim();
    } else if (qtype === "matching") {
      if (cleanPairs.length < 2 || cleanPairs.some((p) => !p.left || !p.right)) {
        return setLocalErr(t("Add at least 2 complete matching pairs (both left and right filled)."));
      }
      if (new Set(cleanPairs.map((p) => p.left)).size !== cleanPairs.length) {
        return setLocalErr(t("Left-side matching items must be unique."));
      }
      if (new Set(cleanPairs.map((p) => p.right)).size !== cleanPairs.length) {
        return setLocalErr(t("Right-side matching answers must be unique."));
      }
      const keyMap: Record<string, string> = {};
      for (const p of cleanPairs) keyMap[p.left] = p.right;
      payloadOptions = { pairs: cleanPairs };
      payloadCorrect = JSON.stringify(keyMap);
    } else if (qtype === "ordering") {
      if (cleanOrder.length < 2) return setLocalErr(t("Add at least 2 items to order."));
      if (new Set(cleanOrder).size !== cleanOrder.length) {
        return setLocalErr(t("Ordering items must be unique."));
      }
      payloadOptions = cleanOrder;
      payloadCorrect = JSON.stringify(cleanOrder);
    }

    setLocalErr("");
    onSubmit({
      text: text.trim(),
      mediaPending: hasPendingAttachment,
      questionType: qtype,
      options: payloadOptions,
      correctAnswer: payloadCorrect,
      grade,
      difficulty: diff,
    });
  }

  const previewMediaUrl = pendingMedia?.url ?? initial.mediaUrl ?? null;
  const previewMediaType = pendingMedia?.type ?? initial.mediaType ?? null;
  const previewImg = pendingImageUrl ?? initial.imageUrl ?? null;

  return (
    <Sheet title={initial.id ? "Edit question" : "Add question"} onClose={onClose} wide>
      <div className="sheet-grid">
        <div>
          <div className="field">
            <span className="field-label">{t("Question type")}</span>
            <div className="qtype-grid">
              {ALL_QUESTION_TYPES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={`qtype-card ${qtype === item.value ? "on" : ""}`}
                  onClick={() => switchType(item.value)}
                >
                  <b>{t(item.label)}</b>
                  <small>{t(item.hint)}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <div className="field-label-row">
              <label htmlFor="qs-text">{t("Question text")}</label>
              <span className="subtle">
                {t("Optional when audio, video, or image is attached")}
              </span>
            </div>
            <textarea
              id="qs-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("Write a prompt, or leave blank for a video/voice-only question…")}
            />
          </div>

          {mediaUpload}

          {/* Type-specific answer builders */}
          {(qtype === "mcq" || qtype === "true_false") && (
            <div className="field">
              <span className="field-label">{t("Answer options")}</span>
              {options.map((o, i) => (
                <div className="opt-row" key={i}>
                  <button
                    type="button"
                    className={`opt-radio ${correct === o.trim() && o.trim() ? "on" : ""}`}
                    title={t("Mark as correct")}
                    onClick={() => setCorrect(o.trim())}
                    disabled={!o.trim()}
                  >
                    {correct === o.trim() && o.trim() ? <Check size={13} /> : String.fromCharCode(65 + i)}
                  </button>
                  <input
                    value={o}
                    onChange={(e) => setOpt(i, e.target.value)}
                    placeholder={`${t("Option")} ${String.fromCharCode(65 + i)}`}
                    disabled={qtype === "true_false"}
                  />
                  {options.length > 2 && qtype !== "true_false" && (
                    <button type="button" className="icon-button" aria-label={t("Remove option")} onClick={() => setOptions((x) => x.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  )}
                </div>
              ))}
              {qtype !== "true_false" && options.length < 6 && (
                <button type="button" className="text-button" onClick={() => setOptions((x) => [...x, ""])}>
                  <Plus size={13} /> {t(" Add option ")}
                </button>
              )}
            </div>
          )}

          {qtype === "multi_select" && (
            <div className="field">
              <span className="field-label">{t("Answer options (check all correct answers)")}</span>
              {options.map((o, i) => {
                const trimmed = o.trim();
                const isOn = Boolean(trimmed && multiCorrect.includes(trimmed));
                return (
                  <div className="opt-row" key={i}>
                    <button
                      type="button"
                      className={`opt-radio square ${isOn ? "on" : ""}`}
                      title={t("Toggle correct answer")}
                      disabled={!trimmed}
                      onClick={() =>
                        setMultiCorrect((prev) =>
                          prev.includes(trimmed)
                            ? prev.filter((x) => x !== trimmed)
                            : [...prev, trimmed],
                        )
                      }
                    >
                      {isOn ? <Check size={13} /> : String.fromCharCode(65 + i)}
                    </button>
                    <input
                      value={o}
                      onChange={(e) => setOpt(i, e.target.value)}
                      placeholder={`${t("Option")} ${String.fromCharCode(65 + i)}`}
                    />
                    {options.length > 2 && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={t("Remove option")}
                        onClick={() => setOptions((x) => x.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
              {options.length < 8 && (
                <button type="button" className="text-button" onClick={() => setOptions((x) => [...x, ""])}>
                  <Plus size={13} /> {t(" Add option ")}
                </button>
              )}
              <small className="subtle">{t("Partial credit is awarded automatically based on correct selections.")}</small>
            </div>
          )}

          {qtype === "short_answer" && (
            <div className="field">
              <span className="field-label">{t("Accepted answers (auto-graded, case-insensitive)")}</span>
              {shortAnswers.map((ans, i) => (
                <div className="opt-row" key={i}>
                  <span className="opt-radio on">
                    <Check size={13} />
                  </span>
                  <input
                    value={ans}
                    onChange={(e) =>
                      setShortAnswers((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    placeholder={i === 0 ? t("Primary accepted answer…") : t("Alternative accepted spelling…")}
                  />
                  {shortAnswers.length > 1 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("Remove answer")}
                      onClick={() => setShortAnswers((arr) => arr.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {shortAnswers.length < 10 && (
                <button type="button" className="text-button" onClick={() => setShortAnswers((arr) => [...arr, ""])}>
                  <Plus size={13} /> {t("Add alternative accepted answer")}
                </button>
              )}
            </div>
          )}

          {qtype === "essay" && (
            <div className="field">
              <label htmlFor="qs-rubric">{t("Model answer / Grading rubric (optional, hidden from students)")}</label>
              <textarea
                id="qs-rubric"
                rows={4}
                value={essayRubric}
                onChange={(e) => setEssayRubric(e.target.value)}
                placeholder={t("Key points to look for when grading this essay manually…")}
              />
              <small className="subtle">
                {t("Students get a multi-line essay box. You can grade submissions from the exam's 'Grade Essays' tab.")}
              </small>
            </div>
          )}

          {qtype === "matching" && (
            <div className="field">
              <span className="field-label">{t("Matching pairs (shuffled automatically for students)")}</span>
              {pairs.map((p, i) => (
                <div className="pair-edit-row" key={i}>
                  <span className="opt-radio">{i + 1}</span>
                  <input
                    value={p.left}
                    onChange={(e) =>
                      setPairs((arr) => arr.map((x, j) => (j === i ? { ...x, left: e.target.value } : x)))
                    }
                    placeholder={`${t("Prompt / Term")} ${i + 1}`}
                  />
                  <span className="pair-sep">↔</span>
                  <input
                    value={p.right}
                    onChange={(e) =>
                      setPairs((arr) => arr.map((x, j) => (j === i ? { ...x, right: e.target.value } : x)))
                    }
                    placeholder={`${t("Matching Answer")} ${i + 1}`}
                  />
                  {pairs.length > 2 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("Remove pair")}
                      onClick={() => setPairs((arr) => arr.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {pairs.length < 8 && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setPairs((arr) => [...arr, { left: "", right: "" }])}
                >
                  <Plus size={13} /> {t("Add matching pair")}
                </button>
              )}
              <small className="subtle">{t("Students receive proportional credit for every pair matched correctly.")}</small>
            </div>
          )}

          {qtype === "ordering" && (
            <div className="field">
              <span className="field-label">{t("Items in the CORRECT order (1 = first)")}</span>
              {orderItems.map((item, i) => (
                <div className="opt-row" key={i}>
                  <span className="opt-radio on">{i + 1}</span>
                  <input
                    value={item}
                    onChange={(e) =>
                      setOrderItems((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    placeholder={`${t("Step / Item")} ${i + 1}`}
                  />
                  {orderItems.length > 2 && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("Remove item")}
                      onClick={() => setOrderItems((arr) => arr.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {orderItems.length < 8 && (
                <button type="button" className="text-button" onClick={() => setOrderItems((arr) => [...arr, ""])}>
                  <Plus size={13} /> {t("Add item")}
                </button>
              )}
              <small className="subtle">{t("Shown in shuffled order to students; graded proportionally by position.")}</small>
            </div>
          )}

          <div className="form-grid">
            <div className="field">
              <span className="field-label">{t("Marks")}</span>
              <div className="stepper">
                <button type="button" onClick={() => setGrade((g) => Math.max(0.5, +(g - 0.5).toFixed(2)))}>−</button>
                <b>{grade}</b>
                <button type="button" onClick={() => setGrade((g) => +((g + 0.5).toFixed(2)))}>+</button>
              </div>
            </div>
            <div className="field">
              <span className="field-label">{t("Difficulty")}</span>
              <div className="segmented">
                {["easy", "medium", "hard"].map((d) => (
                  <button key={d} type="button" className={diff === d ? "active" : ""} onClick={() => setDiff(d)}>
                    {t(label(d))}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {subjectLocked && <p className="subtle">{t("Subject is fixed by the bank filter.")}</p>}
          {imageUpload}
          <Feedback error={localErr || error} />
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              {t(" Cancel ")}
            </button>
            <button type="button" className="primary" disabled={busy} onClick={save}>
              {busy ? t("Saving…") : t("Save question")}
            </button>
          </div>
        </div>

        <div className="live-preview">
          <p className="field-label">
            {t("Student preview")} · {questionTypeLabel(qtype, t)}
          </p>
          <div className="preview-card">
            <p>
              {text.trim()
                ? text
                : previewMediaType === "video"
                  ? t("Watch the video and choose the correct answer")
                  : previewMediaType === "audio"
                    ? t("Listen to the recording and choose the correct answer")
                    : previewImg
                      ? t("Review the image and choose the correct answer")
                      : t("Your question appears here…")}
            </p>
            {previewMediaUrl && previewMediaType && (
              <QuestionMediaPlayer
                mediaUrl={previewMediaUrl}
                mediaType={previewMediaType}
              />
            )}
            {previewImg && (
              <img
                className="question-image"
                src={String(previewImg).startsWith("/") ? apiUrl(String(previewImg)) : String(previewImg)}
                alt={t("Question diagram")}
              />
            )}

            {(qtype === "mcq" || qtype === "true_false") && (
              <div className="answer-options">
                {clean.map((o, i) => (
                  <span key={i} className={o === correct.trim() ? "selected" : ""}>
                    <span className="option-letter">{String.fromCharCode(65 + i)}</span>
                    {o}
                  </span>
                ))}
              </div>
            )}

            {qtype === "multi_select" && (
              <div className="answer-options">
                {clean.map((o, i) => (
                  <span key={i} className={multiCorrect.includes(o) ? "selected" : ""}>
                    <span className="option-letter">
                      {multiCorrect.includes(o) ? "✓" : String.fromCharCode(65 + i)}
                    </span>
                    {o}
                  </span>
                ))}
              </div>
            )}

            {qtype === "short_answer" && (
              <div className="preview-input-box">
                <input type="text" disabled placeholder={t("Student types short answer here…")} />
                {cleanShort.length > 0 && (
                  <small>{t("Accepted")}: {cleanShort.join(" · ")}</small>
                )}
              </div>
            )}

            {qtype === "essay" && (
              <div className="preview-input-box">
                <textarea rows={4} disabled placeholder={t("Student writes their essay answer here…")} />
              </div>
            )}

            {qtype === "matching" && (
              <div className="q-pairs-chips">
                {cleanPairs.map((p, i) => (
                  <span className="q-pair-pill" key={i}>
                    <b>{p.left || "…"}</b> ↔ <span>{p.right || "…"}</span>
                  </span>
                ))}
              </div>
            )}

            {qtype === "ordering" && (
              <div className="answer-options">
                {cleanOrder.map((o, i) => (
                  <span key={i} className="selected">
                    <span className="option-letter">{i + 1}</span>
                    {o}
                  </span>
                ))}
              </div>
            )}

            <small>
              {grade} {t("marks")} · {t(label(diff))}
            </small>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

// Modern replacement for the generic edit-window dialog: smart date popovers
// + duration stepper instead of native datetime-local inputs.
export function EditExamWindow({
  notesEnabled: initialNotes = false,
  notesForDoctorEnabled: initialDoctorNotes = false,
  examToolsEnabled: initialExamTools = true,
  maxReentries: initialReentries = 3,
  resultsReleased: initialReleased = false,
  title: initialTitle = "",
  purpose: initialPurpose = "quiz",
  sebRequired: initialSeb = false,
  instructionsText: initialInstructionsText = "",
  instructionsRequireCompletion: initialRequireCompletion = false,
  canMidterm = false,
  startTime,
  endTime,
  durationMinutes,
  busy,
  error,
  onSubmit,
}: {
  startTime: string;
  endTime: string;
  durationMinutes: number;
  notesEnabled?: boolean;
  notesForDoctorEnabled?: boolean;
  examToolsEnabled?: boolean;
  maxReentries?: number;
  resultsReleased?: boolean;
  title?: string;
  purpose?: string;
  sebRequired?: boolean;
  instructionsText?: string | null;
  instructionsRequireCompletion?: boolean;
  canMidterm?: boolean;
  busy?: boolean;
  error?: unknown;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const toLocal = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const [start, setStart] = useState(() => toLocal(startTime));
  const [end, setEnd] = useState(() => toLocal(endTime));
  const [dur, setDur] = useState(durationMinutes);
  const [notesEnabled, setNotesEnabled] = useState(initialNotes);
  const [examToolsEnabled, setExamToolsEnabled] = useState(initialExamTools ?? true);
  const [notesForDoctorEnabled, setNotesForDoctorEnabled] = useState(initialDoctorNotes);
  const [maxReentries, setMaxReentries] = useState(initialReentries);
  const [resultsReleased, setResultsReleased] = useState(initialReleased);
  const [title, setTitle] = useState(initialTitle);
  const [purpose, setPurpose] = useState(initialPurpose);
  const [sebRequired, setSebRequired] = useState(initialSeb);
  const [instructionsText, setInstructionsText] = useState(initialInstructionsText ?? "");
  const [instructionsRequireCompletion] = useState(initialRequireCompletion);
  const [err, setErr] = useState("");
  function save() {
    const a = new Date(start).getTime();
    const b = new Date(end).getTime();
    if (!title.trim()) return setErr("Give this assessment a title.");
    if (Number.isNaN(a) || Number.isNaN(b))
      return setErr("Pick valid opening and closing times.");
    if (b <= a) return setErr("Closing time must be after opening time.");
    if (!Number.isFinite(dur) || dur < 1)
      return setErr("Duration must be at least 1 minute.");
    if (dur * 60_000 > b - a)
      return setErr("Duration cannot exceed the exam window.");
    setErr("");
    onSubmit({
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      durationMinutes: dur,
      title: title.trim(),
      ...(canMidterm ? { purpose } : {}),
      sebRequired,
      instructionsText: instructionsText.trim() || null,
      instructionsRequireCompletion,
      notesEnabled, notesForDoctorEnabled, examToolsEnabled, maxReentries, resultsReleased,
    });
  }
  return (
    <div>
      <div className="field">
        <label htmlFor="edit-exam-title">{t("Title")}</label>
        <input
          id="edit-exam-title"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          autoComplete="off"
        />
      </div>
      {canMidterm && (
        <div className="field">
          <span className="field-label">{t("Kind")}</span>
          <div className="seg-pick">
            {(["midterm", "quiz"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={purpose === k ? "on" : ""}
                aria-pressed={purpose === k}
                onClick={() => setPurpose(k)}
              >
                {k === "midterm" ? t("Midterm exam") : t("Quiz")}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="form-grid">
        <DateTimeField value={start} onChange={setStart} label="Opens at" />
        <DateTimeField
          value={end}
          onChange={setEnd}
          label="Closes at"
          min={start}
          base={start}
          offsets={[
            { label: "+30m after opens", minutes: 30 },
            { label: "+1h after opens", minutes: 60 },
            { label: "+2h after opens", minutes: 120 },
            { label: "+3h after opens", minutes: 180 },
          ]}
        />
      </div>
      <div className="field">
        <span className="field-label">{t("Duration (minutes)")}</span>
        <div className="stepper">
          {[15, 30, 45, 60, 90, 120].map((m) => (
            <button
              key={m}
              type="button"
              className={dur === m ? "on" : ""}
              onClick={() => setDur(m)}
            >
              {m}m
            </button>
          ))}
          <span className="stepper-custom">
            <button type="button" onClick={() => setDur(Math.max(1, dur - 5))} aria-label={t("Shorter")}>
              <Minus size={13} />
            </button>
            <b>{dur}m</b>
            <button type="button" onClick={() => setDur(dur + 5)} aria-label={t("Longer")}>
              <Plus size={13} />
            </button>
          </span>
        </div>
      </div>
      <div className="toggle-card-grid">
        <div className={`toggle-card compact ${sebRequired ? "on" : ""}`}>
          <input id="edit-seb" type="checkbox" checked={sebRequired} onChange={(e) => setSebRequired(e.target.checked)} />
          <div><label htmlFor="edit-seb">{t("Require Safe Exam Browser")}</label></div>
        </div>
        <div className={`toggle-card compact ${resultsReleased ? "on" : ""}`}>
          <input id="edit-rel" type="checkbox" checked={resultsReleased} onChange={(e) => setResultsReleased(e.target.checked)} />
          <div><label htmlFor="edit-rel">{t("Show grades to students immediately")}</label></div>
        </div>
        <div className={`toggle-card compact ${examToolsEnabled ? "on" : ""}`}>
          <input id="edit-tools" type="checkbox" checked={examToolsEnabled} onChange={(e) => setExamToolsEnabled(e.target.checked)} />
          <div><label htmlFor="edit-tools">{t("Allow exam tools")}</label></div>
        </div>
        <div className={`toggle-card compact ${notesEnabled ? "on" : ""}`}>
          <input id="edit-notes" type="checkbox" checked={notesEnabled} onChange={(e) => setNotesEnabled(e.target.checked)} />
          <div><label htmlFor="edit-notes">{t("Allow student notes")}</label></div>
        </div>
        <div className={`toggle-card compact ${notesForDoctorEnabled ? "on" : ""}`}>
          <input id="edit-dnotes" type="checkbox" checked={notesForDoctorEnabled} onChange={(e) => setNotesForDoctorEnabled(e.target.checked)} />
          <div><label htmlFor="edit-dnotes">{t("Allow student notes for the doctor")}</label></div>
        </div>
      </div>
      <div className="field">
        <label htmlFor="edit-reentries">{t("Maximum re-entries (excluding the first entry)")}</label>
        <input
          id="edit-reentries"
          type="number"
          min={0}
          max={20}
          value={maxReentries}
          onChange={(e) =>
            setMaxReentries(
              Math.min(20, Math.max(0, Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0)),
            )
          }
          required
        />
      </div>
      <div className="field">
        <label htmlFor="edit-instructions-text">{t("Written pre-exam instructions (optional)")}</label>
        <textarea
          id="edit-instructions-text"
          rows={3}
          maxLength={10000}
          value={instructionsText}
          onChange={(e) => setInstructionsText(e.target.value)}
          placeholder={t("Add written briefing instructions (attach voice/video from the Briefing panel on this page)…")}
        />
      </div>
      <Feedback error={err || error} />
      <div className="dialog-actions">
        <button type="button" className="primary" disabled={busy} onClick={save}>
          {busy ? t("Saving…") : t("Save changes")}
        </button>
      </div>
    </div>
  );
}
