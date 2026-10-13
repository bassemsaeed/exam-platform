import { useT } from "../lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  Layers,
  ListChecks,
  Minus,
  Plus,
  Settings2,
  Users,
} from "lucide-react";
import type { SessionUser } from "../lib/api";
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
import { Badge, Empty, Feedback, Loading, PageTitle } from "../components/ui";
import { Combo, DateTimeField, MultiPicker, Sheet } from "../components/builder";

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
    options: string[];
    correctAnswer?: string;
    grade: number;
    difficulty: string;
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
              {q.text}
            </p>
            <div className="answer-options">
              {q.options.map((o, j) => (
                <span key={j} className={o === q.correctAnswer ? "selected" : ""}>
                  <span className="option-letter">
                    {String.fromCharCode(65 + j)}
                  </span>
                  {o}
                </span>
              ))}
            </div>
            <small>
              {q.grade} {t("marks")} · {t(label(q.difficulty))} ·{" "}
              {t("answer")}: {q.correctAnswer}
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
  const [startLocal, setStartLocal] = useState("");
  const [endLocal, setEndLocal] = useState("");
  const [scope, setScope] = useState(user.role === "ta" ? "sections" : "subject");
  const [sectionSel, setSectionSel] = useState<string[]>([]);
  const [pickedStudents, setPickedStudents] = useState<string[]>([]);
  const [source, setSource] = useState("shared");
  const [manual, setManual] = useState(false);
  const [mix, setMix] = useState({ easy: 3, medium: 2, hard: 1 });
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [restored, setRestored] = useState(false);
  // Draft autosave: a refresh never wipes the wizard. Restored once on mount.
  useEffect(() => {
    const d = loadDraft(user.id);
    if (!d) return;
    if (
      !d.subject && !d.startLocal && !d.endLocal &&
      !(Array.isArray(d.picked) && d.picked.length) &&
      !(Array.isArray(d.sectionSel) && d.sectionSel.length) &&
      !(Array.isArray(d.pickedStudents) && d.pickedStudents.length)
    )
      return;
    if (typeof d.subject === "string") setSubject(d.subject);
    if (typeof d.duration === "number") setDuration(d.duration);
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
    !!subject || !!startLocal || !!endLocal || sectionSel.length > 0 ||
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
          subject, duration, startLocal, endLocal, scope, sectionSel,
          pickedStudents, source, manual, mix, picked, step,
        }),
      );
    } catch {
      // storage full/blocked: builder still works, just not resumable
    }
  }, [user.id, subject, duration, startLocal, endLocal, scope, sectionSel, pickedStudents, source, manual, mix, picked, step ]);

  const sections = useResource<Envelope<Entity>>(
    user,
    `/api/v1/exams/sections?subject_id=${subject}`,
    !!subject && (step >= 1 || scope === "sections"),
  );
  const roster = useResource<{
    totalEnrolled: number;
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
    `/api/v1/question-bank?subject_id=${subject}&limit=100`,
    !!subject && (manual || step === 3) && step >= 2,
  );
  const action = useAction<Exam>(user, ["/api/v1/exams", "/api/v1/admin/exams"]);
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
  }, [startLocal, duration, closeTouched ]);

  function valid(s: number): string {
    if (s === 0) {
      if (!subject) return "Choose a subject to continue.";
      if (!duration || duration < 1) return "Set a duration of at least 1 minute.";
      if (!startLocal || !endLocal) return "Pick opening and closing times.";
      const a = new Date(startLocal).getTime();
      const b = new Date(endLocal).getTime();
      if (Number.isNaN(a) || Number.isNaN(b)) return "Pick valid opening and closing times.";
      if (b <= a) return "Closing time must be after opening time.";
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
    action.mutate(
      {
        path: "/api/v1/exams",
        body: {
          subjectId: subject,
          type: user.role === "ta" ? "ta_quiz" : "doctor_exam",
          startTime,
          endTime,
          durationMinutes: duration,
          targetScope: scope,
          ...(scope === "sections" ? { targetSections: sectionSel } : {}),
          ...(scope === "student_list"
            ? { targetStudents: pickedStudents }
            : {}),
          questionSource: user.role === "ta" ? source : "own",
          ...(manual ? { manualQuestionIds: picked } : { difficultyMix: mix }),
        },
      },
      { onSuccess: (e) => {
        try {
          sessionStorage.removeItem(DRAFT_KEY(user.id));
        } catch {
          // ignore
        }
        navigate("/exams/" + e.id);
      } },
    );
  }
  const mixNudge = (k: keyof typeof mix, d: number) =>
    setMix((m) => ({ ...m, [k]: Math.max(0, (m[k] ?? 0) + d) }));
  const subjName =
    rowsOf(subjects.data).find((s) => s.id === subject)?.name ?? "";

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
              setStartLocal("");
              setEndLocal("");
              setSectionSel([]);
              setPickedStudents([]);
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
          </section>
        )}

        {step === 1 && (
          <section className="panel">
            <h2>
              <Users size={16} /> {t("Audience")}
            </h2>
            <div className="scope-cards">
              {(user.role === "ta"
                ? ["sections"]
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
                        : t("Hand-picked students")}
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
              <div className="field">
                <span className="field-label">
                  {t("Target students")} ({roster.data?.totalEnrolled ?? 0}{" "}
                  {t("enrolled")})
                </span>
                <Feedback error={roster.error} />
                {roster.isPending ? (
                  <p className="subtle">{t("Loading enrolled students…")}</p>
                ) : (
                  <MultiPicker
                    options={(roster.data?.sections ?? []).flatMap((sec) =>
                      sec.students.map((st) => ({
                        id: st.id,
                        name: st.name,
                        username: st.username,
                        sub: sec.name,
                      })),
                    )}
                    value={pickedStudents}
                    onChange={setPickedStudents}
                    placeholder="Search enrolled students…"
                    emptyText="No enrolled students in this subject."
                  />
                )}
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
                      onClick={() => setSource(o)}
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
                  <p className="subtle">
                    {t("{0} questions in your bank", {
                      "0": bank.data?.total ?? rowsOf(bank.data).length,
                    })}
                  </p>
                )}
                <div className="question-pick-list modern">
                  {rowsOf(bank.data).map((q) => (
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
                      <span>{q.text}</span>
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
              <div><dt>{t("Audience")}</dt><dd>{t(label(scope))}{scope === "sections" ? ` (${sectionSel.length})` : ""}</dd></div>
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
                {action.isPending ? t("Creating…") : user.role === "ta" ? t("Create quiz") : t("Submit for approval")}
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

// Modern side-sheet question editor with live student-view preview.
export function QuestionSheet({
  initial,
  subjectLocked,
  busy,
  error,
  onClose,
  onSubmit,
  imageUpload,
}: {
  initial: Partial<Question> & { options?: string[] | string };
  subjectLocked?: boolean;
  busy?: boolean;
  error?: unknown;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
  imageUpload?: React.ReactNode;
}) {
  const t = useT();
  const [text, setText] = useState(String(initial.text ?? ""));
  const [qtype, setQtype] = useState(String(initial.questionType ?? "mcq"));
  const [options, setOptions] = useState<string[]>(
    Array.isArray(initial.options)
      ? initial.options
      : String(initial.options ?? "A\nB\nC").split("\n"),
  );
  const [correct, setCorrect] = useState(String(initial.correctAnswer ?? ""));
  const [grade, setGrade] = useState(Number(initial.grade ?? 2));
  const [diff, setDiff] = useState(String(initial.difficulty ?? "easy"));
  const [localErr, setLocalErr] = useState("");
  const clean = options.map((o) => o.trim()).filter(Boolean);

  function setOpt(i: number, v: string) {
    setOptions((o) => o.map((x, j) => (j === i ? v : x)));
  }
  function save() {
    if (!text.trim()) return setLocalErr("Write the question text first.");
    if (clean.length < 2) return setLocalErr("Add at least two answer options.");
    if (!correct.trim() || !clean.includes(correct.trim()))
      return setLocalErr("Pick the correct answer from the options.");
    if (!Number.isFinite(grade) || grade <= 0)
      return setLocalErr("Marks must be a positive number.");
    setLocalErr("");
    onSubmit({
      text: text.trim(),
      questionType: qtype,
      options: clean,
      correctAnswer: correct.trim(),
      grade,
      difficulty: diff,
    });
  }
  return (
    <Sheet title={initial.id ? "Edit question" : "Add question"} onClose={onClose} wide>
      <div className="sheet-grid">
        <div>
          <div className="field">
            <span className="field-label">{t("Question type")}</span>
            <div className="scope-cards two">
              {["mcq", "true_false"].map((o) => (
                <button
                  key={o}
                  type="button"
                  className={qtype === o ? "on" : ""}
                  onClick={() => {
                    setQtype(o);
                    if (o === "true_false") {
                      setOptions(["True", "False"]);
                      if (correct !== "True" && correct !== "False") setCorrect("True");
                    }
                  }}
                >
                  <b>{t(label(o))}</b>
                  <small>{o === "mcq" ? t("2–6 options") : t("True / False")}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="qs-text">{t("Question text")}</label>
            <textarea
              id="qs-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t("What is…?")}
            />
          </div>
          <div className="field">
            <span className="field-label">{t("Answer options")}</span>
            {options.map((o, i) => (
              <div className="opt-row" key={i}>
                <button
                  type="button"
                  className={`opt-radio ${correct === o.trim() && o.trim() ? "on" : ""}`}
                  title={t("Mark as correct")}
                  onClick={() => setCorrect(o)}
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
          <p className="field-label">{t("Student preview")}</p>
          <div className="preview-card">
            <p>{text || t("Your question appears here…")}</p>
            <div className="answer-options">
              {clean.map((o, i) => (
                <span key={i} className={o === correct.trim() ? "selected" : ""}>
                  <span className="option-letter">{String.fromCharCode(65 + i)}</span>
                  {o}
                </span>
              ))}
            </div>
            <small>
              {grade} {t("marks")} · {t(label(diff))}
            </small>
          </div>
          {initial.imageUrl && (
            <img
              className="question-image"
              src={String(initial.imageUrl).startsWith("/") ? apiUrl(String(initial.imageUrl)) : String(initial.imageUrl)}
              alt={t("Question diagram")}
            />
          )}
        </div>
      </div>
    </Sheet>
  );
}

// Modern replacement for the generic edit-window dialog: smart date popovers
// + duration stepper instead of native datetime-local inputs.
export function EditExamWindow({
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
  const [err, setErr] = useState("");
  function save() {
    const a = new Date(start).getTime();
    const b = new Date(end).getTime();
    if (Number.isNaN(a) || Number.isNaN(b))
      return setErr("Pick valid opening and closing times.");
    if (b <= a) return setErr("Closing time must be after opening time.");
    if (!Number.isFinite(dur) || dur < 1)
      return setErr("Duration must be at least 1 minute.");
    setErr("");
    onSubmit({
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      durationMinutes: dur,
    });
  }
  return (
    <div>
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
        </div>
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
