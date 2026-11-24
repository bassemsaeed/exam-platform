import { useMemo, useState } from "react";
import {
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

export function buildGradeBands(distribution: number[], total: number) {
  const sum = (from: number, to: number) => {
    let s = 0;
    for (let i = from; i <= to; i++) s += distribution[i] ?? 0;
    return s;
  };
  const bands = [
    { key: "excellent", label: "Excellent", range: "90–100%", count: sum(9, 9), tone: "emerald" as const },
    { key: "very_good", label: "Very Good", range: "80–89%", count: sum(8, 8), tone: "blue" as const },
    { key: "good", label: "Good", range: "70–79%", count: sum(7, 7), tone: "sky" as const },
    { key: "pass", label: "Pass", range: "60–69%", count: sum(6, 6), tone: "slate" as const },
    { key: "below", label: "Below Pass", range: "0–59%", count: sum(0, 5), tone: "amber" as const },
  ];
  return bands.map((b) => ({
    ...b,
    pct: total > 0 ? Math.round((b.count / total) * 100) : 0,
  }));
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
    t("Top wrong choice"),
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
    q.pctWrong >= threshold || q.distractorBeatKey ? t("Flagged") : t("OK"),
    q.mostCommonWrongOption
      ? `${q.mostCommonWrongOption.label} (${q.mostCommonWrongOption.picks})`
      : "",
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

function shortQuality(
  q: AnalyticsQuestion,
  t: (s: string) => string,
): { text: string; tone: "good" | "warn" | "bad" | "neutral" } {
  if (q.distractorBeatKey) return { text: t("Check answer key"), tone: "bad" };
  if (q.discriminationIndex !== null && q.discriminationIndex < 0) {
    return { text: t("Check wording"), tone: "warn" };
  }
  if (q.discriminationIndex !== null && q.discriminationIndex < 0.15) {
    return { text: t("Fair"), tone: "neutral" };
  }
  if (q.discriminationIndex === null) return { text: "—", tone: "neutral" };
  return { text: t("Good"), tone: "good" };
}

function PassDonut({ passRate }: { passRate: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(passRate)));
  const r = 42;
  const c = 2 * Math.PI * r;
  const dash = (clamped / 100) * c;
  return (
    <div className="an-donut-wrap" aria-hidden="true">
      <svg viewBox="0 0 104 104" className="an-donut-svg">
        <circle cx="52" cy="52" r={r} className="an-donut-track" />
        <circle
          cx="52"
          cy="52"
          r={r}
          className={`an-donut-ring ${clamped >= 60 ? "good" : "warn"}`}
          strokeDasharray={`${dash} ${c}`}
          transform="rotate(-90 52 52)"
        />
      </svg>
      <div className="an-donut-center">
        <strong>{clamped}%</strong>
      </div>
    </div>
  );
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
  const [qFilter, setQFilter] = useState<"all" | "flagged">("all");
  const [qSort, setQSort] = useState<"worst" | "best" | "flags">("worst");
  const [openQ, setOpenQ] = useState<string | null>(null);

  const isFlaggedByRule = (q: AnalyticsQuestion) =>
    q.pctWrong >= wrongThreshold || q.distractorBeatKey;

  const flaggedQuestions = useMemo(
    () => data.questions.filter(isFlaggedByRule),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.questions, wrongThreshold],
  );

  const visibleQuestions = useMemo(() => {
    const list = qFilter === "flagged" ? data.questions.filter(isFlaggedByRule) : data.questions;
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

  const gradeBands = buildGradeBands(data.distribution, data.submitted);
  const maxBandCount = Math.max(1, ...gradeBands.map((b) => b.count));
  const avgDelta = data.prevTerm ? Math.round(data.avg - data.prevTerm.avg) : null;
  const failedCount = Math.max(0, data.submitted - data.passCount);
  const passPct = Math.round(data.passRate);
  const failPct = Math.max(0, 100 - passPct);
  const durationUsedPct =
    data.durationMinutes && data.durationMinutes > 0
      ? Math.min(100, Math.round((data.avgMinutesUsed / data.durationMinutes) * 100))
      : null;

  return (
    <div className="an-dashboard">
      {/* Header Bar */}
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

      {/* Pending Essay Grading Strip */}
      {Boolean(data.pendingManualGrades && data.pendingManualGrades > 0) && (
        <div className="an-slim-notice info" role="status">
          <FilePenLine size={15} />
          <span>
            {t("{0} essays awaiting manual grade", { "0": data.pendingManualGrades })}
          </span>
          {onJumpToGrading && (
            <button type="button" className="text-button" onClick={onJumpToGrading}>
              {t("Grade essays")}
            </button>
          )}
        </div>
      )}

      {/* Calm, 1-line Flag Summary Bar (no heavy red wall) */}
      {flaggedQuestions.length > 0 && (
        <div className="an-slim-notice warn" role="region" aria-label={t("Flagged questions")}>
          <Flag size={14} />
          <span>
            <b>{t("{0} flagged questions", { "0": flaggedQuestions.length })}</b>
            {" · "}
            {t("≥{0}% wrong", { "0": wrongThreshold })}
          </span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setQFilter("flagged");
              setQSort("worst");
              document
                .getElementById("an-question-analysis")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            {t("Show flagged")}
          </button>
        </div>
      )}

      {/* 4 Clean KPI Cards */}
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
            <span>{t("Pass rate")}</span>
            <span className={`an-kpi-ico ${passPct >= 60 ? "green" : "amber"}`}>
              <Award size={15} />
            </span>
          </div>
          <div className="an-kpi-val">{passPct}%</div>
          <div className="an-kpi-sub">
            {data.passCount} {t("passed")} · {failedCount} {t("did not pass")}
          </div>
        </div>

        <div className="an-kpi-card">
          <div className="an-kpi-head">
            <span>{t("Flagged questions")}</span>
            <span className={`an-kpi-ico ${flaggedQuestions.length > 0 ? "amber" : "green"}`}>
              <Flag size={15} />
            </span>
          </div>
          <div className="an-kpi-val">
            {flaggedQuestions.length}
            <span className="an-kpi-denom"> / {data.questions.length}</span>
          </div>
          <div className="an-kpi-sub">
            {t("≥{0}% wrong", { "0": wrongThreshold })}
          </div>
        </div>
      </div>

      {/* 2 Crystal-Clear Visual Diagrams */}
      <div className="an-charts-grid">
        {/* Diagram 1: 5-Band Grade Breakdown (Horizontal, Fully Labeled) */}
        <div className="an-card">
          <div className="an-card-head">
            <div>
              <h3>{t("Grade breakdown")}</h3>
              <p className="subtle">{t("Number and percentage of students in each grade level")}</p>
            </div>
          </div>

          <div className="an-band-list" role="img" aria-label={t("Grade breakdown")}>
            {gradeBands.map((b) => {
              const barWidth = b.count > 0 ? Math.max(6, Math.round((b.count / maxBandCount) * 100)) : 0;
              return (
                <div className="an-band-row" key={b.key}>
                  <div className="an-band-label">
                    <b>{t(b.label)}</b>
                    <small>{b.range}</small>
                  </div>
                  <div className="an-band-track">
                    {barWidth > 0 && (
                      <i className={`an-band-fill tone-${b.tone}`} style={{ width: `${barWidth}%` }} />
                    )}
                  </div>
                  <div className="an-band-val">
                    <b>{b.count}</b>
                    <small>({b.pct}%)</small>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Diagram 2: Pass Overview Ring + Difficulty Accuracy */}
        <div className="an-card">
          <div className="an-card-head">
            <div>
              <h3>{t("Pass overview & difficulty")}</h3>
              <p className="subtle">{t("Pass line is 60% · accuracy grouped by question difficulty")}</p>
            </div>
          </div>

          <div className="an-pass-summary">
            <PassDonut passRate={passPct} />
            <div className="an-pass-legend">
              <div className="an-pass-stat">
                <i className="an-dot-round good" />
                <span>{t("Passed (≥60%)")}</span>
                <b>
                  {data.passCount} ({passPct}%)
                </b>
              </div>
              <div className="an-pass-stat">
                <i className="an-dot-round warn" />
                <span>{t("Below pass (<60%)")}</span>
                <b>
                  {failedCount} ({failPct}%)
                </b>
              </div>
              <div className="an-pass-stat">
                <i className="an-dot-round blue" />
                <span>{t("Avg time used")}</span>
                <b>
                  {Math.round(data.avgMinutesUsed)} {t("min")}
                  {data.durationMinutes ? ` / ${data.durationMinutes}` : ""}
                </b>
              </div>
            </div>
          </div>

          {data.difficultyBreakdown && data.difficultyBreakdown.length > 0 && (
            <div className="an-diff-section">
              <div className="an-mini-title">{t("Accuracy by difficulty")}</div>
              <div className="an-breakdown-list">
                {data.difficultyBreakdown.map((d) => {
                  const tone = d.pctCorrect < 45 ? "warn" : d.pctCorrect < 65 ? "neutral" : "good";
                  return (
                    <div className="an-break-row" key={d.difficulty}>
                      <div className="an-break-meta">
                        <span className={`badge badge-${d.difficulty}`}>{t(label(d.difficulty))}</span>
                        <span className="subtle">
                          {d.questionCount} {t("questions")}
                        </span>
                        <strong className={`an-pct ${tone}`}>{d.pctCorrect}% {t("correct")}</strong>
                      </div>
                      <div className="an-bar-track">
                        <i className={`an-bar-fill ${tone}`} style={{ width: `${d.pctCorrect}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Question Review & Clean Short Flags */}
      <div className="an-card" id="an-question-analysis">
        <div className="an-card-head wrap">
          <div>
            <h3>{t("Questions review")}</h3>
            <p className="subtle">
              {t("Click a question to inspect student answers.")}
            </p>
          </div>
          <div className="an-threshold-picker">
            <span className="subtle">{t("Flag ≥")}</span>
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
              {t("All")} ({data.questions.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={qFilter === "flagged"}
              className={`flag-tab-soft ${qFilter === "flagged" ? "on" : ""}`}
              onClick={() => setQFilter("flagged")}
            >
              <Flag size={12} /> {t("Flagged")} ({flaggedQuestions.length})
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
              <option value="worst">{t("Most wrong first")}</option>
              <option value="best">{t("Most correct first")}</option>
              <option value="flags">{t("Most student flags")}</option>
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
              const barTone = q.pctCorrect < 45 ? "warn" : q.pctCorrect < 65 ? "neutral" : "good";
              const quality = shortQuality(q, t);
              const titleText = questionDisplayText(q, t);

              return (
                <div
                  className={`an-q-card ${flagged ? "is-flagged-soft" : ""}`}
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
                          <span className="an-flag-chip">
                            <Flag size={10} />
                            {q.pctWrong}% {t("wrong")}
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
                          {q.correct} / {q.attempts} {t("correct")}
                        </span>
                        {q.skipped > 0 && (
                          <>
                            <span>·</span>
                            <span>
                              {q.skipped} {t("skipped")}
                            </span>
                          </>
                        )}
                        {q.flagged > 0 && (
                          <>
                            <span>·</span>
                            <span>
                              {q.flagged} {t("flagged")}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="an-q-right">
                      <div className="an-q-meter">
                        <div className="an-q-meter-nums">
                          <strong className={`an-pct ${barTone}`}>{q.pctCorrect}%</strong>
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
                            const isTopWrong =
                              !o.isCorrect &&
                              q.mostCommonWrongOption &&
                              o.label === q.mostCommonWrongOption.label &&
                              o.picks > 0;
                            return (
                              <div
                                className={`an-opt-row ${o.isCorrect ? "is-key" : ""}`}
                                key={o.label}
                              >
                                <div className="an-opt-label">
                                  <span dir="auto">{o.label}</span>
                                  {o.isCorrect && (
                                    <span className="an-opt-tag key">
                                      <CheckCircle2 size={11} /> {t("Correct")}
                                    </span>
                                  )}
                                  {isTopWrong && (
                                    <span className="an-opt-tag soft-warn">
                                      {t("Top wrong")}
                                    </span>
                                  )}
                                </div>
                                <div className="an-opt-bar-wrap">
                                  <div className="an-bar-track">
                                    <i
                                      className={`an-bar-fill ${o.isCorrect ? "good" : isTopWrong ? "warn" : "neutral"}`}
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
                          <small>{t("Avg marks")}</small>
                          <b>
                            {q.avgAward} / {q.grade}
                          </b>
                        </div>
                        <div className="an-metric-pill">
                          <small>{t("Quality")}</small>
                          <b className={`an-pct ${quality.tone}`}>{quality.text}</b>
                        </div>
                        <div className="an-metric-pill">
                          <small>{t("Full-credit lift")}</small>
                          <b>
                            {q.voidPassDelta > 0
                              ? `+${q.voidPassDelta} ${t("passed")}`
                              : "—"}
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
                            <Layers size={14} /> {t("Adjust grade")}
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

      {/* Bottom: Sections + Clear Time-Spent Breakdown */}
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
                const tone = s.avg < 50 ? "warn" : s.avg < 65 ? "neutral" : "good";
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
              <h3>{t("Time spent & scores")}</h3>
              <p className="subtle">{t("How long students spent compared to their average score")}</p>
            </div>
          </div>

          {data.timeBuckets && data.timeBuckets.some((b) => b.n > 0) && (
            <div className="an-band-list">
              {data.timeBuckets.map((b) => {
                const avgScore = Math.round(b.avg);
                return (
                  <div className="an-band-row" key={b.key}>
                    <div className="an-band-label">
                      <b>{t(b.label)}</b>
                      <small>
                        {b.n} {t("students")}
                      </small>
                    </div>
                    <div className="an-band-track">
                      {b.n > 0 && (
                        <i
                          className={`an-band-fill tone-${avgScore >= 60 ? "blue" : "amber"}`}
                          style={{ width: `${Math.max(6, avgScore)}%` }}
                        />
                      )}
                    </div>
                    <div className="an-band-val">
                      <b>{b.n > 0 ? `${avgScore}%` : "—"}</b>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="an-timing-footer">
            <span>
              <Clock size={12} /> {t("Avg time used")}:{" "}
              <b>
                {Math.round(data.avgMinutesUsed)} {t("min")}
                {durationUsedPct !== null ? ` (${durationUsedPct}%)` : ""}
              </b>
            </span>
            <span>
              {t("Auto-submitted")}: <b>{data.autoSubmitted}</b>
            </span>
            <span>
              {t("Re-entered")}: <b>{data.reentry.multi.n}</b>
            </span>
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
