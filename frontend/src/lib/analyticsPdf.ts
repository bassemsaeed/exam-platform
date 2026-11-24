import type { ExamAnalyticsData, AnalyticsQuestion } from "../components/ExamAnalytics";
import { questionDisplayText } from "../components/QuestionMedia";
import { questionTypeLabel } from "../components/QuestionTypesUI";
import { label } from "./platform";

function escHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function exportAnalyticsPdf({
  data,
  examTitle,
  wrongThreshold,
  language,
  t,
}: {
  data: ExamAnalyticsData;
  examTitle: string;
  wrongThreshold: number;
  language: "en" | "ar";
  t: (text: string, params?: Record<string, string | number | null | undefined>) => string;
}) {
  const isRtl = language === "ar";
  const dir = isRtl ? "rtl" : "ltr";
  const localeStr = isRtl ? "ar-EG" : "en-US";
  const generatedAt = new Intl.DateTimeFormat(localeStr, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());

  const isFlagged = (q: AnalyticsQuestion) =>
    q.pctWrong >= wrongThreshold ||
    q.distractorBeatKey ||
    (q.discriminationIndex !== null && q.discriminationIndex < 0);

  const flagged = data.questions.filter(isFlagged);
  const maxDist = Math.max(1, ...data.distribution);

  const qualityText = (q: AnalyticsQuestion) => {
    if (q.distractorBeatKey) return t("Wrong choice beat right answer");
    if (q.discriminationIndex !== null && q.discriminationIndex < 0) return t("Confusing wording");
    if (q.pctWrong >= wrongThreshold) return t("Most students missed it");
    if (q.discriminationIndex !== null && q.discriminationIndex < 0.15) return t("Check wording");
    return t("Healthy");
  };

  const distBarsHtml = data.distribution
    .map((n, i) => {
      const h = n > 0 ? Math.max(10, Math.round((n / maxDist) * 100)) : 3;
      const cls = i >= 6 ? "pass" : "fail";
      return `
        <div class="bar-col ${i === 6 ? "pass-line" : ""}">
          <div class="bar-num">${n}</div>
          <div class="bar-track">
            <div class="bar-fill ${cls} ${n === 0 ? "empty" : ""}" style="height:${h}%"></div>
          </div>
          <div class="bar-lbl">${i * 10}%</div>
        </div>
      `;
    })
    .join("");

  const diffRowsHtml = (data.difficultyBreakdown ?? [])
    .map(
      (d) => `
      <tr>
        <td><b>${escHtml(t(label(d.difficulty)))}</b></td>
        <td>${d.questionCount}</td>
        <td>${d.correct} / ${d.attempts}</td>
        <td>
          <div class="inline-bar">
            <div class="inline-track"><div class="inline-fill ${d.pctCorrect < 45 ? "bad" : d.pctCorrect < 65 ? "warn" : "good"}" style="width:${d.pctCorrect}%"></div></div>
            <b>${d.pctCorrect}%</b>
          </div>
        </td>
      </tr>`,
    )
    .join("");

  const sectionRowsHtml = data.sections
    .map(
      (s) => `
      <tr>
        <td><b>${escHtml(s.name)}</b></td>
        <td>${s.n}</td>
        <td><b>${Math.round(s.avg)}%</b></td>
        <td>${Math.round(s.passRate)}%</td>
      </tr>`,
    )
    .join("");

  const flaggedRowsHtml = flagged
    .map(
      (q, idx) => `
      <tr class="row-flagged">
        <td>${idx + 1}</td>
        <td>
          <b>${escHtml(questionDisplayText(q, t))}</b>
          <div class="cell-sub">${escHtml(questionTypeLabel(q.type, t))} · ${escHtml(t(label(q.difficulty)))}</div>
        </td>
        <td class="num bad"><b>${q.pctWrong}%</b></td>
        <td class="num">${q.correct} / ${q.attempts}</td>
        <td>${q.mostCommonWrongOption ? `${escHtml(q.mostCommonWrongOption.label)} (${q.mostCommonWrongOption.pct}%)` : "—"}</td>
        <td><span class="pill bad">${escHtml(qualityText(q))}</span></td>
      </tr>`,
    )
    .join("");

  const allQuestionsHtml = data.questions
    .map((q, idx) => {
      const fl = isFlagged(q);
      const tone = q.pctCorrect < 40 ? "bad" : q.pctCorrect < 60 ? "warn" : "good";
      return `
      <tr class="${fl ? "row-flagged" : ""}">
        <td>${idx + 1}</td>
        <td>
          <b>${escHtml(questionDisplayText(q, t))}</b>
          <div class="cell-sub">${escHtml(questionTypeLabel(q.type, t))} · ${escHtml(t(label(q.difficulty)))} · ${q.grade} ${escHtml(t("marks"))}</div>
        </td>
        <td class="num"><span class="pill ${tone}">${q.pctCorrect}%</span></td>
        <td class="num">${q.pctWrong}%</td>
        <td class="num">${q.correct} / ${q.wrong} / ${q.skipped}</td>
        <td class="num">${q.avgAward} / ${q.grade}</td>
        <td>${fl ? `<span class="pill bad">${escHtml(t("Needs review"))}</span>` : `<span class="pill good">${escHtml(t("Good"))}</span>`}</td>
      </tr>`;
    })
    .join("");

  const html = `<!doctype html>
<html lang="${language}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <title>${escHtml(examTitle)} — ${escHtml(t("Assessment Analytics Report"))}</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+Arabic:wght@400;500;600;700&display=swap");
    @page { size: A4; margin: 14mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body {
      margin: 0;
      font-family: ${isRtl ? '"Noto Sans Arabic", Inter, Arial, sans-serif' : 'Inter, "Noto Sans Arabic", Arial, sans-serif'};
      color: #163349;
      background: #ffffff;
      font-size: 11.5px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      padding: 16px 20px;
      border-radius: 10px;
      background: #103e60;
      color: #ffffff;
      margin-bottom: 16px;
    }
    .header h1 { margin: 0 0 4px; font-size: 18px; font-weight: 700; }
    .header .sub { opacity: 0.85; font-size: 11px; }
    .header .meta { text-align: end; font-size: 10.5px; opacity: 0.9; white-space: nowrap; }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 16px;
    }
    .kpi {
      border: 1px solid #d7e3ee;
      border-radius: 8px;
      padding: 11px 13px;
      background: #f8fbfd;
      break-inside: avoid;
    }
    .kpi.alert { border-color: #f3c2c2; background: #fff7f7; }
    .kpi small { display: block; color: #5f7a8f; font-size: 10px; font-weight: 600; }
    .kpi strong { display: block; font-size: 20px; color: #103e60; margin: 4px 0 2px; }
    .kpi.alert strong { color: #b91c1c; }
    .kpi span { font-size: 10px; color: #6e8699; }
    .section {
      margin-bottom: 16px;
      break-inside: avoid;
    }
    .section-wide { margin-bottom: 16px; }
    h2 {
      font-size: 13.5px;
      font-weight: 700;
      color: #103e60;
      margin: 0 0 8px;
      padding-bottom: 5px;
      border-bottom: 1.5px solid #e3edf5;
    }
    .alert-box {
      padding: 10px 14px;
      border-radius: 8px;
      background: #fff5f5;
      border: 1px solid #f5c2c2;
      border-inline-start: 4px solid #dc2626;
      color: #8f1d1d;
      margin-bottom: 12px;
      font-size: 11px;
    }
    .two-col {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 14px;
      margin-bottom: 16px;
    }
    .box {
      border: 1px solid #dfe9f2;
      border-radius: 8px;
      padding: 12px 14px;
      background: #ffffff;
      break-inside: avoid;
    }
    .hist {
      display: flex;
      align-items: flex-end;
      gap: 5px;
      height: 115px;
      padding: 8px 4px 2px;
    }
    .bar-col {
      flex: 1;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
    }
    .bar-col.pass-line {
      border-inline-start: 1.5px dashed #16a34a;
      padding-inline-start: 4px;
    }
    .bar-num { font-size: 9.5px; font-weight: 600; color: #355870; }
    .bar-track { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; }
    .bar-fill { width: 100%; max-width: 24px; border-radius: 3px 3px 1px 1px; }
    .bar-fill.pass { background: #0a4d7b; }
    .bar-fill.fail { background: #e06b58; }
    .bar-fill.empty { background: #e3edf5; }
    .bar-lbl { font-size: 8.5px; color: #758ea1; }
    table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
    th {
      text-align: start;
      background: #f2f7fb;
      color: #355870;
      font-weight: 600;
      padding: 7px 8px;
      border-bottom: 1px solid #d7e3ee;
    }
    td {
      padding: 7px 8px;
      border-bottom: 1px solid #ebf1f6;
      vertical-align: top;
    }
    tr { break-inside: avoid; }
    tr.row-flagged td { background: #fff9f9; }
    .num { text-align: center; white-space: nowrap; }
    .cell-sub { font-size: 9.5px; color: #6c8497; margin-top: 2px; }
    .pill {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 9.5px;
      font-weight: 600;
      white-space: nowrap;
    }
    .pill.good { background: #e7f7ee; color: #166534; }
    .pill.warn { background: #fff4de; color: #9a5206; }
    .pill.bad { background: #fee2e2; color: #b91c1c; }
    .bad { color: #b91c1c; }
    .inline-bar { display: flex; align-items: center; gap: 6px; }
    .inline-track { flex: 1; height: 6px; border-radius: 999px; background: #e5eef5; overflow: hidden; min-width: 50px; }
    .inline-fill { height: 100%; border-radius: 999px; }
    .inline-fill.good { background: #16a34a; }
    .inline-fill.warn { background: #d97706; }
    .inline-fill.bad { background: #dc2626; }
    .footer {
      margin-top: 14px;
      padding-top: 8px;
      border-top: 1px solid #e3edf5;
      display: flex;
      justify-content: space-between;
      font-size: 9.5px;
      color: #7890a3;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${escHtml(examTitle)}</h1>
      <div class="sub">${escHtml(t("Assessment Analytics Report"))}</div>
    </div>
    <div class="meta">
      <div>${escHtml(generatedAt)}</div>
      <div>${escHtml(t("{0} graded attempts", { "0": data.submitted }))}</div>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi">
      <small>${escHtml(t("Students finished"))}</small>
      <strong>${data.submitted}${data.assigned !== null ? ` / ${data.assigned}` : ""}</strong>
      <span>${data.completionRate != null ? `${data.completionRate}% ${escHtml(t("completed"))}` : `${data.started} ${escHtml(t("started"))}`}${data.absent ? ` · ${data.absent} ${escHtml(t("absent"))}` : ""}</span>
    </div>
    <div class="kpi">
      <small>${escHtml(t("Average score"))}</small>
      <strong>${Math.round(data.avg)}%</strong>
      <span>${escHtml(t("Middle score"))} ${Math.round(data.median)}% · ${Math.round(data.low)}–${Math.round(data.high)}%</span>
    </div>
    <div class="kpi">
      <small>${escHtml(t("Pass rate (≥60%)"))}</small>
      <strong>${Math.round(data.passRate)}%</strong>
      <span>${data.passCount} ${escHtml(t("passed"))} · ${Math.max(0, data.submitted - data.passCount)} ${escHtml(t("did not pass"))}</span>
    </div>
    <div class="kpi ${flagged.length > 0 ? "alert" : ""}">
      <small>${escHtml(t("Questions needing review"))}</small>
      <strong>${flagged.length} / ${data.questions.length}</strong>
      <span>${escHtml(t("Answered wrong by ≥{0}%", { "0": wrongThreshold }))}</span>
    </div>
  </div>

  ${
    flagged.length > 0
      ? `
    <div class="section-wide">
      <h2>${escHtml(t("Flagged questions (answered wrong by many students)"))}</h2>
      <div class="alert-box">
        ${escHtml(t("{0} of {1} questions need review because ≥{2}% of students missed them or a wrong choice beat the right answer.", { "0": flagged.length, "1": data.questions.length, "2": wrongThreshold }))}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>${escHtml(t("Question"))}</th>
            <th class="num">${escHtml(t("Wrong %"))}</th>
            <th class="num">${escHtml(t("Correct"))}</th>
            <th>${escHtml(t("Most chosen wrong answer"))}</th>
            <th>${escHtml(t("Reason"))}</th>
          </tr>
        </thead>
        <tbody>${flaggedRowsHtml}</tbody>
      </table>
    </div>`
      : ""
  }

  <div class="two-col">
    <div class="box">
      <h2>${escHtml(t("Score distribution"))}</h2>
      <div class="hist">${distBarsHtml}</div>
    </div>
    <div class="box">
      <h2>${escHtml(t("Performance by difficulty"))}</h2>
      ${
        diffRowsHtml
          ? `<table>
              <thead>
                <tr>
                  <th>${escHtml(t("Difficulty"))}</th>
                  <th>${escHtml(t("Questions"))}</th>
                  <th>${escHtml(t("Correct"))}</th>
                  <th>${escHtml(t("Accuracy"))}</th>
                </tr>
              </thead>
              <tbody>${diffRowsHtml}</tbody>
            </table>`
          : `<p class="cell-sub">—</p>`
      }
    </div>
  </div>

  ${
    data.sections.length > 0
      ? `
    <div class="section">
      <h2>${escHtml(t("Sections compared"))}</h2>
      <table>
        <thead>
          <tr>
            <th>${escHtml(t("Section"))}</th>
            <th>${escHtml(t("Students"))}</th>
            <th>${escHtml(t("Average score"))}</th>
            <th>${escHtml(t("Pass rate"))}</th>
          </tr>
        </thead>
        <tbody>${sectionRowsHtml}</tbody>
      </table>
    </div>`
      : ""
  }

  <div class="section-wide">
    <h2>${escHtml(t("All questions breakdown"))}</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>${escHtml(t("Question"))}</th>
          <th class="num">${escHtml(t("Correct %"))}</th>
          <th class="num">${escHtml(t("Wrong %"))}</th>
          <th class="num">${escHtml(t("Right / Wrong / Skipped"))}</th>
          <th class="num">${escHtml(t("Avg marks"))}</th>
          <th>${escHtml(t("Status"))}</th>
        </tr>
      </thead>
      <tbody>${allQuestionsHtml}</tbody>
    </table>
  </div>

  <div class="footer">
    <span>${escHtml(t("O6U Examination Portal"))} · ${escHtml(t("Assessment Analytics Report"))}</span>
    <span>${escHtml(t("Avg time used"))}: ${Math.round(data.avgMinutesUsed)} ${escHtml(t("min"))} · ${escHtml(t("Auto-submitted"))}: ${data.autoSubmitted}</span>
  </div>
</body>
</html>`;

  // Render into a hidden same-origin iframe so popup blockers never interfere
  // and the browser's native PDF/print engine shapes Arabic & RTL cleanly.
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    document.body.removeChild(iframe);
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();

  const cleanup = () => {
    setTimeout(() => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 1000);
  };

  const triggerPrint = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } finally {
      cleanup();
    }
  };

  // Wait briefly for web fonts/layout to settle before opening the PDF print dialog.
  const fontsReady = (doc as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
  if (fontsReady) {
    void Promise.race([fontsReady, new Promise((r) => setTimeout(r, 700))]).then(triggerPrint);
  } else {
    setTimeout(triggerPrint, 300);
  }
}
