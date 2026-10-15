import { useExamReadiness, ReadinessChecklist } from "../components/Readiness";
import { useT } from "../lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  Flag,
  CheckCircle2,
  Clock,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { SessionUser } from "../lib/api";
import {
  request,
  previewMode,
  invalidateResources,
  type Sitting,
} from "../lib/platform";
import { apiUrl, sebHeaders } from "../lib/seb";
import { ApiError } from "../lib/api";
import { ExamTools } from "../components/ExamTools";
import { Feedback, Confirm, PageTitle } from "../components/ui";
export function ExamRunner({ user, onActivity }: { user: SessionUser; onActivity: (path: string | null) => void }) {
  const t = useT();
  const { id } = useParams();
  // Server-issued entry token: persisted per exam so refreshes/resumes present
  // the latest token the server issued (rotation consumes re-entry budget).
  const tokenKey = `entry-token-${id}`;
  const [entryToken, setEntryToken] = useState(() => {
    try { return sessionStorage.getItem(tokenKey) ?? crypto.randomUUID(); }
    catch { return crypto.randomUUID(); }
  });
  const [sitting, setSitting] = useState<Sitting | null>(null);
  const [code, setCode] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hbError, setHbError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<{
    totalGrade: number;
    totalMarks?: number;
    status: string;
  } | null>(null);
  const [queued, setQueued] = useState(0);
  const [retryAnswers, setRetryAnswers] = useState<
    Record<string, string | null>
  >({});
  const readiness = useExamReadiness(user, id, !sitting && !result);
  useEffect(() => {
    if (readiness.query.data?.submitted) onActivity(null);
  }, [readiness.query.data?.submitted]);
  const deadline = useRef(0);
  const latest = useRef(sitting);
  latest.current = sitting;
  const cursor = useRef("");
  const submitKeyRef = useRef<string | null>(null);
  if (submitKeyRef.current === null) {
    try {
      const storageKey = `submit-key-${id}`;
      let existing: string | null = null;
      try {
        existing = sessionStorage.getItem(storageKey);
      } catch {
        existing = null;
      }
      if (!existing) {
        existing = crypto.randomUUID();
        try {
          sessionStorage.setItem(storageKey, existing);
        } catch {
          /* session-only fallback */
        }
      }
      submitKeyRef.current = existing;
    } catch {
      submitKeyRef.current = crypto.randomUUID();
    }
  }
  const submitKey = submitKeyRef as { current: string };
  const start = useMutation({
    mutationFn: () =>
      request<Sitting>(`/api/v1/student/exams/${id}/start`, "POST", {
        accessCode: code,
        entryToken,
      }),
    onError: (err) => {
      if (err instanceof ApiError && (err.status === 409 || (err.status === 403 && err.message.includes("re-entry limit")))) onActivity(null);
    },
    onSuccess: (s) => {
      void invalidateResources(user.id, [
        `/api/v1/student/exams/${id}/readiness`,
      ]);
      if (s.entryToken) {
        setEntryToken(s.entryToken);
        try { sessionStorage.setItem(tokenKey, s.entryToken); } catch { /* memory only */ }
      }
      setSitting(s);
      onActivity(`/exams/${id}/take`);
      deadline.current = Date.now() + s.remainingSeconds * 1000;
      setRemaining(s.remainingSeconds);
      setError(null);
    },
  });
  const finish = useMutation({
    mutationFn: () =>
      request<{
        totalGrade: number;
        totalMarks?: number;
        status: string;
      }>(
        `/api/v1/student/exams/${id}/submit`,
        "POST",
        {},
        { "Idempotency-Key": submitKey.current },
      ),
    onSuccess: (r) => {
      setResult(r);
      onActivity(null);
      setConfirm(false);
      void invalidateResources(user.id, ["/api/v1/student"]);
    },
  });
  const answer = useMutation({
    mutationFn: ({
      questionId,
      selectedAnswer,
    }: {
      questionId: string;
      selectedAnswer: string | null;
    }) =>
      request(`/api/v1/student/exams/${id}/answer`, "PATCH", {
        questionId,
        selectedAnswer,
      }),
    onSuccess: (_, v) =>
      setRetryAnswers((prev) => {
        const next = { ...prev };
        delete next[v.questionId];
        return next;
      }),
    onError: (err, v) => {
      setRetryAnswers((prev) => ({
        ...prev,
        [v.questionId]: v.selectedAnswer,
      }));
      setError(err);
    },
  });
  const flag = useMutation({
    mutationFn: ({
      questionId,
      isFlagged,
    }: {
      questionId: string;
      isFlagged: boolean;
    }) =>
      request(`/api/v1/student/exams/${id}/flag`, "PATCH", {
        questionId,
        isFlagged,
      }),
    onSuccess: (_, v) =>
      setSitting((s) =>
        s
          ? {
              ...s,
              questions: s.questions.map((q) =>
                q.questionId === v.questionId
                  ? { ...q, isFlagged: v.isFlagged }
                  : q,
              ),
            }
          : s,
      ),
    onError: setError,
  });
  // Mutations are serialized so a slow older answer cannot overwrite a newer choice.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const choose = useCallback(
    (questionId: string, selectedAnswer: string | null) => {
      setSitting((s) =>
        s
          ? {
              ...s,
              questions: s.questions.map((q) =>
                q.questionId === questionId ? { ...q, selectedAnswer } : q,
              ),
            }
          : s,
      );
      setQueued((n) => n + 1);
      queue.current = queue.current
        .catch(() => {})
        .then(() => answer.mutateAsync({ questionId, selectedAnswer }))
        .catch(() => {})
        .finally(() => setQueued((n) => n - 1));
    },
    [answer],
  );
  useEffect(() => {
    if (!sitting || result) return;
    const timer = setInterval(
      () =>
        setRemaining(
          Math.max(0, Math.floor((deadline.current - Date.now()) / 1000)),
        ),
      1000,
    );
    const heartbeat = setInterval(() => {
      void request<{
        remainingSeconds: number;
      }>(`/api/v1/student/exams/${id}/heartbeat`, "POST")
        .then((r) => {
          deadline.current = Date.now() + r.remainingSeconds * 1000;
          setRemaining(r.remainingSeconds);
          setHbError(null);
        })
        .catch((err) => {
          setHbError(err);
          setNotice(
            err instanceof Error ? err.message : "Connection check failed.",
          );
        });
    }, 30000);
    const prevent = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      window.removeEventListener("beforeunload", prevent);
    };
  }, [!!sitting, !!result, id]);
  useEffect(() => {
    // Timeout auto-submit: submit even with unanswered questions â€” the server
    // finalizes partial attempts. Manual button still requires all answered.
    if (sitting && remaining === 0 && !result && !finish.isPending)
      finish.mutate();
  }, [remaining, !!sitting, !!result, finish.isPending]);
  useEffect(() => {
    // Auto-submit retry: reset the error state after 5s so the effect above retries.
    if (!finish.isError) return;
    const retry = setTimeout(() => finish.reset(), 5000);
    return () => clearTimeout(retry);
  }, [finish.isError]);
  useEffect(() => {
    if (!sitting || result || previewMode) return;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    async function connect() {
      try {
        const path = `/api/v1/student/exams/${id}/events`;
        const response = await fetch(apiUrl(path), {
          credentials: "include",
          signal: controller.signal,
          headers: {
            ...(await sebHeaders(path)),
            ...(cursor.current ? { "Last-Event-ID": cursor.current } : {}),
          },
        });
        if (!response.ok)
          throw new Error("Live announcements temporarily unavailable.");
        const reader = response.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder
            .decode(value, { stream: true })
            .replaceAll("\r\n", "\n");
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const lines = event.split("\n");
            const seq = lines
              .find((l) => l.startsWith("id:"))
              ?.slice(3)
              .trim();
            if (seq) cursor.current = seq;
            const type = lines
              .find((l) => l.startsWith("event:"))
              ?.slice(6)
              .trim();
            const data = lines
              .find((l) => l.startsWith("data:"))
              ?.slice(5)
              .trim();
            if (type && data) {
              let payload: Record<string, unknown>;
              try {
                payload = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }
              setNotice(String(payload.message ?? payload.reason ?? type));
              if (type === "closed" || type === "voided")
                setNotice(
                  "This exam has been closed. The server will finalize your attempt.",
                );
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted)
          setNotice(
            err instanceof Error ? err.message : "Announcements disconnected.",
          );
      }
      if (!controller.signal.aborted) retry = setTimeout(connect, 5000);
    }
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [!!sitting, !!result, id]);
  const pageSize = 4;
  const pageStart = Math.floor(index / pageSize) * pageSize;
  const lastPage = !!sitting && pageStart + pageSize >= sitting.questions.length;
  const answered =
    sitting?.questions.filter((q) => q.selectedAnswer !== null).length ?? 0;
  const unsaved = Object.keys(retryAnswers).length;
  // Keyboard-first runner: 1-4/A-D answer, arrows move, ? nothing stolen
  // while typing. Disabled once time is up or a dialog is open.
  useEffect(() => {
    if (!sitting || result || confirm) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;
      const cur = latest.current?.questions[index];
      if (e.key === "ArrowRight") {
        if (sitting && index < sitting.questions.length - 1)
          setIndex(index + 1);
      } else if (e.key === "ArrowLeft") {
        if (index > 0) setIndex(index - 1);
      } else if (cur && remaining > 0 && !finish.isPending) {
        const n = e.key >= "1" && e.key <= "9" ? Number(e.key) - 1 : -1;
        const letter =
          /^[a-dA-D]$/.test(e.key) ? e.key.toUpperCase().charCodeAt(0) - 65 : -1;
        const pick = n >= 0 ? n : letter;
        if (pick >= 0 && pick < cur.options.length)
          choose(cur.questionId, cur.options[pick]);
        else if (e.key === "0" || e.key === "Delete" || e.key === "Backspace")
          choose(cur.questionId, null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [!!sitting, !!result, confirm, index, remaining, finish.isPending, choose ]);
  if (result)
    return (
      <>
        <PageTitle
          title={t("Assessment submitted")}
          description={t("Your attempt has been recorded.")}
        />
        <section className="panel submitted-panel">
          <CheckCircle2 size={46} />
          <h2>{t("Submission complete")}</h2>
          <p>{t("Your grade")}</p>
          <strong>
            {result.totalGrade}/{result.totalMarks ?? "—"} <small>{t("marks")}</small>
          </strong>
          <Link className="button primary" to="/results">
            {t(" View my results ")}
          </Link>
        </section>
      </>
    );
  if (!sitting)
    return (
      <>
        <PageTitle
          title={t("Before you begin")}
          description={t(
            "Start a new attempt or resume your existing session.",
          )}
        />
        <section className="panel start-panel">
          <Clock size={34} />
          <h2>{t("Ready for your assessment?")}</h2>
          <p>
            {t(
              " The timer starts when the server opens your attempt. Answers save as you go. Returning here resumes the same attempt. ",
            )}
          </p>
          <p className="subtle">
            {previewMode
              ? t(
                  "This is a demo assessment. No university results are affected.",
                )
              : t(
                  "You can open and take this exam in your normal browser. Follow your exam rules and instructions.",
                )}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (
                readiness.online &&
                readiness.query.data?.ready &&
                (readiness.query.data.resumable || acknowledged)
              )
                start.mutate();
            }}
          >
            <ReadinessChecklist {...readiness} user={user} />
            <div className="exam-rules">
              {readiness.query.data?.maxReentries !== undefined && <p>{t("Maximum re-entries: {0}. Refreshing or reopening the exam counts as a re-entry.", { "0": readiness.query.data.maxReentries })}</p>}
              <h3>{t("Exam rules")}</h3>
              <p>
                {t(
                  "The timer continues if you leave or lose connection. Answer every question before submitting. Your final submission cannot be changed.",
                )}
              </p>
            </div>
            {!readiness.query.data?.resumable && (
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                {t("I understand the exam rules")}
              </label>
            )}
            <div className="field">
              <label htmlFor="entry-code">
                {t("Entry code (if required)")}
              </label>
              <input
                id="entry-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
              />
            </div>
            <Feedback error={start.error} />
            <button
              className="primary"
              disabled={
                start.isPending ||
                !readiness.online ||
                !readiness.query.data?.ready ||
                (!readiness.query.data.resumable && !acknowledged) ||
                (!readiness.query.data.resumable &&
                  readiness.query.data.requiresCode &&
                  !code.trim())
              }
            >
              {start.isPending ? t("Opening exam…") : t("Start or resume exam")}
            </button>
          </form>
          <Link className="back-link" to="/exams">
            {t(" \u2190 Back to exams ")}
          </Link>
        </section>
      </>
    );
  return (
    <>
      <div className="runner-heading">
        <div>
          <span className="page-kicker">{t("ASSESSMENT IN PROGRESS")}</span>
          <h1>
            {t(" Question ")}
            {index + 1}
            {t(" of ")}
            {sitting.questions.length}
          </h1>
          <p>
            {answered}
            {t(" answered \u00B7")}{" "}
            {sitting.questions.filter((q) => q.isFlagged).length}
            {t(" flagged ")}
          </p>
          <div
            className="run-progress"
            role="progressbar"
            aria-valuenow={answered}
            aria-valuemin={0}
            aria-valuemax={sitting.questions.length}
            aria-label={t("Answered questions")}
          >
            <i
              style={{
                width: `${sitting.questions.length ? (answered / sitting.questions.length) * 100 : 0}%`,
              }}
            />
          </div>
          <p className="subtle kbd-hint">
            {t("Tip: press 1\u20134 to answer, \u2190 \u2192 to move.")}
          </p>
        </div>
        <div className={`timer ${remaining < 300 ? "urgent" : ""}`}>
          <Clock size={19} />
          {Math.floor(remaining / 60)
            .toString()
            .padStart(2, "0")}
          :{(remaining % 60).toString().padStart(2, "0")}
        </div>
      </div>
      {notice && (
        <div className="info-banner" role="status">
          {t(notice)}
        </div>
      )}
      <Feedback error={error} />
      <Feedback error={hbError} />
      <Feedback error={finish.error} />
      {unsaved > 0 && (
        <div className="error-banner">
          <span>
            {unsaved}
            {t(" answer(s) could not be saved. Retry before submitting. ")}
          </span>
          <button
            className="text-button"
            onClick={() => {
              setError(null);
              Object.entries(retryAnswers).forEach(([id, value]) =>
                choose(id, value),
              );
            }}
          >
            {t(" Retry saves ")}
          </button>
        </div>
      )}
      <div className="runner-grid">
        <section className="panel question-panel">
          {sitting.questions.slice(pageStart, pageStart + pageSize).map((q, offset) => (
            <article id={`exam-question-${q.questionId}`} key={q.questionId} className={`exam-question ${index === pageStart + offset ? "focused-question" : ""}`} onFocus={() => setIndex(pageStart + offset)} onClick={() => setIndex(pageStart + offset)}>
              <div className="question-meta">
                <span>
                  {q.grade}
                  {t(" marks")}
                </span>
                <button
                  className={`secondary ${q.isFlagged ? "flagged" : ""}`}
                  disabled={flag.isPending || remaining === 0}
                  onClick={() =>
                    flag.mutate({
                      questionId: q.questionId,
                      isFlagged: !q.isFlagged,
                    })
                  }
                >
                  <Flag size={15} />
                  {q.isFlagged ? t("Flagged for review") : t("Flag for review")}
                </button>
              </div>
              <h2>{pageStart + offset + 1}. {q.text}</h2>
              {q.imageUrl && (
                <img
                  className="question-image"
                  src={
                    q.imageUrl.startsWith("/") ? apiUrl(q.imageUrl) : q.imageUrl
                  }
                  alt={t("Question diagram")}
                />
              )}
              <fieldset className="answer-options">
                <legend className="sr-only">{t("Select an answer")}</legend>
                {q.options.map((o, i) => (
                  <label
                    className={q.selectedAnswer === o ? "selected" : ""}
                    key={o}
                  >
                    <input
                      type="radio"
                      name={"answer-" + q.questionId}
                      checked={q.selectedAnswer === o}
                      onChange={() => choose(q.questionId, o)}
                      disabled={remaining === 0 || finish.isPending}
                    />
                    <span className="option-letter">
                      {String.fromCharCode(65 + i)}
                    </span>
                    <span>{o}</span>
                  </label>
                ))}
              </fieldset>
              <button
                className="text-button"
                onClick={() => choose(q.questionId, null)}
                disabled={!q.selectedAnswer || finish.isPending || remaining === 0}
              >
                {t(" Clear answer ")}
              </button>
            </article>
          ))}
          <div className="runner-controls">
            <button className="secondary" disabled={pageStart === 0} onClick={() => setIndex(Math.max(0, pageStart - pageSize))}><ChevronLeft size={15} />{t("Previous")}</button>
            <span className="save-status" role="status">{queued ? t("Saving…") : unsaved ? t("Save needed") : t("Answers synced")}</span>
            {lastPage ? <button className="primary" disabled={answered < sitting.questions.length || queued > 0 || unsaved > 0 || finish.isPending || remaining === 0} onClick={() => setConfirm(true)}>{t("Submit assessment")}</button>
              : <button className="primary" onClick={() => setIndex(pageStart + pageSize)}>{t("Next")}<ChevronRight size={15} /></button>}
          </div>
        </section>
        <aside className="panel question-nav">
          <h2>{t("Question navigator")}</h2>
          <div className="question-number-grid">
            {sitting.questions.map((q, i) => (
              <button
                key={q.id}
                className={`${index === i ? "current" : ""} ${q.selectedAnswer ? "answered" : ""} ${q.isFlagged ? "is-flagged" : ""}`}
                aria-label={t("Question {0}{1}", {
                  "0": i + 1,
                  "1": q.isFlagged ? t(", flagged") : "",
                })}
                onClick={() => { setIndex(i); setTimeout(() => document.getElementById(`exam-question-${q.questionId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }), 0); }}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <div className="navigator-legend">
            <span>{t("\u25CF Answered")}</span>
            <span>{t("\u2691 Flagged")}</span>
          </div>
          <button
            className="primary"
            disabled={
              answered < sitting.questions.length ||
              unsaved > 0 ||
              queued > 0 ||
              finish.isPending ||
              remaining === 0
            }
            onClick={() => setConfirm(true)}
          >
            {t(" Submit assessment ")}
          </button>
          <p className="subtle">
            {t(
              "Answer every question before submitting. You cannot change your answers afterward.",
            )}
          </p>
          {(sitting.examToolsEnabled !== false || sitting.notesEnabled || sitting.notesForDoctorEnabled) && <ExamTools userId={user.id} examId={id!} sitting={sitting} disabled={remaining === 0 || finish.isPending} />}
        </aside>
      </div>
      {confirm && (
        <Confirm
          title={t("Submit assessment?")}
          text={t(
            "{0} of {1} questions answered. {2} unanswered. Submission is final.",
            {
              "0": answered,
              "1": sitting.questions.length,
              "2": sitting.questions.length - answered,
            },
          )}
          onClose={() => setConfirm(false)}
          busy={finish.isPending}
          error={finish.error}
          onConfirm={() => { if (!queued && !unsaved && answered === sitting.questions.length && !finish.isPending && remaining > 0) finish.mutate(); }}
        />
      )}
    </>
  );
}
