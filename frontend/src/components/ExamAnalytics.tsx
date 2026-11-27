import { useMemo, useState } from "react";
import {
  AlertCircle,
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
  Image as ImageIcon,
  Lightbulb,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
  Video,
  Volume2,
} from "lucide-react";
import { useT } from "../lib/i18n";
import { useUIStore } from "../lib/workspace-state";
import { label } from "../lib/platform";
import { apiUrl } from "../lib/seb";
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
  timeScorePoints?: { minutes: number; score: number }[];
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
    return { text: t("Check answer key"), tone: "bad" };
  }
  if (q.discriminationIndex !== null && q.discriminationIndex < 0) {
    return { text: t("Check wording"), tone: "warn" };
  }
  if (q.discriminationIndex !== null && q.discriminationIndex < 0.15) {
    return { text: t("Fair"), tone: "neutral" };
  }
  if (q.discriminationIndex === null) {
    return { text: t("Not enough attempts yet"), tone: "neutral" };
  }
  return { text: t("Good"), tone: "good" };
}

function monotonePath(pts: { x: number; y: number }[], minY: number, maxY: number): string {
  const n = pts.length;
  if (n < 2) return "";
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    dy.push(pts[i + 1].y - pts[i].y);
    m.push(dx[i] !== 0 ? dy[i] / dx[i] : 0);
  }
  const tangents: number[] = new Array(n).fill(0);
  tangents[0] = m[0];
  tangents[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangents[i] = 0;
    } else {
      tangents[i] = (m[i - 1] + m[i]) / 2;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const a = tangents[i] / m[i];
      const b = tangents[i + 1] / m[i];
      const h = Math.hypot(a, b);
      if (h > 3) {
        const s = 3 / h;
        tangents[i] = s * a * m[i];
        tangents[i + 1] = s * b * m[i];
      }
    }
  }
  const clamp = (v: number) => Math.max(minY, Math.min(maxY, v));
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const step = dx[i] / 3;
    const c1x = pts[i].x + step;
    const c1y = clamp(pts[i].y + tangents[i] * step);
    const c2x = pts[i + 1].x - step;
    const c2y = clamp(pts[i + 1].y - tangents[i + 1] * step);
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
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
  const [selectedQ, setSelectedQ] = useState<string | null>(null);
  const [hoverBin, setHoverBin] = useState<number | null>(null);
  const [hoverDot, setHoverDot] = useState<string | null>(null);
  const [hoverScatter, setHoverScatter] = useState<number | null>(null);

  const isFlaggedByRule = (q: AnalyticsQuestion) =>
    q.pctWrong >= wrongThreshold ||
    q.distractorBeatKey ||
    (q.discriminationIndex !== null && q.discriminationIndex < 0);

  // Assign stable Q1..QN codes sorted by question index as received
  const indexedQuestions = useMemo(
    () => data.questions.map((q, idx) => ({ ...q, code: `Q${idx + 1}` })),
    [data.questions],
  );

  const flaggedQuestions = useMemo(
    () => indexedQuestions.filter(isFlaggedByRule),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [indexedQuestions, wrongThreshold],
  );

  const visibleQuestions = useMemo(() => {
    let list = indexedQuestions;
    if (qFilter === "flagged") list = list.filter(isFlaggedByRule);
    else if (qFilter === "distractor") list = list.filter((q) => q.distractorBeatKey);

    const copy = [...list];
    if (qSort === "worst") copy.sort((a, b) => b.pctWrong - a.pctWrong || b.wrong - a.wrong);
    else if (qSort === "best") copy.sort((a, b) => b.pctCorrect - a.pctCorrect);
    else if (qSort === "flags") copy.sort((a, b) => b.flagged - a.flagged || b.pctWrong - a.pctWrong);
    return copy;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexedQuestions, qFilter, qSort, wrongThreshold]);

  // Grade tiers computed from 10-bucket distribution (0..9)
  const gradeTiers = useMemo(() => {
    const d = data.distribution;
    const total = Math.max(1, d.reduce((a, b) => a + b, 0));
    const tiers = [
      { key: "exc", label: t("Excellent"), range: "90–100%", count: d[9] ?? 0, color: "#15803d" },
      { key: "vg", label: t("Very Good"), range: "80–89%", count: d[8] ?? 0, color: "#0a4d7b" },
      { key: "good", label: t("Good"), range: "70–79%", count: d[7] ?? 0, color: "#2b86c5" },
      { key: "pass", label: t("Pass"), range: "60–69%", count: d[6] ?? 0, color: "#d97706" },
      {
        key: "fail",
        label: t("Below Pass"),
        range: "< 60%",
        count: (d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0) + (d[3] ?? 0) + (d[4] ?? 0) + (d[5] ?? 0),
        color: "#c2594b",
      },
    ];
    return tiers.map((tier) => ({
      ...tier,
      pct: Math.round((tier.count / total) * 100),
    }));
  }, [data.distribution, t]);

  // Auto plain-language Key Takeaways for doctors/TAs
  const takeaways = useMemo(() => {
    const items: { tone: "good" | "warn" | "info"; text: string }[] = [];
    const avgRound = Math.round(data.avg);
    const passRound = Math.round(data.passRate);

    if (passRound >= 75) {
      items.push({
        tone: "good",
        text: t("Strong overall outcome: {0}% passed with a {1}% class average.", {
          "0": passRound,
          "1": avgRound,
        }),
      });
    } else if (passRound >= 55) {
      items.push({
        tone: "info",
        text: t("Moderate outcome: {0}% passed (average {1}%, middle score {2}%).", {
          "0": passRound,
          "1": avgRound,
          "2": Math.round(data.median),
        }),
      });
    } else {
      items.push({
        tone: "warn",
        text: t("Low pass rate ({0}%) with a {1}% average — consider reviewing difficult items.", {
          "0": passRound,
          "1": avgRound,
        }),
      });
    }

    const beatKey = indexedQuestions.filter((q) => q.distractorBeatKey);
    if (beatKey.length > 0) {
      const codes = beatKey.slice(0, 3).map((q) => q.code).join(", ");
      items.push({
        tone: "warn",
        text: t("Check answer key on {0}: a wrong choice was picked more than the right answer.", {
          "0": codes,
        }),
      });
    } else if (flaggedQuestions.length > 0) {
      const worst = [...flaggedQuestions].sort((a, b) => b.pctWrong - a.pctWrong)[0];
      items.push({
        tone: "warn",
        text: t("{0} questions crossed ≥{1}% wrong — hardest is {2} ({3}% missed).", {
          "0": flaggedQuestions.length,
          "1": wrongThreshold,
          "2": worst.code,
          "3": worst.pctWrong,
        }),
      });
    } else {
      items.push({
        tone: "good",
        text: t("All {0} questions stayed within healthy accuracy ranges.", {
          "0": indexedQuestions.length,
        }),
      });
    }

    if (data.sections.length >= 2) {
      const sortedSec = [...data.sections].sort((a, b) => a.avg - b.avg);
      const lowest = sortedSec[0];
      const highest = sortedSec[sortedSec.length - 1];
      const spread = Math.round(highest.avg - lowest.avg);
      if (spread >= 8) {
        items.push({
          tone: "info",
          text: t("{0} trails by {1} pts ({2}% vs {3}% in {4}).", {
            "0": lowest.name,
            "1": spread,
            "2": Math.round(lowest.avg),
            "3": Math.round(highest.avg),
            "4": highest.name,
          }),
        });
      }
    } else if (data.rushSubmits > 0 && data.submitted > 0) {
      const rushPct = Math.round((data.rushSubmits / data.submitted) * 100);
      if (rushPct >= 15) {
        items.push({
          tone: "info",
          text: t("{0} students ({1}%) finished in under a quarter of the allotted time.", {
            "0": data.rushSubmits,
            "1": rushPct,
          }),
        });
      }
    }

    return items.slice(0, 3);
  }, [data, indexedQuestions, flaggedQuestions, wrongThreshold, t]);

  if (!data.submitted) {
    return (
      <Empty
        title={t("No graded attempts yet")}
        text={t("Clear performance summaries and flagged questions will appear once students submit.")}
      />
    );
  }

  const avgDelta = data.prevTerm ? Math.round(data.avg - data.prevTerm.avg) : null;
  const failedCount = Math.max(0, data.submitted - data.passCount);
  const q1 = Math.round(data.q1 ?? data.low);
  const q3 = Math.round(data.q3 ?? data.high);
  const low = Math.round(data.low);
  const high = Math.round(data.high);
  const med = Math.round(data.median);
  const avg = Math.round(data.avg);

  // Histogram SVG geometry
  const histW = 540;
  const histH = 205;
  const hPadL = 34;
  const hPadR = 18;
  const hPadT = 28;
  const hPadB = 28;
  const plotW = histW - hPadL - hPadR;
  const plotH = histH - hPadT - hPadB;
  const maxDist = Math.max(1, ...data.distribution);
  const yTicks = Array.from(new Set([0, Math.ceil(maxDist / 2), maxDist]));
  const binW = plotW / 10;
  const curvePts = data.distribution.map((n, i) => ({
    x: hPadL + i * binW + binW / 2,
    y: hPadT + plotH - (n / maxDist) * plotH,
  }));
  const passX = hPadL + plotW * 0.6;
  const avgX = hPadL + plotW * Math.min(1, Math.max(0, data.avg / 100));
  const avgNearPass = Math.abs(avg - 60) < 15;

  // Donut SVG geometry
  const donutSize = 136;
  const donutR = 48;
  const donutC = 2 * Math.PI * donutR;
  const totalDist = Math.max(1, data.distribution.reduce((a, b) => a + b, 0));
  let accOffset = 0;

  // Calibration Map SVG geometry (3 lanes: Easy / Medium / Hard vs 0..100% correct)
  const calW = 860;
  const calH = 236;
  const cPadL = 88;
  const cPadR = 26;
  const cPadT = 26;
  const cPadB = 34;
  const cInnerPad = 16;
  const cPlotW = calW - cPadL - cPadR;
  const cDotSpanW = cPlotW - cInnerPad * 2;
  const cPlotH = calH - cPadT - cPadB;
  const laneH = cPlotH / 3;
  const lanes = [
    { key: "easy", label: t("Easy"), y: cPadT + laneH * 0.5 },
    { key: "medium", label: t("Medium"), y: cPadT + laneH * 1.5 },
    { key: "hard", label: t("Hard"), y: cPadT + laneH * 2.5 },
  ];
  const reviewZonePct = Math.max(10, Math.min(80, 100 - wrongThreshold));
  const reviewZoneW = cInnerPad + (reviewZonePct / 100) * cDotSpanW;

  // Collision-free bee-swarm dot placement per difficulty lane
  const calDots = (() => {
    const placedByLane = new Map<string, { x: number; y: number }[]>();
    const minDist = 25;
    const maxYOffset = Math.max(12, laneH * 0.36);
    const ySteps = [0, -14, 14, -24, 24].filter((v) => Math.abs(v) <= maxYOffset + 2);
    return indexedQuestions.map((q) => {
      const lane = lanes.find((l) => l.key === q.difficulty) ?? lanes[1];
      const baseX =
        cPadL + cInnerPad + (Math.min(100, Math.max(0, q.pctCorrect)) / 100) * cDotSpanW;
      const existing = placedByLane.get(lane.key) ?? [];
      const inwardDir = q.pctCorrect <= 50 ? 1 : -1;

      let chosenX = baseX;
      let chosenY = lane.y;
      let found = false;

      for (let col = 0; col < 10 && !found; col++) {
        const dx = col === 0 ? 0 : inwardDir * col * 24;
        const candX = Math.max(
          cPadL + cInnerPad,
          Math.min(calW - cPadR - cInnerPad, baseX + dx),
        );
        for (const dy of ySteps) {
          const candY = lane.y + dy;
          const collides = existing.some(
            (p) => Math.hypot(p.x - candX, p.y - candY) < minDist,
          );
          if (!collides) {
            chosenX = candX;
            chosenY = candY;
            found = true;
            break;
          }
        }
      }

      existing.push({ x: chosenX, y: chosenY });
      placedByLane.set(lane.key, existing);
      const flagged = isFlaggedByRule(q);
      return { q, cx: chosenX, cy: chosenY, flagged };
    });
  })();

  const jumpToQuestion = (qId: string) => {
    setSelectedQ(qId);
    setOpenQ(qId);
    setQFilter("all");
    requestAnimationFrame(() => {
      document
        .getElementById(`an-q-row-${qId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  // Scatter plot geometry (Time Spent vs Score)
  const scatterPts = data.timeScorePoints ?? [];
  const scW = 460;
  const scH = 195;
  const sPadL = 38;
  const sPadR = 16;
  const sPadT = 16;
  const sPadB = 30;
  const sPlotW = scW - sPadL - sPadR;
  const sPlotH = scH - sPadT - sPadB;
  const maxMins = Math.max(
    10,
    data.durationMinutes ?? 0,
    ...scatterPts.map((p) => p.minutes),
  );
  const rushX = sPadL + (maxMins * 0.25 / maxMins) * sPlotW;
  const passY = sPadT + sPlotH * (1 - 0.6);

  return (
    <div className="an2-root">
      {/* Top Action Strip */}
      <div className="an2-topbar">
        <div className="an2-chips">
          <span className="an2-chip">
            <BarChart3 size={13} />
            {t("{0} graded attempts", { "0": data.submitted })}
          </span>
          {data.inProgress > 0 && (
            <span className="an2-chip live">
              <i className="an-pulse-dot" />
              {data.inProgress} {t("taking now")}
            </span>
          )}
          {data.prevTerm && avgDelta !== null && (
            <span className={`an2-chip ${avgDelta >= 0 ? "up" : "down"}`}>
              {avgDelta >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
              {avgDelta >= 0 ? `+${avgDelta}%` : `${avgDelta}%`} {t("vs")} {data.prevTerm.termName}
            </span>
          )}
        </div>
        <div className="an2-actions">
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
        <div className="info-banner an2-essay-notice" role="status">
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

      {/* Auto Key Takeaways Strip */}
      <section className="an2-takeaways" aria-label={t("Key takeaways")}>
        <div className="an2-takeaways-head">
          <Lightbulb size={15} />
          <span>{t("Key takeaways")}</span>
        </div>
        <ul className="an2-takeaways-list">
          {takeaways.map((item, idx) => (
            <li key={idx} className={`an2-tk ${item.tone}`}>
              <i className="an2-tk-dot" aria-hidden="true" />
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* 4 Minimal KPI Cards */}
      <div className="an2-kpi-grid">
        <div className="an2-kpi">
          <div className="an2-kpi-top">
            <span>{t("Attendance")}</span>
            <Users size={15} className="an2-ico-blue" />
          </div>
          <div className="an2-kpi-val">
            {data.submitted}
            {data.assigned !== null && <small> / {data.assigned}</small>}
          </div>
          <div className="an2-kpi-sub">
            {data.completionRate != null
              ? `${data.completionRate}% ${t("completed")}`
              : `${data.started} ${t("started")}`}
            {data.absent != null && data.absent > 0 ? ` · ${data.absent} ${t("absent")}` : ""}
          </div>
        </div>

        <div className="an2-kpi">
          <div className="an2-kpi-top">
            <span>{t("Class average")}</span>
            <BarChart3 size={15} className="an2-ico-indigo" />
          </div>
          <div className="an2-kpi-val">{avg}%</div>
          <div className="an2-kpi-sub">
            {t("Middle score")} {med}% · {low}–{high}%
          </div>
        </div>

        <div className="an2-kpi">
          <div className="an2-kpi-top">
            <span>{t("Pass rate (≥60%)")}</span>
            <Award size={15} className={data.passRate >= 60 ? "an2-ico-green" : "an2-ico-amber"} />
          </div>
          <div className="an2-kpi-val">{Math.round(data.passRate)}%</div>
          <div className="an2-kpi-sub">
            {data.passCount} {t("passed")} · {failedCount} {t("did not pass")}
          </div>
        </div>

        <button
          type="button"
          className={`an2-kpi an2-kpi-btn ${flaggedQuestions.length > 0 ? "has-flags" : ""}`}
          onClick={() => {
            if (flaggedQuestions.length > 0) {
              setQFilter("flagged");
              setQSort("worst");
              document
                .getElementById("an-question-analysis")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }}
        >
          <div className="an2-kpi-top">
            <span>{t("Flagged questions")}</span>
            <Flag size={15} className={flaggedQuestions.length > 0 ? "an2-ico-amber" : "an2-ico-green"} />
          </div>
          <div className="an2-kpi-val">
            {flaggedQuestions.length}
            <small> / {data.questions.length}</small>
          </div>
          <div className="an2-kpi-sub">
            {flaggedQuestions.length > 0
              ? t("≥{0}% wrong · Click to review", { "0": wrongThreshold })
              : t("All items balanced")}
          </div>
        </button>
      </div>

      {/* Row 1: Score Distribution + Box Plot (Left) & Grade Tiers Donut (Right) */}
      <div className="an2-row-overview">
        <section className="an2-card">
          <div className="an2-card-head">
            <div>
              <h3>{t("Score distribution & spread")}</h3>
              <p className="subtle">
                {t("Students per 10% score band with 60% pass line and class average")}
              </p>
            </div>
            <div className="an2-legend">
              <span><i className="an2-swatch fail" />{t("Below pass")}</span>
              <span><i className="an2-swatch pass" />{t("Passing")}</span>
            </div>
          </div>

          <div className="an2-svg-wrap">
            <svg
              viewBox={`0 0 ${histW} ${histH}`}
              className="an2-svg"
              role="img"
              aria-label={t("Score distribution & spread")}
            >
              {/* Horizontal gridlines */}
              {yTicks.map((tick, idx) => {
                const y = hPadT + plotH - (tick / maxDist) * plotH;
                return (
                  <g key={idx}>
                    <line
                      x1={hPadL}
                      x2={histW - hPadR}
                      y1={y}
                      y2={y}
                      className="an2-gridline"
                    />
                    <text
                      x={hPadL - 8}
                      y={y + 3.5}
                      textAnchor="end"
                      className="an2-axis-lbl"
                    >
                      {tick}
                    </text>
                  </g>
                );
              })}

              {/* Histogram bars */}
              {data.distribution.map((n, i) => {
                const barH = n > 0 ? Math.max(4, (n / maxDist) * plotH) : 0;
                const x = hPadL + i * binW + 5;
                const y = hPadT + plotH - barH;
                const bw = Math.max(8, binW - 10);
                const isPass = i >= 6;
                const isHover = hoverBin === i;
                return (
                  <g
                    key={i}
                    onMouseEnter={() => setHoverBin(i)}
                    onMouseLeave={() => setHoverBin(null)}
                    className="an2-bar-group"
                  >
                    <rect
                      x={hPadL + i * binW}
                      y={hPadT}
                      width={binW}
                      height={plotH}
                      fill="transparent"
                    />
                    {n > 0 && (
                      <rect
                        x={x}
                        y={y}
                        width={bw}
                        height={barH}
                        rx={4}
                        className={`an2-bar ${isPass ? "pass" : "fail"} ${isHover ? "hover" : ""}`}
                      />
                    )}
                    {n > 0 && (
                      <text
                        x={x + bw / 2}
                        y={y - 5}
                        textAnchor="middle"
                        className="an2-bar-num"
                      >
                        {n}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* X-axis 0%..100% boundary ticks */}
              {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => {
                const x = hPadL + (pct / 100) * plotW;
                return (
                  <text
                    key={pct}
                    x={x}
                    y={histH - 8}
                    textAnchor="middle"
                    className="an2-axis-lbl"
                  >
                    {pct}%
                  </text>
                );
              })}

              {/* Smooth trend curve (clamped to never dip below 0) */}
              <path d={monotonePath(curvePts, hPadT, hPadT + plotH)} className="an2-curve-line" />

              {/* 60% Pass Line */}
              <line
                x1={passX}
                x2={passX}
                y1={hPadT - 6}
                y2={hPadT + plotH}
                className="an2-ref-pass"
              />
              <text
                x={passX + (avgNearPass && avg <= 60 ? 5 : 5)}
                y={hPadT - 10}
                textAnchor="start"
                className="an2-ref-lbl pass"
              >
                {t("60% Pass")}
              </text>

              {/* Class Average Line */}
              <line
                x1={avgX}
                x2={avgX}
                y1={hPadT - 6}
                y2={hPadT + plotH}
                className="an2-ref-avg"
              />
              <text
                x={avgX + (avgNearPass && avg <= 60 ? -5 : avg > 82 ? -5 : 5)}
                y={hPadT - 10}
                textAnchor={avgNearPass && avg <= 60 ? "end" : avg > 82 ? "end" : "start"}
                className="an2-ref-lbl avg"
              >
                {t("Avg")} {avg}%
              </text>
            </svg>

            {hoverBin !== null && (
              <div className="an2-tooltip">
                <b>
                  {hoverBin * 10}–{hoverBin === 9 ? 100 : hoverBin * 10 + 9}%
                </b>
                <span>
                  {data.distribution[hoverBin]} {t("students")} (
                  {Math.round((data.distribution[hoverBin] / totalDist) * 100)}%)
                </span>
              </div>
            )}
          </div>

          {/* Box-Plot Spread Strip */}
          <div className="an2-boxplot">
            <div className="an2-bp-head">
              <span>{t("Score spread (middle 50% in shaded box)")}</span>
              <span className="an2-bp-vals">
                {t("Low")} {low}% · Q1 {q1}% · <b>{t("Median")} {med}%</b> · Q3 {q3}% · {t("High")} {high}%
              </span>
            </div>
            <div className="an2-bp-track" aria-hidden="true">
              <div className="an2-bp-pass-tick" style={{ insetInlineStart: "60%" }} />
              <div
                className="an2-bp-whisker"
                style={{
                  insetInlineStart: `${low}%`,
                  width: `${Math.max(1, high - low)}%`,
                }}
              />
              <div
                className="an2-bp-iqr"
                style={{
                  insetInlineStart: `${q1}%`,
                  width: `${Math.max(2, q3 - q1)}%`,
                }}
              />
              <div className="an2-bp-med" style={{ insetInlineStart: `${med}%` }} />
            </div>
          </div>
        </section>

        {/* Grade Tiers Donut */}
        <section className="an2-card">
          <div className="an2-card-head">
            <div>
              <h3>{t("Grade breakdown")}</h3>
              <p className="subtle">{t("Students in each university grade tier")}</p>
            </div>
          </div>

          <div className="an2-donut-layout">
            <div className="an2-donut-wrap">
              <svg
                width={donutSize}
                height={donutSize}
                viewBox={`0 0 ${donutSize} ${donutSize}`}
                role="img"
                aria-label={t("Grade breakdown")}
              >
                <circle
                  cx={donutSize / 2}
                  cy={donutSize / 2}
                  r={donutR}
                  fill="none"
                  className="an2-donut-track"
                  strokeWidth={18}
                />
                {gradeTiers.map((tier) => {
                  const len = (tier.count / totalDist) * donutC;
                  const dash = `${len} ${donutC - len}`;
                  const offset = -accOffset;
                  accOffset += len;
                  if (tier.count <= 0) return null;
                  return (
                    <circle
                      key={tier.key}
                      cx={donutSize / 2}
                      cy={donutSize / 2}
                      r={donutR}
                      fill="none"
                      stroke={tier.color}
                      strokeWidth={18}
                      strokeDasharray={dash}
                      strokeDashoffset={offset}
                      transform={`rotate(-90 ${donutSize / 2} ${donutSize / 2})`}
                    />
                  );
                })}
                <text
                  x={donutSize / 2}
                  y={donutSize / 2 - 4}
                  textAnchor="middle"
                  className="an2-donut-big"
                >
                  {Math.round(data.passRate)}%
                </text>
                <text
                  x={donutSize / 2}
                  y={donutSize / 2 + 14}
                  textAnchor="middle"
                  className="an2-donut-sub"
                >
                  {t("Passed")}
                </text>
              </svg>
            </div>

            <div className="an2-tier-list">
              {gradeTiers.map((tier) => (
                <div key={tier.key} className="an2-tier-row">
                  <span className="an2-tier-dot" style={{ background: tier.color }} />
                  <div className="an2-tier-meta">
                    <b>{tier.label}</b>
                    <small>{tier.range}</small>
                  </div>
                  <div className="an2-tier-val">
                    <b>{tier.count}</b>
                    <small>{tier.pct}%</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* Row 2: Signature Educator Diagram — Interactive Question Calibration Map */}
      {indexedQuestions.length > 0 && (
        <section className="an2-card">
          <div className="an2-card-head wrap">
            <div>
              <h3>{t("Question calibration map")}</h3>
              <p className="subtle">
                {t("Intended difficulty vs. actual % correct — click any question dot to inspect its answers below")}
              </p>
            </div>
            <div className="an2-legend">
              <span><i className="an2-dot-key ok" />{t("Healthy")}</span>
              <span><i className="an2-dot-key flag" />{t("Needs review")}</span>
            </div>
          </div>

          <div className="an2-svg-wrap">
            <svg
              viewBox={`0 0 ${calW} ${calH}`}
              className="an2-svg"
              role="img"
              aria-label={t("Question calibration map")}
            >
              {/* Review zone highlight on left */}
              <rect
                x={cPadL}
                y={cPadT}
                width={reviewZoneW}
                height={cPlotH}
                rx={6}
                className="an2-review-zone"
              />
              <text x={cPadL + 8} y={cPadT + 14} className="an2-zone-lbl">
                {t("Review zone (<{0}% correct)", { "0": reviewZonePct })}
              </text>

              {/* Vertical percentage gridlines */}
              {[0, 25, 50, 75, 100].map((pct) => {
                const x = cPadL + cInnerPad + (pct / 100) * cDotSpanW;
                return (
                  <g key={pct}>
                    <line
                      x1={x}
                      x2={x}
                      y1={cPadT}
                      y2={cPadT + cPlotH}
                      className="an2-gridline"
                    />
                    <text
                      x={x}
                      y={calH - 10}
                      textAnchor="middle"
                      className="an2-axis-lbl"
                    >
                      {pct}%
                    </text>
                  </g>
                );
              })}

              {/* 3 difficulty lanes */}
              {lanes.map((lane) => (
                <g key={lane.key}>
                  <line
                    x1={cPadL}
                    x2={calW - cPadR}
                    y1={lane.y}
                    y2={lane.y}
                    className="an2-lane-line"
                  />
                  <text
                    x={cPadL - 12}
                    y={lane.y + 4}
                    textAnchor="end"
                    className="an2-lane-lbl"
                  >
                    {lane.label}
                  </text>
                </g>
              ))}

              {/* Interactive question dots */}
              {calDots.map(({ q, cx, cy, flagged }) => {
                const isSelected = selectedQ === q.questionId || openQ === q.questionId;
                const isHover = hoverDot === q.questionId;
                return (
                  <g
                    key={q.questionId}
                    className="an2-cal-dot-g"
                    onClick={() => jumpToQuestion(q.questionId)}
                    onMouseEnter={() => setHoverDot(q.questionId)}
                    onMouseLeave={() => setHoverDot(null)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        jumpToQuestion(q.questionId);
                      }
                    }}
                  >
                    {(isSelected || isHover) && (
                      <circle
                        cx={cx}
                        cy={cy}
                        r={16}
                        className={`an2-cal-ring ${flagged ? "flag" : "ok"}`}
                      />
                    )}
                    <circle
                      cx={cx}
                      cy={cy}
                      r={11.5}
                      className={`an2-cal-dot ${flagged ? "flag" : "ok"} ${isSelected ? "selected" : ""}`}
                    />
                    <text
                      x={cx}
                      y={cy + 3.5}
                      textAnchor="middle"
                      className="an2-cal-code"
                    >
                      {q.code}
                    </text>
                  </g>
                );
              })}
            </svg>

            {hoverDot && (() => {
              const found = indexedQuestions.find((q) => q.questionId === hoverDot);
              if (!found) return null;
              return (
                <div className="an2-tooltip">
                  <b>
                    {found.code} · {found.pctCorrect}% {t("correct")} ({found.pctWrong}% {t("wrong")})
                  </b>
                  <span>{questionDisplayText(found, t).slice(0, 90)}</span>
                </div>
              );
            })()}
          </div>
        </section>
      )}

      {/* Row 3: Question Performance Review Table (Calm Short Flags) */}
      <section className="an2-card" id="an-question-analysis">
        <div className="an2-card-head wrap">
          <div>
            <h3>{t("Questions review")}</h3>
            <p className="subtle">
              {t("Click any row to inspect how students answered each choice.")}
            </p>
          </div>
          <div className="an-threshold-picker">
            <span className="subtle">{t("Flag ≥")}:</span>
            {[40, 50, 60].map((v) => (
              <button
                key={v}
                type="button"
                className={`an2-thr-chip ${wrongThreshold === v ? "on" : ""}`}
                onClick={() => setWrongThreshold(v)}
              >
                {v}% {t("wrong")}
              </button>
            ))}
          </div>
        </div>

        <div className="an-q-controls">
          <div className="an-filter-tabs" role="tablist">
            <button
              type="button"
              className={qFilter === "all" ? "on" : ""}
              onClick={() => setQFilter("all")}
            >
              {t("All")} ({indexedQuestions.length})
            </button>
            <button
              type="button"
              className={qFilter === "flagged" ? "on flag-soft" : ""}
              onClick={() => setQFilter("flagged")}
            >
              <Flag size={12} />
              {t("Flagged")} ({flaggedQuestions.length})
            </button>
            <button
              type="button"
              className={qFilter === "distractor" ? "on" : ""}
              onClick={() => setQFilter("distractor")}
            >
              {t("Check answer key")} (
              {indexedQuestions.filter((q) => q.distractorBeatKey).length})
            </button>
          </div>

          <label className="an-sort-row">
            <span className="subtle">{t("Sort by")}:</span>
            <select
              value={qSort}
              onChange={(e) => setQSort(e.target.value as "worst" | "best" | "flags")}
            >
              <option value="worst">{t("Most wrong first")}</option>
              <option value="best">{t("Most correct first")}</option>
              <option value="flags">{t("Most student flags")}</option>
            </select>
          </label>
        </div>

        {!visibleQuestions.length ? (
          <div className="an-empty-inline">
            <CheckCircle2 size={18} />
            <span>{t("No questions match this filter.")}</span>
          </div>
        ) : (
          <div className="an2-q-table">
            {visibleQuestions.map((q) => {
              const flagged = isFlaggedByRule(q);
              const isOpen = openQ === q.questionId;
              const isHighlighted = selectedQ === q.questionId;
              const quality = plainQuality(q, t);
              const barTone = q.pctCorrect >= 70 ? "good" : q.pctCorrect >= 50 ? "warn" : "bad";
              const flagLabel = q.distractorBeatKey
                ? t("Check key")
                : `${q.pctWrong}% ${t("wrong")}`;

              return (
                <div
                  key={q.questionId}
                  id={`an-q-row-${q.questionId}`}
                  className={`an2-q-row ${flagged ? "is-flagged" : ""} ${isHighlighted ? "is-selected" : ""}`}
                >
                  <button
                    type="button"
                    className="an2-q-summary"
                    onClick={() => {
                      setSelectedQ(q.questionId);
                      setOpenQ(isOpen ? null : q.questionId);
                    }}
                    aria-expanded={isOpen}
                  >
                    <span className={`an2-q-code ${flagged ? "flag" : ""}`}>{q.code}</span>

                    <div className="an2-q-copy">
                      <div className="an2-q-text" dir="auto">{questionDisplayText(q, t)}</div>
                      <div className="an2-q-meta">
                        <span className="an2-meta-chip">{questionTypeLabel(q.type, t)}</span>
                        <span className="an2-meta-chip">{t(label(q.difficulty))}</span>
                        <span>{q.grade} {t("marks")}</span>
                        {q.mediaType === "audio" && (
                          <span className="an2-meta-chip media"><Volume2 size={11} /> {t("Voice")}</span>
                        )}
                        {q.mediaType === "video" && (
                          <span className="an2-meta-chip media"><Video size={11} /> {t("Video")}</span>
                        )}
                        {q.imageUrl && (
                          <span className="an2-meta-chip media"><ImageIcon size={11} /> {t("Image")}</span>
                        )}
                        {q.flagged > 0 && (
                          <span className="an2-meta-muted">
                            <Flag size={11} /> {q.flagged}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="an2-q-status">
                      {flagged ? (
                        <span className="an2-flag-pill">
                          <AlertCircle size={12} />
                          {flagLabel}
                        </span>
                      ) : (
                        <span className="an2-ok-pill">{t("OK")}</span>
                      )}
                    </div>

                    <div className="an2-q-acc">
                      <div className="an2-q-acc-top">
                        <strong className={`an-pct ${barTone}`}>{q.pctCorrect}%</strong>
                        <small>{q.correct}/{q.attempts}</small>
                      </div>
                      <div className="an-bar-track sm">
                        <span className={`an-bar-fill ${barTone}`} style={{ width: `${q.pctCorrect}%` }} />
                      </div>
                    </div>

                    <span className="an-chevron">
                      {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="an-q-body">
                      {q.imageUrl && (
                        <img
                          src={apiUrl(q.imageUrl)}
                          alt={t("Question image")}
                          className="question-img"
                          style={{ maxHeight: 220, borderRadius: 8, objectFit: "contain" }}
                        />
                      )}
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
                          {q.options.map((opt) => {
                            const isTopWrong =
                              !opt.isCorrect &&
                              q.mostCommonWrongOption?.label === opt.label &&
                              opt.picks > 0;
                            return (
                              <div
                                key={opt.label}
                                className={`an-opt-row ${
                                  opt.isCorrect ? "is-key" : isTopWrong ? "is-top-wrong" : ""
                                }`}
                              >
                                <div className="an-opt-label">
                                  <span>{opt.label}</span>
                                  {opt.isCorrect && (
                                    <span className="an-opt-tag key">
                                      <CheckCircle2 size={11} /> {t("Correct")}
                                    </span>
                                  )}
                                  {isTopWrong && (
                                    <span className="an-opt-tag wrong">{t("Top wrong")}</span>
                                  )}
                                </div>
                                <div className="an-opt-bar-wrap">
                                  <div className="an-bar-track sm">
                                    <span
                                      className={`an-bar-fill ${
                                        opt.isCorrect ? "good" : isTopWrong ? "warn" : "neutral"
                                      }`}
                                      style={{ width: `${opt.pct}%` }}
                                    />
                                  </div>
                                  <span className="an-opt-count">
                                    <b>{opt.pct}%</b> ({opt.picks})
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
                          <b>{q.avgAward} / {q.grade}</b>
                        </div>
                        <div className="an-metric-pill">
                          <small>{t("Quality")}</small>
                          <b className={`an-pct ${quality.tone}`}>{quality.text}</b>
                        </div>
                        <div className="an-metric-pill">
                          <small>{t("Full-credit lift")}</small>
                          <b>
                            {q.voidPassDelta > 0
                              ? t("+{0} students would pass", { "0": q.voidPassDelta })
                              : t("No change to pass count")}
                          </b>
                        </div>
                      </div>

                      {canCompensate && onJumpToAdjustments && (
                        <div className="an-q-footer-cta">
                          <button type="button" className="secondary" onClick={onJumpToAdjustments}>
                            {t("Adjust grade")}
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
      </section>

      {/* Row 4: Time Spent vs Score Scatter + Sections vs Class Average */}
      <div className={`an2-row-bottom ${data.sections.length === 0 ? "single" : ""}`}>
        <section className="an2-card">
          <div className="an2-card-head wrap">
            <div>
              <h3>{t("Time spent vs. score")}</h3>
              <p className="subtle">
                {t("Spot rushing (left) or time pressure (right) across all submitted attempts")}
              </p>
            </div>
            {scatterPts.length > 0 && (
              <div className="an2-legend">
                <span><i className="an2-dot-key ok" />{t("Passing")}</span>
                <span><i className="an2-dot-key flag" />{t("Below pass")}</span>
              </div>
            )}
          </div>

          {scatterPts.length > 0 ? (
            <div className="an2-svg-wrap">
              <svg
                viewBox={`0 0 ${scW} ${scH}`}
                className="an2-svg"
                role="img"
                aria-label={t("Time spent vs. score")}
              >
                {[0, 25, 50, 75, 100].map((scoreTick) => {
                  const y = sPadT + sPlotH * (1 - scoreTick / 100);
                  return (
                    <g key={scoreTick}>
                      <line x1={sPadL} x2={scW - sPadR} y1={y} y2={y} className="an2-gridline" />
                      <text x={sPadL - 7} y={y + 3.5} textAnchor="end" className="an2-axis-lbl">
                        {scoreTick}%
                      </text>
                    </g>
                  );
                })}
                {[0, 0.25, 0.5, 0.75, 1].map((frac, idx) => {
                  const x = sPadL + frac * sPlotW;
                  const minVal = Math.round(maxMins * frac);
                  return (
                    <text
                      key={idx}
                      x={x}
                      y={scH - 8}
                      textAnchor="middle"
                      className="an2-axis-lbl"
                    >
                      {minVal}m
                    </text>
                  );
                })}

                {/* 60% Pass line */}
                <line x1={sPadL} x2={scW - sPadR} y1={passY} y2={passY} className="an2-ref-pass" />
                <text x={scW - sPadR - 4} y={passY - 5} textAnchor="end" className="an2-ref-lbl pass">
                  {t("60% Pass")}
                </text>

                {/* 25% Rush line */}
                <line x1={rushX} x2={rushX} y1={sPadT} y2={sPadT + sPlotH} className="an2-ref-rush" />

                {/* Anonymous student points */}
                {scatterPts.map((pt, idx) => {
                  const cx = sPadL + Math.min(1, pt.minutes / maxMins) * sPlotW;
                  const cy = sPadT + (1 - Math.min(100, Math.max(0, pt.score)) / 100) * sPlotH;
                  const passed = pt.score >= 60;
                  return (
                    <circle
                      key={idx}
                      cx={cx}
                      cy={cy}
                      r={hoverScatter === idx ? 6.5 : 4.5}
                      className={`an2-sc-dot ${passed ? "pass" : "fail"}`}
                      onMouseEnter={() => setHoverScatter(idx)}
                      onMouseLeave={() => setHoverScatter(null)}
                    />
                  );
                })}
              </svg>

              {hoverScatter !== null && scatterPts[hoverScatter] && (
                <div className="an2-tooltip">
                  <b>{scatterPts[hoverScatter].score}%</b>
                  <span>
                    {Math.round(scatterPts[hoverScatter].minutes)} {t("min")}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="an2-bucket-list">
              {(data.timeBuckets ?? []).map((tb) => {
                const tbAvg = tb.n ? Math.round(tb.avg) : 0;
                return (
                  <div key={tb.key} className="an2-sec-row">
                    <div className="an2-sec-head">
                      <div>
                        <b>{t(tb.label)}</b>
                        <small>{tb.n} {t("students")}</small>
                      </div>
                      <span className="an2-sec-score">
                        <b>{tb.n ? `${tbAvg}%` : "—"}</b>
                      </span>
                    </div>
                    <div className="an2-sec-track">
                      {tb.n > 0 && (
                        <span
                          className={`an2-sec-fill ${tbAvg >= 60 ? "ok" : "warn"}`}
                          style={{ width: `${Math.min(100, Math.max(3, tbAvg))}%` }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="an2-mini-stats">
            <div>
              <Clock size={13} />
              <span>{t("Avg time")}:</span>
              <b>{Math.round(data.avgMinutesUsed)}m{data.durationMinutes ? ` / ${data.durationMinutes}m` : ""}</b>
            </div>
            <div>
              <span>{t("Finished fast")}:</span>
              <b>{data.rushSubmits}</b>
            </div>
            <div>
              <span>{t("Auto-submitted")}:</span>
              <b>{data.autoSubmitted}</b>
            </div>
            <div>
              <span>{t("Re-entered")}:</span>
              <b>{data.reentry.multi.n}</b>
            </div>
          </div>
        </section>

        {/* Sections vs Class Average Benchmark */}
        {data.sections.length > 0 && (
          <section className="an2-card">
            <div className="an2-card-head">
              <div>
                <h3>{t("Sections vs. class average")}</h3>
                <p className="subtle">
                  {t("Dashed line marks the overall class average ({0}%)", { "0": avg })}
                </p>
              </div>
              <span className="an2-avg-badge">
                <Sparkles size={12} /> {t("Avg")} {avg}%
              </span>
            </div>

            <div className="an2-sec-list">
              {data.sections.map((s) => {
                const sAvg = Math.round(s.avg);
                const diff = sAvg - avg;
                const belowAvg = diff <= -6;
                return (
                  <div key={s.sectionId} className="an2-sec-row">
                    <div className="an2-sec-head">
                      <div>
                        <b>{s.name}</b>
                        <small>
                          {s.n} {t("students")} · {Math.round(s.passRate)}% {t("pass")}
                        </small>
                      </div>
                      <span className={`an2-sec-score ${belowAvg ? "warn" : ""}`}>
                        <b>{sAvg}%</b>
                        <small>{diff >= 0 ? `+${diff}` : diff}</small>
                      </span>
                    </div>
                    <div className="an2-sec-track">
                      <span
                        className={`an2-sec-fill ${belowAvg ? "warn" : "ok"}`}
                        style={{ width: `${Math.min(100, Math.max(2, sAvg))}%` }}
                      />
                      <span
                        className="an2-sec-bench"
                        style={{ insetInlineStart: `${Math.min(100, Math.max(0, avg))}%` }}
                        title={`${t("Class average")}: ${avg}%`}
                      />
                    </div>
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
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
