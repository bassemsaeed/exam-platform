import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Award,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  FileDown,
  FilePenLine,
  Flag,
  HelpCircle,
  Image as ImageIcon,
  Layers,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Users,
  Video,
  Volume2,
} from "lucide-react";
import { useT } from "../lib/i18n";
import { useUIStore } from "../lib/workspace-state";
import { label } from "../lib/platform";
import { exportAnalyticsPdf } from "../lib/analyticsPdf";
import { Empty } from "./ui";
import { QuestionMediaPlayer, questionDisplayText } from "./QuestionMedia";
import { questionTypeLabel } from "./QuestionTypesUI";

export interface AnalyticsQuestion {
  questionId: string;
  text: string;
  type: string;
  difficulty: string;
  grade: number;
  imageUrl?: string | null;
  mediaUrl?: string | null;
  mediaType?: "audio" | "video" | null;
  attempts: number;
  answered: number;
  skipped: number;
  correct: number;
  wrong: number;
  pctCorrect: number;
  pctWrong: number;
  wrongOfAnsweredPct: number;
  answerRate: number;
  avgAward: number;
  flagged: number;
  voidPassDelta: number;
  discriminationIndex: number | null;
  mostCommonWrongOption: { label: string; picks: number; pct: number } | null;
  distractorBeatKey: boolean;
  alertLevel: "critical" | "warning" | "ok";
  flagReasons: string[];
  options: { label: string; picks: number; pct: number; isCorrect: boolean }[];
}

export interface ExamAnalyticsData {
  examId: string;
  durationMinutes?: number;
  assigned: number | null;
  started: number;
  absent: number | null;
  submitted: number;
  inProgress: number;
  completionRate?: number | null;
  pendingManualGrades?: number;
  avg: number;
  median: number;
  q1?: number;
  q3?: number;
  stdDev?: number;
  high: number;
  low: number;
  passRate: number;
  passCount: number;
  autoSubmitted: number;
  rushSubmits: number;
  avgMinutesUsed: number;
  distribution: number[];
  submitCurve: { t: string; n: number }[];
  timeBuckets?: {
    key: string;
    label: string;
    n: number;
    avg: number;
    passRate: number;
  }[];
  difficultyBreakdown?: {
    difficulty: string;
    questionCount: number;
    attempts: number;
    correct: number;
    wrong: number;
    pctCorrect: number;
  }[];
  questionTypeBreakdown?: {
    type: string;
    questionCount: number;
    attempts: number;
    correct: number;
    pctCorrect: number;
  }[];
  flaggedSummary?: {
    totalQuestions: number;
    criticalCount: number;
    warningCount: number;
    highMissCount: number;
    lowDiscriminationCount: number;
    distractorBeatKeyCount: number;
  };
  reentry: {
    single: { n: number; avg: number };
    multi: { n: number; avg: number };
  };
  sections: {
    sectionId: string;
    name: string;
    n: number;
    avg: number;
    passRate: number;
  }[];
  questions: AnalyticsQuestion[];
  prevTerm: {
    termName: string;
    avg: number;
    passRate: number;
    submitted: number;
  } | null;
}

function downloadAnalyticsCsv(
  examTitle: string,
  questions: AnalyticsQuestion[],
  threshold: number,
  t: (s: string) => string,
) {
  const esc = (v: string | number | null | undefined) => {
    const raw = v == null ? "" : String(v);
    const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = [
    t("Question"),
    t("Type"),
    t("Difficulty"),
    t("Marks"),
    t("Attempts"),
    t("Correct"),
    t("Wrong"),
    t("Skipped"),
    t("Correct %"),
    t("Wrong %"),
    t("Status"),
    t("Most chosen wrong answer"),
    t("Student flags"),
  ];
  const rows = questions.map((q) => [
    questionDisplayText(q, t),
    questionTypeLabel(q.type, t),
    t(label(q.difficulty)),
    q.grade,
    q.attempts,
    q.correct,
    q.wrong,
    q.skipped,
    `${q.pctCorrect}%`,
    `${q.pctWrong}%`,
    q.pctWrong >= threshold || q.distractorBeatKey ? t("Needs review") : t("Good"),
    q.mostCommonWrongOption
      ? `${q.mostCommonWrongOption.label} (${q.mostCommonWrongOption.picks})`
      : "",
    q.flagged,
  ]);
  const csv = [
    headers.map(esc).join(","),
    ...rows.map((r) => r.map(esc).join(",")),
  ].join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(examTitle || "exam").replace(/[^a-zA-Z0-9_-]+/g, "_")}-analytics.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function plainQuality(
  q: AnalyticsQuestion,
  t: (s: string) => string,
): { text: string; tone: "good" | "warn" | "bad" | "neutral" } {
  if (q.distractorBeatKey) {
    return { text: t("Wrong choice beat right answer"), tone: "bad" };
  }
  if (q.discriminationIndex !== null && q.discriminationIndex < 0) {
    return { text: t("Top students missed it too — check wording"), tone: "bad" };
  }
  if (q.discriminationIndex !== null && q.discriminationIndex < 0.15) {
    return { text: t("Similar results across all levels"), tone: "warn" };
  }
  if (q.discriminationIndex === null) {
    return { text: t("Not enough attempts yet"), tone: "neutral" };
  }
  return { text: t("Good — separates strong & weak students"), tone: "good" };
}

export function ExamAnalytics({
  data,
  examTitle,
  canCompensate = false,
  onJumpToAdjustments,
  onJumpToGrading,
}: {
  data: ExamAnalyticsData;
  examTitle: string;
  canCompensate?: boolean;
  onJumpToAdjustments?: () => void;
  onJumpToGrading?: () => void;
}) {
  const t = useT();
  const language = useUIStore((s) => s.language);
  const [wrongThreshold, setWrongThreshold] = useState(50);
  const [qFilter, setQFilter] = useState<"all" | "flagged" | "distractor">("all");
  const [qSort, setQSort] = useState<"worst" | "best" | "flags">("worst");
  const [openQ, setOpenQ] = useState<string | null>(null);

  const isFlaggedByRule = (q: AnalyticsQuestion) =>
    q.pctWrong >= wrongThreshold ||
    q.distractorBeatKey ||
    (q.discriminationIndex !== null && q.discriminationIndex < 0);

  const flaggedQuestions = useMemo(
    () => data.questions.filter(isFlaggedByRule),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.questions, wrongThreshold],
  );

  const visibleQuestions = useMemo(() => {
    let list = data.questions;
    if (qFilter === "flagged") list = list.filter(isFlaggedByRule);
    else if (qFilter === "distractor") list = list.filter((q) => q.distractorBeatKey);

    const copy = [...list];
    if (qSort === "worst") copy.sort((a, b) => b.pctWrong - a.pctWrong || b.wrong - a.wrong);
    else if (qSort === "best") copy.sort((a, b) => b.pctCorrect - a.pctCorrect);
    else if (qSort === "flags") copy.sort((a, b) => b.flagged - a.flagged || b.pctWrong - a.pctWrong);
    return copy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.questions, qFilter, qSort, wrongThreshold]);

  if (!data.submitted) {
    return (
      <Empty
        title={t("No graded attempts yet")}
        text={t("Clear performance summaries and flagged questions will appear once students submit.")}
      />
    );
  }

  const maxDist = Math.max(1, ...data.distribution);
  const maxCurve = Math.max(1, ...data.submitCurve.map((x) => x.n));
  const avgDelta = data.prevTerm ? Math.round(data.avg - data.prevTerm.avg) : null;
  const passDelta = data.prevTerm ? Math.round(data.passRate - data.prevTerm.passRate) : null;
  const failedCount = Math.max(0, data.submitted - data.passCount);
  const durationUsedPct =
    data.durationMinutes && data.durationMinutes > 0
      ? Math.min(100, Math.round((data.avgMinutesUsed / data.durationMinutes) * 100))
      : null;

  return (
    <div className="an-dashboard">
      {/* Clean Header Bar with PDF + CSV Export */}
      <div className="an-topbar">
        <div className="an-topbar-left">
          <span className="an-live-pill">
            <BarChart3 size={13} />
            {t("{0} graded attempts", { "0": data.submitted })}
          </span>
          {data.inProgress > 0 && (
            <span className="an-live-pill active">
              <i className="an-pulse-dot" />
              {data.inProgress} {t("taking now")}
            </span>
          )}
          {data.prevTerm && avgDelta !== null && (
            <span className={`an-delta-pill ${avgDelta >= 0 ? "up" : "down"}`}>
              {avgDelta >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              {avgDelta >= 0 ? `+${avgDelta}%` : `${avgDelta}%`} {t("vs")} {data.prevTerm.termName}
            </span>
          )}
        </div>
        <div className="an-export-actions">
          <button
            type="button"
            className="primary an-export-btn"
            onClick={() =>
              exportAnalyticsPdf({
                data,
                examTitle,
                wrongThreshold,
                language,
                t,
              })
            }
          >
            <FileDown size={14} />
            {t("Download PDF")}
          </button>
          <button
            type="button"
            className="secondary an-export-btn"
            onClick={() => downloadAnalyticsCsv(examTitle, data.questions, wrongThreshold, t)}
          >
            <Download size={14} />
            {t("Export CSV")}
          </button>
        </div>
      </div>

      {/* Pending Manual Essay Grading Notice */}
      {Boolean(data.pendingManualGrades && data.pendingManualGrades > 0) && (
        <div className="info-banner" role="status">
          <FilePenLine size={16} />
          <span style={{ flex: 1 }}>
            {t("{0} essay answers are still waiting for manual grading. Scores will update once graded.", {
              "0": data.pendingManualGrades,
            })}
          </span>
          {onJumpToGrading && (
            <button type="button" className="secondary" onClick={onJumpToGrading}>
              {t("Grade essays")}
            </button>
          )}
        </div>
      )}

      {/* Executive Callout: Flagged Questions */}
      {flaggedQuestions.length > 0 ? (
        <div className="an-alert-banner" role="region" aria-label={t("Questions needing review")}>
          <div className="an-alert-icon">
            <ShieldAlert size={20} />
          </div>
          <div className="an-alert-copy">
            <strong>
              {t("{0} of {1} questions need review", {
                "0": flaggedQuestions.length,
                "1": data.questions.length,
              })}
            </strong>
            <p>
              {t("These questions were answered wrong by ≥{0}% of students or had a wrong choice picked more than the right answer.", {
                "0": wrongThreshold,
              })}
            </p>
          </div>
          <button
            type="button"
            className="secondary an-alert-cta"
            onClick={() => {
              setQFilter("flagged");
              setQSort("worst");
              document
                .getElementById("an-question-analysis")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            <AlertTriangle size={14} />
            {t("Review flagged ({0})", { "0": flaggedQuestions.length })}
          </button>
        </div>
      ) : (
        <div className="an-ok-banner" role="status">
          <CheckCircle2 size={17} />
          <span>
            {t("Great balance — no questions crossed the ≥{0}% wrong-answer threshold.", {
              "0": wrongThreshold,
            })}
          </span>
        </div>
      )}

      {/* 4 Clear Executive KPI Cards */}
      <div className="an-kpi-grid">
        <div className="an-kpi-card">
          <div className="an-kpi-head">
            <span>{t("Students finished")}</span>
            <span className="an-kpi-ico blue">
              <Users size={15} />
            </span>
          </div>
          <div className="an-kpi-val">
            {data.submitted}
            {data.assigned !== null && <span className="an-kpi-denom"> / {data.assigned}</span>}
          </div>
          <div className="an-kpi-sub">
            {data.completionRate != null
              ? `${data.completionRate}% ${t("completed")}`
              : `${data.started} ${t("started")}`}
            {data.absent != null && data.absent > 0 ? ` · ${data.absent} ${t("absent")}` : ""}
          </div>
        </div>

        <div className="an-kpi-card">
          <div className="an-kpi-head">
            <span>{t("Average score")}</span>
            <span className="an-kpi-ico indigo">
              <BarChart3 size={15} />
            </span>
          </div>
          <div className="an-kpi-val">{Math.round(data.avg)}%</div>
          <div className="an-kpi-sub">
            {t("Middle score")} {Math.round(data.median)}% · {Math.round(data.low)}–{Math.round(data.high)}%
          </div>
        </div>

        <div className="an-kpi-card">
          <div className="an-kpi-head">
            <span>{t("Pass rate (≥60%)")}</span>
            <span className={`an-kpi-ico ${data.passRate >= 60 ? "green" : "amber"}`}>
              <Award size={15} />
            </span>
          </div>
          <div className="an-kpi-val">{Math.round(data.passRate)}%</div>
          <div className="an-kpi-sub">
            {data.passCount} {t("passed")} · {failedCount} {t("did not pass")}
          </div>
        </div>

        <div className={`an-kpi-card ${flaggedQuestions.length > 0 ? "an-kpi-alert" : ""}`}>
          <div className="an-kpi-head">
            <span>{t("Questions needing review")}</span>
            <span className={`an-kpi-ico ${flaggedQuestions.length > 0 ? "red" : "green"}`}>
              <AlertTriangle size={15} />
            </span>
          </div>
          <div className="an-kpi-val">
            {flaggedQuestions.length}
            <span className="an-kpi-denom"> / {data.questions.length}</span>
          </div>
          <div className="an-kpi-sub">
            {t("Answered wrong by ≥{0}%", { "0": wrongThreshold })}
          </div>
        </div>
      </div>

      {/* 2-Column Clean Visual Summary */}
      <div className="an-charts-grid">
        {/* Score Distribution */}
        <div className="an-card">
          <div className="an-card-head">
            <div>
              <h3>{t("Score distribution")}</h3>
              <p className="subtle">{t("How many students scored in each 10% range (pass line is 60%)")}</p>
            </div>
            <div className="an-legend">
              <span>
                <i className="an-dot fail" /> {t("Below pass")}
              </span>
              <span>
                <i className="an-dot pass" /> {t("Passing")}
              </span>
            </div>
          </div>
          <div className="an-hist" role="img" aria-label={t("Score distribution")}>
            {data.distribution.map((n, i) => {
              const passing = i >= 6;
              const pctH = n > 0 ? Math.max(8, Math.round((n / maxDist) * 100)) : 2;
              return (
                <div
                  className={`an-hist-col ${i === 6 ? "pass-divider" : ""}`}
                  key={i}
                  title={`${i * 10}–${i * 10 + 10}%: ${n}`}
                >
                  <b className={n === 0 ? "zero" : ""}>{n}</b>
                  <div className="an-hist-track">
                    <span
                      className={`an-hist-bar ${passing ? "pass" : "fail"} ${n === 0 ? "empty" : ""}`}
                      style={{ height: `${pctH}%` }}
                    />
                  </div>
                  <small>{i * 10}%</small>
                </div>
              );
            })}
          </div>
        </div>

        {/* Difficulty & Time Taken */}
        <div className="an-card">
          <div className="an-card-head">
            <div>
              <h3>{t("Performance by difficulty & time")}</h3>
              <p className="subtle">{t("Average accuracy per difficulty level and how time spent affected grades")}</p>
            </div>
          </div>

          {data.difficultyBreakdown && data.difficultyBreakdown.length > 0 && (
            <div className="an-breakdown-list">
              {data.difficultyBreakdown.map((d) => {
                const tone =
                  d.pctCorrect < 45 ? "bad" : d.pctCorrect < 65 ? "warn" : "good";
                return (
                  <div className="an-break-row" key={d.difficulty}>
                    <div className="an-break-meta">
                      <span className={`badge badge-${d.difficulty}`}>{t(label(d.difficulty))}</span>
                      <span className="subtle">
                        {d.questionCount} {t("questions")} · {d.correct}/{d.attempts} {t("correct")}
                      </span>
                      <strong className={`an-pct ${tone}`}>{d.pctCorrect}%</strong>
                    </div>
                    <div className="an-bar-track">
                      <i className={`an-bar-fill ${tone}`} style={{ width: `${d.pctCorrect}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {data.timeBuckets && data.timeBuckets.some((b) => b.n > 0) && (
            <div className="an-pacing-block">
              <div className="an-mini-title">
                <Clock size={13} /> {t("Average score by time spent")}
              </div>
              <div className="an-pacing-grid">
                {data.timeBuckets.map((b) => (
                  <div className="an-pacing-cell" key={b.key}>
                    <small>{t(b.label)}</small>
                    <strong>{b.n > 0 ? `${Math.round(b.avg)}%` : "—"}</strong>
                    <span>
                      {b.n} {t("students")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Section: Question Review & High-Wrong Flagging */}
      <div className="an-card" id="an-question-analysis">
        <div className="an-card-head wrap">
          <div>
            <h3>{t("Questions review")}</h3>
            <p className="subtle">
              {t("Hardest questions appear first. Click any question to see what students answered.")}
            </p>
          </div>
          <div className="an-threshold-picker">
            <span className="subtle">{t("Flag if wrong ≥")}</span>
            {[40, 50, 60, 70].map((thr) => (
              <button
                key={thr}
                type="button"
                className={`an-thr-chip ${wrongThreshold === thr ? "on" : ""}`}
                onClick={() => setWrongThreshold(thr)}
              >
                {thr}%
              </button>
            ))}
          </div>
        </div>

        <div className="an-q-controls">
          <div className="an-filter-tabs" role="tablist" aria-label={t("Filter questions")}>
            <button
              type="button"
              role="tab"
              aria-selected={qFilter === "all"}
              className={qFilter === "all" ? "on" : ""}
              onClick={() => setQFilter("all")}
            >
              {t("All questions")} ({data.questions.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={qFilter === "flagged"}
              className={`flag-tab ${qFilter === "flagged" ? "on" : ""}`}
              onClick={() => setQFilter("flagged")}
            >
              <AlertTriangle size={12} /> {t("Flagged")} ({flaggedQuestions.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={qFilter === "distractor"}
              className={qFilter === "distractor" ? "on" : ""}
              onClick={() => setQFilter("distractor")}
            >
              {t("Wrong choice won")} (
              {data.questions.filter((q) => q.distractorBeatKey).length})
            </button>
          </div>

          <div className="an-sort-row">
            <label htmlFor="an-sort-select" className="subtle">
              {t("Sort by")}:
            </label>
            <select
              id="an-sort-select"
              value={qSort}
              onChange={(e) => setQSort(e.target.value as typeof qSort)}
            >
              <option value="worst">{t("Hardest first (most wrong)")}</option>
              <option value="best">{t("Easiest first (most correct)")}</option>
              <option value="flags">{t("Most flagged by students")}</option>
            </select>
          </div>
        </div>

        {visibleQuestions.length === 0 ? (
          <div className="an-empty-inline">
            <HelpCircle size={18} />
            <span>{t("No questions match this filter.")}</span>
          </div>
        ) : (
          <div className="an-q-list">
            {visibleQuestions.map((q) => {
              const open = openQ === q.questionId;
              const flagged = isFlaggedByRule(q);
              const severity =
                q.pctWrong >= Math.max(wrongThreshold + 10, 60) || q.distractorBeatKey
                  ? "critical"
                  : flagged
                    ? "warning"
                    : "ok";
              const barTone =
                q.pctCorrect < 40 ? "bad" : q.pctCorrect < 60 ? "warn" : "good";
              const quality = plainQuality(q, t);
              const titleText = questionDisplayText(q, t);

              return (
                <div
                  className={`an-q-card ${severity !== "ok" ? `flagged-${severity}` : ""}`}
                  key={q.questionId}
                >
                  <button
                    type="button"
                    className="an-q-head"
                    aria-expanded={open}
                    onClick={() => setOpenQ(open ? null : q.questionId)}
                  >
                    <div className="an-q-main">
                      <div className="an-q-badges">
                        {flagged && (
                          <span className={`an-flag-badge ${severity}`}>
                            <AlertTriangle size={11} />
                            {q.pctWrong >= wrongThreshold
                              ? t("Needs review · {0}% wrong", { "0": q.pctWrong })
                              : t("Needs review")}
                          </span>
                        )}
                        <span className={`badge badge-${q.difficulty}`}>
                          {t(label(q.difficulty))}
                        </span>
                        <span className="an-meta-tag">{questionTypeLabel(q.type, t)}</span>
                        {q.mediaType === "video" && (
                          <span className="an-meta-tag media">
                            <Video size={11} /> {t("Video")}
                          </span>
                        )}
                        {q.mediaType === "audio" && (
                          <span className="an-meta-tag media">
                            <Volume2 size={11} /> {t("Voice")}
                          </span>
                        )}
                        {q.imageUrl && (
                          <span className="an-meta-tag media">
                            <ImageIcon size={11} /> {t("Image")}
                          </span>
                        )}
                      </div>

                      <div className="an-q-title">{titleText}</div>

                      <div className="an-q-submeta">
                        <span>
                          <b>{q.correct}</b> {t("correct")}
                        </span>
                        <span>·</span>
                        <span className={q.wrong > 0 ? "an-txt-bad" : ""}>
                          <b>{q.wrong}</b> {t("wrong")}
                        </span>
                        {q.skipped > 0 && (
                          <>
                            <span>·</span>
                            <span>
                              <b>{q.skipped}</b> {t("skipped")}
                            </span>
                          </>
                        )}
                        {q.flagged > 0 && (
                          <>
                            <span>·</span>
                            <span>
                              <Flag size={11} style={{ verticalAlign: "-1px" }} /> {q.flagged}{" "}
                              {t("flagged")}
                            </span>
                          </>
                        )}
                        {q.mostCommonWrongOption && flagged && (
                          <>
                            <span>·</span>
                            <span className="an-txt-warn">
                              {t("Most chosen wrong answer")}: “{q.mostCommonWrongOption.label}” (
                              {q.mostCommonWrongOption.pct}%)
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="an-q-right">
                      <div className="an-q-meter">
                        <div className="an-q-meter-nums">
                          <strong className={`an-pct ${barTone}`}>{q.pctCorrect}%</strong>
                          <small>{t("correct")}</small>
                        </div>
                        <div className="an-bar-track sm">
                          <i
                            className={`an-bar-fill ${barTone}`}
                            style={{ width: `${q.pctCorrect}%` }}
                          />
                        </div>
                      </div>
                      <span className="an-chevron">
                        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </span>
                    </div>
                  </button>

                  {open && (
                    <div className="an-q-body">
                      {q.mediaUrl && q.mediaType && (
                        <QuestionMediaPlayer
                          mediaUrl={q.mediaUrl}
                          mediaType={q.mediaType}
                          compact
                        />
                      )}

                      {q.options.length > 0 && (
                        <div className="an-opt-list">
                          <div className="an-mini-title">{t("How students answered")}</div>
                          {q.options.map((o) => {
                            const isTopDistractor =
                              !o.isCorrect &&
                              q.mostCommonWrongOption &&
                              o.label === q.mostCommonWrongOption.label &&
                              o.picks > 0;
                            return (
                              <div
                                className={`an-opt-row ${o.isCorrect ? "is-key" : ""} ${isTopDistractor ? "is-top-wrong" : ""}`}
                                key={o.label}
                              >
                                <div className="an-opt-label">
                                  <span dir="auto">{o.label}</span>
                                  {o.isCorrect && (
                                    <span className="an-opt-tag key">
                                      <CheckCircle2 size={11} /> {t("Correct answer")}
                                    </span>
                                  )}
                                  {isTopDistractor && (
                                    <span className="an-opt-tag wrong">
                                      {t("Most chosen wrong answer")}
                                    </span>
                                  )}
                                </div>
                                <div className="an-opt-bar-wrap">
                                  <div className="an-bar-track">
                                    <i
                                      className={`an-bar-fill ${o.isCorrect ? "good" : isTopDistractor ? "bad" : "neutral"}`}
                                      style={{ width: `${Math.max(o.picks > 0 ? 4 : 0, o.pct)}%` }}
                                    />
                                  </div>
                                  <span className="an-opt-count">
                                    <b>{o.picks}</b> ({o.pct}%)
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div className="an-q-metrics-strip clean-3">
                        <div className="an-metric-pill">
                          <small>{t("Average marks earned")}</small>
                          <b>
                            {q.avgAward} / {q.grade}
                          </b>
                        </div>
                        <div className="an-metric-pill">
                          <small>{t("Question quality")}</small>
                          <b className={`an-pct ${quality.tone}`}>{quality.text}</b>
                        </div>
                        <div className="an-metric-pill">
                          <small>{t("If given full credit")}</small>
                          <b>
                            {q.voidPassDelta > 0
                              ? t("+{0} students would pass", { "0": q.voidPassDelta })
                              : t("No change to pass count")}
                          </b>
                        </div>
                      </div>

                      {canCompensate && flagged && onJumpToAdjustments && (
                        <div className="an-q-footer-cta">
                          <button
                            type="button"
                            className="secondary"
                            onClick={onJumpToAdjustments}
                          >
                            <Layers size={14} /> {t("Adjust grade for this question")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom Clean Insights: Sections + Time & Submissions */}
      <div className="an-charts-grid">
        {data.sections.length > 0 && (
          <div className="an-card">
            <div className="an-card-head">
              <div>
                <h3>{t("Sections compared")}</h3>
                <p className="subtle">{t("Average score and pass rate by section")}</p>
              </div>
            </div>
            <div className="an-breakdown-list">
              {data.sections.map((s) => {
                const tone = s.avg < 50 ? "bad" : s.avg < 65 ? "warn" : "good";
                return (
                  <div className="an-break-row" key={s.sectionId}>
                    <div className="an-break-meta">
                      <b>{s.name}</b>
                      <span className="subtle">
                        {s.n} {t("students")} · {Math.round(s.passRate)}% {t("passed")}
                      </span>
                      <strong className={`an-pct ${tone}`}>{Math.round(s.avg)}%</strong>
                    </div>
                    <div className="an-bar-track">
                      <i className={`an-bar-fill ${tone}`} style={{ width: `${s.avg}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="an-card">
          <div className="an-card-head">
            <div>
              <h3>{t("Time & submissions")}</h3>
              <p className="subtle">{t("How long students took and when they submitted")}</p>
            </div>
          </div>

          <div className="an-integrity-grid">
            <div className="an-metric-pill">
              <small>{t("Avg time used")}</small>
              <b>
                {Math.round(data.avgMinutesUsed)} {t("min")}
                {durationUsedPct !== null ? ` (${durationUsedPct}%)` : ""}
              </b>
            </div>
            <div className="an-metric-pill">
              <small>{t("Finished very fast")}</small>
              <b>{data.rushSubmits}</b>
            </div>
            <div className="an-metric-pill">
              <small>{t("Auto-submitted")}</small>
              <b>{data.autoSubmitted}</b>
            </div>
            <div className="an-metric-pill">
              <small>{t("Re-entered exam")}</small>
              <b>
                {data.reentry.multi.n}{" "}
                {data.reentry.multi.n > 0 ? `(${Math.round(data.reentry.multi.avg)}%)` : ""}
              </b>
            </div>
          </div>

          <div className="an-curve" role="img" aria-label={t("Submissions over time")}>
            {data.submitCurve.map((b, i) => {
              const h = b.n > 0 ? Math.max(10, Math.round((b.n / maxCurve) * 100)) : 3;
              return (
                <div
                  className="an-curve-col"
                  key={i}
                  title={`${new Date(b.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${b.n}`}
                >
                  <span className={b.n === 0 ? "empty" : ""} style={{ height: `${h}%` }} />
                </div>
              );
            })}
          </div>

          {data.prevTerm && (
            <div className="an-prev-term">
              <span>
                {t("Previous term ({0}): avg {1}%, pass {2}% across {3} attempts.", {
                  "0": data.prevTerm.termName,
                  "1": Math.round(data.prevTerm.avg),
                  "2": Math.round(data.prevTerm.passRate),
                  "3": data.prevTerm.submitted,
                })}
              </span>
              {passDelta !== null && (
                <span className={`an-delta-pill ${passDelta >= 0 ? "up" : "down"}`}>
                  {t("Pass rate")}: {passDelta >= 0 ? `+${passDelta}%` : `${passDelta}%`}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
