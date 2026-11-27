import { useState } from "react";
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  CheckCircle2,
  CheckSquare,
  FilePenLine,
  ListOrdered,
  Save,
  Square,
  Type,
} from "lucide-react";
import { api, type SessionUser } from "../lib/api";
import { useT } from "../lib/i18n";
import { useResource, type QuestionType } from "../lib/platform";
import { Empty, Feedback, Loading } from "./ui";
import { QuestionMediaPlayer, questionDisplayText } from "./QuestionMedia";

export const ALL_QUESTION_TYPES: {
  value: QuestionType;
  label: string;
  hint: string;
}[] = [
  { value: "mcq", label: "Multiple Choice", hint: "Single correct answer" },
  { value: "true_false", label: "True / False", hint: "Two choices" },
  { value: "multi_select", label: "Multiple Answers", hint: "Select all that apply" },
  { value: "short_answer", label: "Short Answer", hint: "Auto-graded text" },
  { value: "essay", label: "Essay", hint: "Manual grading" },
  { value: "matching", label: "Matching", hint: "Match pairs" },
  { value: "ordering", label: "Ordering", hint: "Put items in order" },
];

export function questionTypeLabel(type: string, t: (s: string) => string): string {
  const found = ALL_QUESTION_TYPES.find((x) => x.value === type);
  return t(found ? found.label : type);
}

export function safeJsonParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function extractPairs(options: unknown): { left: string; right: string }[] {
  if (!options || typeof options !== "object" || Array.isArray(options)) return [];
  const raw = (options as { pairs?: unknown }).pairs;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => ({
      left: String((p as { left?: unknown })?.left ?? ""),
      right: String((p as { right?: unknown })?.right ?? ""),
    }))
    .filter((p) => p.left || p.right);
}

export function extractStudentMatching(options: unknown): { left: string[]; right: string[] } {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return { left: [], right: [] };
  }
  const obj = options as { left?: unknown; right?: unknown; pairs?: { left: string; right: string }[] };
  if (Array.isArray(obj.left) && Array.isArray(obj.right)) {
    return {
      left: obj.left.map(String),
      right: obj.right.map(String),
    };
  }
  if (Array.isArray(obj.pairs)) {
    return {
      left: obj.pairs.map((p) => String(p.left)),
      right: obj.pairs.map((p) => String(p.right)),
    };
  }
  return { left: [], right: [] };
}

/**
 * Clean read-only summary of options/key for Question Bank & Exam Blueprint cards.
 */
export function QuestionOptionsSummary({
  questionType,
  options,
  correctAnswer,
}: {
  questionType: string;
  options: unknown;
  correctAnswer?: string;
}) {
  const t = useT();

  if (questionType === "mcq" || questionType === "true_false") {
    const arr = Array.isArray(options) ? options.map(String) : [];
    return (
      <div className="option-chips">
        {arr.map((o) => {
          const isRight = o === correctAnswer;
          return (
            <span key={o} className={isRight ? "correct" : ""} dir="auto">
              {isRight && <Check size={11} style={{ marginInlineEnd: 4, verticalAlign: -1 }} />}
              {o}
            </span>
          );
        })}
      </div>
    );
  }

  if (questionType === "multi_select") {
    const arr = Array.isArray(options) ? options.map(String) : [];
    const correctSet = new Set(safeJsonParse<string[]>(correctAnswer) ?? []);
    return (
      <div className="option-chips">
        {arr.map((o) => (
          <span key={o} className={correctSet.has(o) ? "correct" : ""}>
            {correctSet.has(o) ? "✓ " : ""}
            {o}
          </span>
        ))}
      </div>
    );
  }

  if (questionType === "short_answer") {
    const accepted = Array.isArray(options) ? options.map(String).filter(Boolean) : [];
    return (
      <div className="option-chips">
        <span className="q-chip-label">
          <Type size={11} /> {t("Accepted")}:
        </span>
        {(accepted.length ? accepted : correctAnswer ? [correctAnswer] : []).map((a) => (
          <span key={a} className="correct">
            {a}
          </span>
        ))}
      </div>
    );
  }

  if (questionType === "essay") {
    return (
      <div className="q-type-summary-note">
        <FilePenLine size={13} />
        <span>
          {t("Open-ended essay · Graded manually by instructor")}
          {correctAnswer?.trim() ? ` · ${t("Rubric attached")}` : ""}
        </span>
      </div>
    );
  }

  if (questionType === "matching") {
    const pairs = extractPairs(options);
    return (
      <div className="q-pairs-chips">
        {pairs.map((p, i) => (
          <span className="q-pair-pill" key={`${p.left}-${i}`}>
            <b>{p.left}</b>
            <ArrowLeftRight size={11} />
            <span>{p.right}</span>
          </span>
        ))}
      </div>
    );
  }

  if (questionType === "ordering") {
    const items = Array.isArray(options) ? options.map(String) : [];
    return (
      <div className="option-chips">
        {items.map((item, i) => (
          <span key={`${item}-${i}`} className="correct">
            {i + 1}. {item}
          </span>
        ))}
      </div>
    );
  }

  return null;
}

/**
 * Interactive student answer input inside the Exam Runner for all 7 question types.
 */
export function RunnerQuestionInput({
  questionId,
  questionType,
  options,
  selectedAnswer,
  disabled,
  onChange,
}: {
  questionId: string;
  questionType: string;
  options: unknown;
  selectedAnswer: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const t = useT();

  // 1 & 2. Single choice (MCQ & True/False)
  if (questionType === "mcq" || questionType === "true_false") {
    const list = Array.isArray(options) ? options.map(String) : [];
    return (
      <fieldset className="answer-options">
        <legend className="sr-only">{t("Select an answer")}</legend>
        {list.map((o, i) => (
          <label className={selectedAnswer === o ? "selected" : ""} key={`${questionId}-${i}`}>
            <input
              type="radio"
              name={"answer-" + questionId}
              checked={selectedAnswer === o}
              onChange={() => onChange(o)}
              disabled={disabled}
            />
            <span className="option-letter">{String.fromCharCode(65 + i)}</span>
            <span>{o}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  // 3. Multiple answers (checkboxes)
  if (questionType === "multi_select") {
    const list = Array.isArray(options) ? options.map(String) : [];
    const current = new Set(safeJsonParse<string[]>(selectedAnswer) ?? []);
    const toggle = (opt: string) => {
      const next = new Set(current);
      if (next.has(opt)) next.delete(opt);
      else next.add(opt);
      const arr = [...next].sort();
      onChange(arr.length ? JSON.stringify(arr) : null);
    };
    return (
      <fieldset className="answer-options">
        <legend className="q-runner-hint">
          <CheckSquare size={13} /> {t("Select all answers that apply")}
        </legend>
        {list.map((o, i) => {
          const checked = current.has(o);
          return (
            <label className={checked ? "selected" : ""} key={`${questionId}-${i}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(o)}
                disabled={disabled}
              />
              <span className="option-letter check-box">
                {checked ? <Check size={13} /> : <Square size={13} />}
              </span>
              <span>{o}</span>
            </label>
          );
        })}
      </fieldset>
    );
  }

  // 4. Short Answer
  if (questionType === "short_answer") {
    return (
      <div className="q-text-answer-wrap">
        <label htmlFor={`sa-${questionId}`} className="q-runner-hint">
          <Type size={13} /> {t("Type your short answer")}
        </label>
        <input
          id={`sa-${questionId}`}
          type="text"
          className="q-short-input"
          maxLength={500}
          disabled={disabled}
          value={selectedAnswer ?? ""}
          onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
          placeholder={t("Write your answer here…")}
        />
      </div>
    );
  }

  // 5. Essay
  if (questionType === "essay") {
    const val = selectedAnswer ?? "";
    const words = val.trim() ? val.trim().split(/\s+/).length : 0;
    return (
      <div className="q-text-answer-wrap">
        <div className="q-essay-head">
          <label htmlFor={`essay-${questionId}`} className="q-runner-hint">
            <FilePenLine size={13} /> {t("Write your essay response")}
          </label>
          <span className="subtle">
            {words} {t("words")} · {val.length} / 15,000
          </span>
        </div>
        <textarea
          id={`essay-${questionId}`}
          className="q-essay-textarea"
          rows={7}
          maxLength={15000}
          disabled={disabled}
          value={val}
          onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
          placeholder={t("Write a clear, complete answer…")}
        />
      </div>
    );
  }

  // 6. Matching pairs
  if (questionType === "matching") {
    const { left, right } = extractStudentMatching(options);
    const current = safeJsonParse<Record<string, string>>(selectedAnswer) ?? {};
    const pick = (leftItem: string, rightItem: string) => {
      const next = { ...current };
      if (!rightItem) delete next[leftItem];
      else next[leftItem] = rightItem;
      onChange(Object.keys(next).length ? JSON.stringify(next) : null);
    };
    return (
      <div className="q-matching-runner">
        <div className="q-runner-hint">
          <ArrowLeftRight size={13} /> {t("Match each item on the left with the correct item on the right")}
        </div>
        <div className="q-matching-rows">
          {left.map((item, i) => (
            <div className={`q-matching-row ${current[item] ? "matched" : ""}`} key={`${item}-${i}`}>
              <span className="q-match-left">
                <span className="option-letter">{i + 1}</span>
                <span>{item}</span>
              </span>
              <ArrowLeftRight size={14} className="q-match-arrow" />
              <select
                className="q-match-select"
                aria-label={`${t("Match for")} ${item}`}
                disabled={disabled}
                value={current[item] ?? ""}
                onChange={(e) => pick(item, e.target.value)}
              >
                <option value="">{t("— Choose match —")}</option>
                {right.map((r, j) => (
                  <option key={`${r}-${j}`} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // 7. Ordering / Sequence
  if (questionType === "ordering") {
    const initialList = Array.isArray(options) ? options.map(String) : [];
    const saved = safeJsonParse<string[]>(selectedAnswer);
    const order = saved && saved.length === initialList.length ? saved : initialList;
    const isSaved = Boolean(saved && saved.length === initialList.length);

    const move = (idx: number, delta: number) => {
      const target = idx + delta;
      if (target < 0 || target >= order.length) return;
      const next = [...order];
      [next[idx], next[target]] = [next[target], next[idx]];
      onChange(JSON.stringify(next));
    };

    return (
      <div className="q-ordering-runner">
        <div className="q-ordering-head">
          <span className="q-runner-hint">
            <ListOrdered size={13} /> {t("Arrange the items in the correct order (top = first)")}
          </span>
          {!isSaved && (
            <button
              type="button"
              className="secondary q-order-confirm"
              disabled={disabled}
              onClick={() => onChange(JSON.stringify(order))}
            >
              <Check size={13} /> {t("Keep current order")}
            </button>
          )}
        </div>
        <ol className="q-ordering-list">
          {order.map((item, i) => (
            <li className={`q-ordering-item ${isSaved ? "saved" : ""}`} key={`${item}-${i}`}>
              <span className="option-letter">{i + 1}</span>
              <span className="q-ordering-text">{item}</span>
              <div className="q-ordering-btns">
                <button
                  type="button"
                  className="icon-button"
                  disabled={disabled || i === 0}
                  aria-label={t("Move up")}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={disabled || i === order.length - 1}
                  aria-label={t("Move down")}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown size={14} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return null;
}

interface ManualGradingItem {
  id: string;
  questionId: string;
  studentExamId: string;
  student: { id: string; name: string; username?: string | null };
  submittedAt: string | null;
  questionText: string;
  questionMediaUrl?: string | null;
  questionMediaType?: "audio" | "video" | null;
  modelAnswer: string;
  maxGrade: number;
  answer: string;
  gradeAwarded: number;
  feedback: string;
  isGraded: boolean;
}

export function EssayGradingPanel({
  user,
  examId,
  onGraded,
}: {
  user: SessionUser;
  examId: string;
  onGraded?: () => void;
}) {
  const t = useT();
  const res = useResource<{ examId: string; items: ManualGradingItem[] }>(
    user,
    `/api/v1/exams/${examId}/manual-grading`,
  );
  const [drafts, setDrafts] = useState<Record<string, { grade: string; feedback: string }>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<"all" | "pending">("all");

  if (res.isPending) return <Loading />;
  if (res.error) return <Feedback error={res.error} />;
  const items = res.data?.items ?? [];
  const pendingCount = items.filter((i) => !i.isGraded).length;
  const gradedCount = items.length - pendingCount;
  const gradedPct = items.length ? Math.round((gradedCount / items.length) * 100) : 0;
  const visible = filter === "pending" ? items.filter((i) => !i.isGraded) : items;

  async function saveGrade(item: ManualGradingItem) {
    setErr("");
    setSavedId(null);
    const d = drafts[item.id];
    const rawStr = (d?.grade ?? String(item.gradeAwarded)).trim();
    if (rawStr === "") {
      setErr(t("Score must be between 0 and {0}.", { "0": item.maxGrade }));
      return;
    }
    const num = Number(rawStr);
    if (!Number.isFinite(num) || num < 0 || num > item.maxGrade) {
      setErr(t("Score must be between 0 and {0}.", { "0": item.maxGrade }));
      return;
    }
    setSavingId(item.id);
    try {
      await api.patch(`/api/v1/exams/${examId}/manual-grading/${item.id}`, {
        gradeAwarded: num,
        feedback: d?.feedback ?? item.feedback,
      });
      setSavedId(item.id);
      await res.refetch();
      onGraded?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("Could not save grade."));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="essay-grading-wrap">
      <div className="essay-grading-bar">
        <div className="an-filter-tabs">
          <button
            type="button"
            className={filter === "all" ? "on" : ""}
            onClick={() => setFilter("all")}
          >
            {t("All essays")} ({items.length})
          </button>
          <button
            type="button"
            className={filter === "pending" ? "on" : ""}
            onClick={() => setFilter("pending")}
          >
            {t("Needs grading")} ({pendingCount})
          </button>
        </div>
        {items.length > 0 && (
          <div className="essay-progress-pill">
            <span>
              {t("Graded {0} of {1}", { "0": gradedCount, "1": items.length })}
            </span>
            <div className="essay-progress-track">
              <span style={{ width: `${gradedPct}%` }} />
            </div>
            <b>{gradedPct}%</b>
          </div>
        )}
      </div>

      <Feedback error={err || undefined} />

      {!visible.length ? (
        <Empty
          title={
            items.length
              ? t("All essay responses are graded")
              : t("No essay responses to grade")
          }
          text={
            items.length
              ? t("Switch to 'All essays' to review or adjust scores.")
              : t("Submitted essay answers will appear here for manual grading.")
          }
        />
      ) : (
        <div className="essay-grade-list">
          {visible.map((item) => {
            const d = drafts[item.id] ?? {
              grade: String(item.gradeAwarded),
              feedback: item.feedback,
            };
            const presets = [
              { label: "0", value: 0 },
              { label: "50%", value: Number((item.maxGrade * 0.5).toFixed(2)) },
              { label: "75%", value: Number((item.maxGrade * 0.75).toFixed(2)) },
              { label: `${t("Full")} (${item.maxGrade})`, value: item.maxGrade },
            ];
            return (
              <div className={`essay-grade-card ${item.isGraded ? "graded" : "pending"}`} key={item.id}>
                <div className="essay-grade-head">
                  <div>
                    <b>{item.student.name}</b>
                    {item.student.username && (
                      <span className="subtle"> · <bdi>{item.student.username}</bdi></span>
                    )}
                  </div>
                  <span className={`badge ${item.isGraded ? "badge-approved" : "badge-pending_approval"}`}>
                    {item.isGraded
                      ? `${item.gradeAwarded} / ${item.maxGrade}`
                      : t("Awaiting grade")}
                  </span>
                </div>

                <div className="essay-grade-q">
                  <small>{t("Question")}</small>
                  <p dir="auto">{questionDisplayText({ text: item.questionText, mediaType: item.questionMediaType }, t)}</p>
                  {item.questionMediaUrl && item.questionMediaType && (
                    <QuestionMediaPlayer
                      mediaUrl={item.questionMediaUrl}
                      mediaType={item.questionMediaType}
                      compact
                    />
                  )}
                </div>

                {item.modelAnswer?.trim() && (
                  <div className="essay-grade-rubric">
                    <small>{t("Model answer / Rubric")}</small>
                    <p dir="auto">{item.modelAnswer}</p>
                  </div>
                )}

                <div className="essay-grade-answer">
                  <small>{t("Student's answer")}</small>
                  <p dir="auto">{item.answer.trim() || t("(No answer written)")}</p>
                </div>

                <div className="essay-grade-controls">
                  <div className="field">
                    <label htmlFor={`eg-score-${item.id}`}>
                      {t("Score")} (0–{item.maxGrade})
                    </label>
                    <div className="essay-score-input-row">
                      <input
                        id={`eg-score-${item.id}`}
                        type="number"
                        min={0}
                        max={item.maxGrade}
                        step={0.5}
                        value={d.grade}
                        onChange={(e) => {
                          if (savedId === item.id) setSavedId(null);
                          setDrafts((prev) => ({
                            ...prev,
                            [item.id]: { ...d, grade: e.target.value },
                          }));
                        }}
                      />
                      <div className="essay-quick-scores" role="group" aria-label={t("Quick score")}>
                        {presets.map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            className={`essay-preset-btn ${Number(d.grade) === p.value ? "on" : ""}`}
                            onClick={() => {
                              if (savedId === item.id) setSavedId(null);
                              setDrafts((prev) => ({
                                ...prev,
                                [item.id]: { ...d, grade: String(p.value) },
                              }));
                            }}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="field" style={{ flex: 1, minWidth: 200 }}>
                    <label htmlFor={`eg-fb-${item.id}`}>{t("Feedback (optional)")}</label>
                    <input
                      id={`eg-fb-${item.id}`}
                      type="text"
                      maxLength={1000}
                      value={d.feedback}
                      onChange={(e) => {
                        if (savedId === item.id) setSavedId(null);
                        setDrafts((prev) => ({
                          ...prev,
                          [item.id]: { ...d, feedback: e.target.value },
                        }));
                      }}
                      placeholder={t("Short grading note…")}
                    />
                  </div>
                  <button
                    type="button"
                    className="primary"
                    disabled={savingId === item.id}
                    onClick={() => void saveGrade(item)}
                  >
                    {savedId === item.id ? <CheckCircle2 size={14} /> : <Save size={14} />}
                    {savingId === item.id
                      ? t("Saving…")
                      : savedId === item.id
                        ? t("Saved")
                        : t("Save grade")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
