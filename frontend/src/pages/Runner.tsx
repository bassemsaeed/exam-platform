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
  ShieldCheck,
  FileText,
} from "lucide-react";
import type { SessionUser } from "../lib/api";
import { authClient } from "../lib/auth-client";
import {
  request,
  previewMode,
  invalidateResources,
  useResource,
  type Sitting,
} from "../lib/platform";
import { apiUrl, sebHeaders } from "../lib/seb";
import { ApiError } from "../lib/api";
import { ExamTools } from "../components/ExamTools";
import { BriefingPlayer } from "../components/Instructions";
import { Feedback, Confirm, Dialog, PageTitle } from "../components/ui";
export function ExamRunner({ user, onActivity }: { user: SessionUser; onActivity: (path: string | null) => void }) {
  const t = useT();
  const { id } = useParams();
  // Server-issued entry token: persisted per exam so refreshes/resumes present
  // the latest token the server issued (rotation consumes re-entry budget).
  const tokenKey = `entry-token-${id}`;
  const loadToken = (k: string) => {
    try { return sessionStorage.getItem(k) ?? crypto.randomUUID(); }
    catch { return crypto.randomUUID(); }
  };
  const [entryToken, setEntryToken] = useState(() => loadToken(tokenKey));
  const [sitting, setSitting] = useState<Sitting | null>(null);
  const [code, setCode] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [briefingDone, setBriefingDone] = useState(false);
  const [showBriefingModal, setShowBriefingModal] = useState(false);

  const [index, setIndex] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [hbError, setHbError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<{
    totalGrade: number | null;
    totalMarks?: number | null;
    status: string;
    resultsReleased?: boolean;
  } | null>(null);
  const [queued, setQueued] = useState(0);
  const [retryAnswers, setRetryAnswers] = useState<
    Record<string, string | null>
  >({});
  const readiness = useExamReadiness(user, id, !sitting && !result);
  // Session-expiry guard during an active attempt: poll session truth every
  // minute; under 20 minutes left, offer a one-click refresh (sliding
  // sessions extend on getSession) so work is never lost to a logout.
  const sessionWatch = useResource<SessionUser>(
    user,
    "/api/v1/me",
    !!sitting && !result,
    60000,
  );
  const [extending, setExtending] = useState(false);
  const sessionMs = sessionWatch.data?.sessionExpiresAt
    ? new Date(sessionWatch.data.sessionExpiresAt).getTime() - Date.now()
    : null;
  async function staySignedIn() {
    setExtending(true);
    try {
      await authClient.getSession();
      await invalidateResources(user.id, ["/api/v1/me"]);
    } finally {
      setExtending(false);
    }
  }
  useEffect(() => {
    if (readiness.query.data?.submitted) onActivity(null);
  }, [readiness.query.data?.submitted]);
  const deadline = useRef(0);
  const latest = useRef(sitting);
  latest.current = sitting;
  const cursor = useRef("");
  // Mutations are serialized so a slow older answer cannot overwrite a newer choice.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const flushToolsRef = useRef<(() => Promise<void>) | null>(null);
  const loadSubmitKey = (examId: string | undefined): string => {
    try {
      const storageKey = `submit-key-${examId}`;
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
      return existing;
    } catch {
      return crypto.randomUUID();
    }
  };
  const submitKeyRef = useRef<{ examId: string | undefined; key: string }>({
    examId: id,
    key: loadSubmitKey(id),
  });
  if (submitKeyRef.current.examId !== id) {
    submitKeyRef.current = { examId: id, key: loadSubmitKey(id) };
  }
  useEffect(() => {
    setEntryToken(loadToken(`entry-token-${id}`));
  }, [id]);
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
    mutationFn: async () => {
      // Drain in-flight answer saves and any unsaved notes before finalizing.
      await queue.current.catch(() => {});
      await flushToolsRef.current?.().catch(() => {});
      return request<{
        totalGrade: number | null;
        totalMarks?: number | null;
        status: string;
        resultsReleased?: boolean;
      }>(
        `/api/v1/student/exams/${id}/submit`,
        "POST",
        {},
        { "Idempotency-Key": submitKeyRef.current.key },
      );
    },
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
        try {
          const raw = sessionStorage.getItem(`pending-answers-${user.id}-${id}`);
          if (raw) {
            const draft = JSON.parse(raw) as Record<string, string | null>;
            delete draft[v.questionId];
            sessionStorage.setItem(`pending-answers-${user.id}-${id}`, JSON.stringify(draft));
          }
        } catch {
          /* memory only */
        }
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
  const choose = useCallback(
    (questionId: string, selectedAnswer: string | null) => {
      // Refresh-proof drafts: every optimistic answer (including explicit clears)
      // lands in sessionStorage first, so a reload replays whatever the server never confirmed.
      try {
        const raw = sessionStorage.getItem(`pending-answers-${user.id}-${id}`);
        const draft = raw ? (JSON.parse(raw) as Record<string, string | null>) : {};
        draft[questionId] = selectedAnswer;
        sessionStorage.setItem(`pending-answers-${user.id}-${id}`, JSON.stringify(draft));
      } catch {
        /* memory only */
      }
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
    [answer, user.id, id],
  );
  // Replay refresh-proof drafts once per attempt: anything the server never
  // confirmed (differs from the loaded sitting) goes back through the queue.
  const draftReplayed = useRef("");
  useEffect(() => {
    if (!sitting || draftReplayed.current === sitting.id) return;
    draftReplayed.current = sitting.id;
    let draft: Record<string, string | null> = {};
    try {
      const raw = sessionStorage.getItem(`pending-answers-${user.id}-${id}`);
      if (raw) draft = JSON.parse(raw) as Record<string, string | null>;
    } catch {
      return;
    }
    const server = new Map(sitting.questions.map((q) => [q.questionId, q.selectedAnswer]));
    for (const [questionId, value] of Object.entries(draft)) {
      if (!server.has(questionId)) continue;
      if ((server.get(questionId) ?? null) !== value) choose(questionId, value);
    }
  }, [sitting, choose, user.id, id]);
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
          if (err instanceof ApiError && err.status === 409) {
            onActivity(null);
            setNotice(err.message);
            if (!finish.isPending) finish.mutate();
            return;
          }
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
    // Timeout auto-submit: submit even with unanswered questions — the server
    // finalizes partial attempts. Manual button still requires all answered.
    if (sitting && remaining === 0 && !result && !finish.isPending && !finish.isError)
      finish.mutate();
  }, [remaining, !!sitting, !!result, finish.isPending, finish.isError]);
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
              if (type === "closed") {
                onActivity(null);
                setNotice(
                  "This exam has been closed. The server will finalize your attempt.",
                );
              } else if (type === "voided") {
                setNotice(
                  String(
                    payload.message ??
                      payload.reason ??
                      "A question was compensated by your instructor. Your exam is still active.",
                  ),
                );
              } else {
                setNotice(String(payload.message ?? payload.reason ?? type));
              }
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
  // SEB gate: this assessment demands the locked browser and the current
  // request doesn't carry a valid SEB header — show the locked panel instead
  // of the start form. The start endpoint enforces the same rule server-side.
  const sebLocked =
    !previewMode &&
    !!readiness.query.data &&
    !!readiness.query.data.sebRequired &&
    !readiness.query.data.sebVerified;
  const unsaved = Object.keys(retryAnswers).length;
  // Keyboard-first runner: 1-4/A-D answer, arrows move, nothing stolen
  // while typing or using the calculator. Disabled once time is up or a dialog is open.
  useEffect(() => {
    if (!sitting || result || confirm) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.closest(".exam-calculator"))) return;
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
          {result.resultsReleased === false ? (
            <p>
              {t(
                "Your attempt has been recorded. Your grade will appear here and in Results after your doctor publishes it.",
              )}
            </p>
          ) : (
            <>
              <p>{t("Your grade")}</p>
              <strong>
                {result.totalGrade ?? "—"}/{result.totalMarks ?? "—"} <small>{t("marks")}</small>
              </strong>
            </>
          )}
          <Link className="button primary" to="/results">
            {t(" View my results ")}
          </Link>
        </section>
      </>
    );
  if (!sitting) {
    const rd = readiness.query.data;
    const hasBriefing = Boolean(rd?.instructionsText?.trim() || rd?.instructionsMediaUrl);
    const needsMediaGate = Boolean(
      !rd?.resumable &&
        rd?.instructionsRequireCompletion &&
        rd?.instructionsMediaUrl &&
        !briefingDone,
    );
    const canStart = Boolean(
      readiness.online &&
        rd?.ready &&
        (rd.resumable || acknowledged) &&
        !needsMediaGate &&
        (rd.resumable || !rd.requiresCode || code.trim()),
    );
    return (
      <>
        <PageTitle
          title={rd?.title?.trim() || t("Before you begin")}
          description={
            rd
              ? `${rd.subject.code} · ${rd.subject.name} · ${rd.durationMinutes} ${t("minutes")}`
              : t("Start a new attempt or resume your existing session.")
          }
        />
        <div className={`lobby-shell ${hasBriefing && !sebLocked ? "has-briefing" : ""}`}>
          {hasBriefing && !sebLocked && rd && (
            <div className="lobby-briefing-col">
              <BriefingPlayer
                text={rd.instructionsText}
                mediaUrl={rd.instructionsMediaUrl}
                mediaType={rd.instructionsMediaType}
                requireCompletion={Boolean(!rd.resumable && rd.instructionsRequireCompletion)}
                completed={briefingDone}
                onComplete={() => setBriefingDone(true)}
              />
              <section className="panel exam-rules">
                <h3>{t("Exam rules")}</h3>
                {rd.maxReentries !== undefined && (
                  <p>
                    {rd.entriesUsed
                      ? t("You have used {0} of {1} entries. Refreshing or reopening the exam counts as a re-entry.", {
                          "0": Math.min(rd.entriesUsed, rd.maxReentries + 1),
                          "1": rd.maxReentries + 1,
                        })
                      : t("Maximum re-entries: {0}. Refreshing or reopening the exam counts as a re-entry.", {
                          "0": rd.maxReentries,
                        })}
                  </p>
                )}
                <p>
                  {t(
                    "The timer continues if you leave or lose connection. Answer every question before submitting. Your final submission cannot be changed.",
                  )}
                </p>
                <p className="subtle">
                  {t("Question and answer order is shuffled uniquely for every student.")}
                </p>
              </section>
            </div>
          )}

          <section className="panel start-panel">
            <Clock size={30} />
            <h2>{t("Ready for your assessment?")}</h2>
            <p>
              {t(
                "The timer starts when the server opens your attempt. Answers save as you go. Returning here resumes the same attempt.",
              )}
            </p>
            <p className="subtle">
              {previewMode
                ? t("This is a demo assessment. No university results are affected.")
                : rd?.sebRequired
                  ? t("This assessment requires Safe Exam Browser. Open it from inside SEB to begin.")
                  : t("You can open and take this exam in your normal browser. Follow your exam rules and instructions.")}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (canStart) start.mutate();
              }}
            >
              {sebLocked ? (
                <div className="seb-locked" role="alert">
                  <ShieldCheck size={34} />
                  <h3>{t("Safe Exam Browser required")}</h3>
                  <p>
                    {t(
                      "This assessment opens only in Safe Exam Browser. Install it with your university configuration, then reopen this page from inside it — your attempt, timer and saved answers pick up where they belong.",
                    )}
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void readiness.query.refetch()}
                  >
                    {t("I opened it in SEB — recheck")}
                  </button>
                </div>
              ) : (
                <>
                  <ReadinessChecklist {...readiness} user={user} />
                  {!hasBriefing && (
                    <div className="exam-rules">
                      {rd?.maxReentries !== undefined && (
                        <p>
                          {rd.entriesUsed
                            ? t("You have used {0} of {1} entries. Refreshing or reopening the exam counts as a re-entry.", {
                                "0": Math.min(rd.entriesUsed, rd.maxReentries + 1),
                                "1": rd.maxReentries + 1,
                              })
                            : t("Maximum re-entries: {0}. Refreshing or reopening the exam counts as a re-entry.", {
                                "0": rd.maxReentries,
                              })}
                        </p>
                      )}
                      <p className="subtle">
                        {t("Question and answer order is shuffled uniquely for every student.")}
                      </p>
                      <h3>{t("Exam rules")}</h3>
                      <p>
                        {t(
                          "The timer continues if you leave or lose connection. Answer every question before submitting. Your final submission cannot be changed.",
                        )}
                      </p>
                    </div>
                  )}
                  {!rd?.resumable && (
                    <label className="inline-check">
                      <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                      />
                      {t("I understand the exam rules")}
                    </label>
                  )}
                  {rd?.requiresCode && !rd.resumable && (
                    <div className="field">
                      <label htmlFor="entry-code">{t("Entry code")}</label>
                      <input
                        id="entry-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder={t("Enter the assessment entry code")}
                        autoComplete="off"
                      />
                    </div>
                  )}
                  {needsMediaGate && (
                    <p className="subtle briefing-gate-note" role="status">
                      {rd?.instructionsMediaType === "video"
                        ? t("Finish watching the instructor's video briefing to enable Start.")
                        : t("Finish listening to the instructor's voice briefing to enable Start.")}
                    </p>
                  )}
                  <Feedback error={start.error} />
                  <button className="primary" disabled={start.isPending || !canStart}>
                    {start.isPending ? t("Opening exam…") : t("Start or resume exam")}
                  </button>
                </>
              )}
            </form>
            <Link className="back-link" to="/exams">
              {t(" \u2190 Back to exams ")}
            </Link>
          </section>
        </div>
      </>
    );
  }
  const hasSittingBriefing = Boolean(
    sitting.instructionsText?.trim() || sitting.instructionsMediaUrl,
  );
  return (
    <>
      {sessionMs !== null && sessionMs < 20 * 60 * 1000 && (
        <div className="error-banner" role="alert">
          <span>
            {t("Your sign-in expires in {0} minutes. Extend it now so your answers keep saving.", {
              "0": Math.max(1, Math.ceil(sessionMs / 60000)),
            })}
          </span>
          <button
            className="secondary"
            disabled={extending}
            onClick={() => void staySignedIn()}
          >
            {extending ? t("Extending…") : t("Stay signed in")}
          </button>
        </div>
      )}
      <div className="runner-heading sticky">
        <div className="runner-heading-main">
          <span className="page-kicker">
            {sitting.title?.trim() || t("ASSESSMENT IN PROGRESS")}
          </span>
          <div className="runner-heading-row">
            <h1>
              {t(" Question ")}
              {index + 1}
              {t(" of ")}
              {sitting.questions.length}
            </h1>
            <span className="subtle">
              {answered}/{sitting.questions.length} {t("answered")} ·{" "}
              {sitting.questions.filter((q) => q.isFlagged).length} {t("flagged")}
              {sitting.maxReentries !== undefined &&
                sitting.entriesUsed !== undefined &&
                ` · ${t("Entry {0} of {1}", {
                  "0": Math.min(sitting.entriesUsed, sitting.maxReentries + 1),
                  "1": sitting.maxReentries + 1,
                })}`}
            </span>
          </div>
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
        </div>
        <div className="runner-heading-right">
          {hasSittingBriefing && (
            <button
              type="button"
              className="secondary runner-briefing-btn"
              onClick={() => setShowBriefingModal(true)}
            >
              <FileText size={15} /> {t("Instructions")}
            </button>
          )}
          <div className={`timer ${remaining < 300 ? "urgent" : ""}`}>
            <Clock size={18} />
            {Math.floor(remaining / 60)
              .toString()
              .padStart(2, "0")}
            :{(remaining % 60).toString().padStart(2, "0")}
          </div>
        </div>
      </div>
      {showBriefingModal && (
        <Dialog
          title={t("Instructor instructions")}
          onClose={() => setShowBriefingModal(false)}
        >
          <BriefingPlayer
            text={sitting.instructionsText}
            mediaUrl={sitting.instructionsMediaUrl}
            mediaType={sitting.instructionsMediaType}
            compact
          />
        </Dialog>
      )}
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
                    key={`${q.questionId}-${i}`}
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
          {(sitting.examToolsEnabled !== false || sitting.notesEnabled || sitting.notesForDoctorEnabled) && <ExamTools userId={user.id} examId={id!} sitting={sitting} disabled={remaining === 0 || finish.isPending} flushRef={flushToolsRef} />}
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
