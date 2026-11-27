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

async function loadLogoDataUrl(): Promise<string> {
  const fallback = `${window.location.origin}/o6u-logo.png`;
  try {
    const res = await fetch("/o6u-logo.png");
    if (!res.ok) return fallback;
    const blob = await res.blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () =>
        resolve(typeof reader.result === "string" ? reader.result : fallback);
      reader.onerror = () => resolve(fallback);
      reader.readAsDataURL(blob);
    });
  } catch {
    return fallback;
  }
}

export async function exportAnalyticsPdf({
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
  const logoSrc = await loadLogoDataUrl();
  const generatedAt = new Intl.DateTimeFormat(localeStr, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());

  const isFlagged = (q: AnalyticsQuestion) =>
    q.pctWrong >= wrongThreshold ||
    q.distractorBeatKey ||
    (q.discriminationIndex !== null && q.discriminationIndex < 0);

  const indexed = data.questions.map((q, i) => ({ ...q, code: `Q${i + 1}` }));
  const flagged = indexed.filter(isFlagged);
  const maxDist = Math.max(1, ...data.distribution);
  const totalDist = Math.max(1, data.distribution.reduce((a, b) => a + b, 0));

  const d = data.distribution;
  const tiers = [
    { label: t("Excellent"), range: "90–100%", n: d[9] ?? 0, color: "#15803d" },
    { label: t("Very Good"), range: "80–89%", n: d[8] ?? 0, color: "#0a4d7b" },
    { label: t("Good"), range: "70–79%", n: d[7] ?? 0, color: "#2b86c5" },
    { label: t("Pass"), range: "60–69%", n: d[6] ?? 0, color: "#d97706" },
    {
      label: t("Below Pass"),
      range: "< 60%",
      n: (d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0) + (d[3] ?? 0) + (d[4] ?? 0) + (d[5] ?? 0),
      color: "#c2594b",
    },
  ];

  // Inline SVG Score Distribution Histogram for sharp vector print
  const svgW = 460;
  const svgH = 148;
  const pL = 28;
  const pR = 10;
  const pT = 18;
  const pB = 22;
  const pw = svgW - pL - pR;
  const ph = svgH - pT - pB;
  const bw = pw / 10;
  const passX = pL + pw * 0.6;
  const avgX = pL + pw * Math.min(1, Math.max(0, data.avg / 100));

  const histSvg = `
    <svg width="100%" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">
      ${[0, Math.ceil(maxDist / 2), maxDist]
        .map((tk) => {
          const y = pT + ph - (tk / maxDist) * ph;
          return `<line x1="${pL}" x2="${svgW - pR}" y1="${y}" y2="${y}" stroke="#e5edf4" stroke-width="1"/>
                  <text x="${pL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="#64748b">${tk}</text>`;
        })
        .join("")}
      ${data.distribution
        .map((n, i) => {
          const bh = n > 0 ? Math.max(3, (n / maxDist) * ph) : 0;
          const x = pL + i * bw + 4;
          const y = pT + ph - bh;
          const w = Math.max(8, bw - 8);
          const fill = i >= 6 ? "#0a4d7b" : "#c97a6d";
          return `
            ${n > 0 ? `<rect x="${x}" y="${y}" width="${w}" height="${bh}" rx="3" fill="${fill}"/>` : ""}
            ${n > 0 ? `<text x="${x + w / 2}" y="${y - 4}" text-anchor="middle" font-size="9" font-weight="600" fill="#1e293b">${n}</text>` : ""}
            <text x="${pL + i * bw + bw / 2}" y="${svgH - 6}" text-anchor="middle" font-size="8.5" fill="#64748b">${i * 10}%</text>
          `;
        })
        .join("")}
      <line x1="${passX}" x2="${passX}" y1="${pT - 4}" y2="${pT + ph}" stroke="#15803d" stroke-width="1.4" stroke-dasharray="4 3"/>
      <text x="${passX + 3}" y="${pT + 7}" font-size="8.5" font-weight="600" fill="#15803d">60%</text>
      <line x1="${avgX}" x2="${avgX}" y1="${pT - 4}" y2="${pT + ph}" stroke="#f58220" stroke-width="1.4" stroke-dasharray="3 3"/>
    </svg>`;

  const tierRowsHtml = tiers
    .map(
      (tr) => `
      <tr>
        <td><span class="dot" style="background:${tr.color}"></span><b>${escHtml(tr.label)}</b> <span class="muted">(${tr.range})</span></td>
        <td class="num"><b>${tr.n}</b></td>
        <td class="num">${Math.round((tr.n / totalDist) * 100)}%</td>
      </tr>`,
    )
    .join("");

  const sectionRowsHtml = data.sections
    .map(
      (s) => `
      <tr>
        <td><b>${escHtml(s.name)}</b></td>
        <td class="num">${s.n}</td>
        <td class="num"><b>${Math.round(s.avg)}%</b></td>
        <td class="num">${Math.round(s.passRate)}%</td>
      </tr>`,
    )
    .join("");

  const allQuestionsHtml = indexed
    .map((q) => {
      const fl = isFlagged(q);
      const tone = q.pctCorrect >= 70 ? "good" : q.pctCorrect >= 50 ? "warn" : "bad";
      const statusTxt = q.distractorBeatKey
        ? t("Check key")
        : fl
          ? `${q.pctWrong}% ${t("wrong")}`
          : t("OK");
      return `
      <tr>
        <td class="num"><b>${q.code}</b></td>
        <td>
          <b>${escHtml(questionDisplayText(q, t))}</b>
          <div class="cell-sub">${escHtml(questionTypeLabel(q.type, t))} · ${escHtml(t(label(q.difficulty)))} · ${q.grade} ${escHtml(t("marks"))}</div>
        </td>
        <td class="num"><span class="pill ${tone}">${q.pctCorrect}%</span></td>
        <td class="num">${q.correct} / ${q.attempts}</td>
        <td class="num">${q.avgAward} / ${q.grade}</td>
        <td class="num">${fl ? `<span class="pill flag">${escHtml(statusTxt)}</span>` : `<span class="pill ok">${escHtml(statusTxt)}</span>`}</td>
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
    @page { size: A4; margin: 13mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body {
      margin: 0;
      font-family: ${isRtl ? '"Noto Sans Arabic", Inter, Arial, sans-serif' : 'Inter, "Noto Sans Arabic", Arial, sans-serif'};
      color: #163349;
      background: #ffffff;
      font-size: 11px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 10px;
      border-bottom: 2px solid #103e60;
      margin-bottom: 14px;
    }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .header-logo { height: 42px; width: auto; object-fit: contain; }
    .header h1 { margin: 0 0 2px; font-size: 16px; font-weight: 700; color: #103e60; }
    .header .sub { color: #5f7a8f; font-size: 10.5px; }
    .header .meta { text-align: end; font-size: 10px; color: #5f7a8f; white-space: nowrap; }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 14px;
    }
    .kpi {
      border: 1px solid #d7e3ee;
      border-radius: 8px;
      padding: 10px 12px;
      background: #f8fbfd;
      break-inside: avoid;
    }
    .kpi small { display: block; color: #5f7a8f; font-size: 9.5px; font-weight: 600; }
    .kpi strong { display: block; font-size: 19px; color: #103e60; margin: 3px 0 2px; }
    .kpi span { font-size: 9.5px; color: #6e8699; }
    .two-col {
      display: grid;
      grid-template-columns: 1.35fr 0.85fr;
      gap: 12px;
      margin-bottom: 14px;
    }
    .box {
      border: 1px solid #dfe9f2;
      border-radius: 8px;
      padding: 11px 13px;
      background: #ffffff;
      break-inside: avoid;
    }
    h2 {
      font-size: 12.5px;
      font-weight: 700;
      color: #103e60;
      margin: 0 0 8px;
      padding-bottom: 5px;
      border-bottom: 1px solid #e6eff6;
    }
    .spread-note {
      margin-top: 6px;
      font-size: 9.5px;
      color: #5b768c;
      text-align: center;
    }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-inline-end: 6px; vertical-align: middle; }
    .muted { color: #6c8497; font-size: 9.5px; }
    table { width: 100%; border-collapse: collapse; font-size: 10px; }
    thead { display: table-header-group; }
    th {
      text-align: start;
      background: #f2f7fb;
      color: #355870;
      font-weight: 600;
      padding: 6.5px 8px;
      border-bottom: 1px solid #d7e3ee;
    }
    td {
      padding: 6.5px 8px;
      border-bottom: 1px solid #ebf1f6;
      vertical-align: middle;
    }
    tr { break-inside: avoid; }
    .num { text-align: center; white-space: nowrap; }
    .cell-sub { font-size: 9px; color: #6c8497; margin-top: 2px; }
    .pill {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 600;
      white-space: nowrap;
    }
    .pill.good, .pill.ok { background: #e8f6ee; color: #166534; }
    .pill.warn, .pill.flag { background: #fff4df; color: #9a5206; }
    .pill.bad { background: #fdecea; color: #9b2c2c; }
    .section { margin-bottom: 14px; }
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
    <div class="header-left">
      <img src="${escHtml(logoSrc)}" alt="O6U" class="header-logo" />
      <div>
        <h1>${escHtml(examTitle)}</h1>
        <div class="sub">${escHtml(t("Assessment Analytics Report"))}</div>
      </div>
    </div>
    <div class="meta">
      <div>${escHtml(generatedAt)}</div>
      <div>${escHtml(t("{0} graded attempts", { "0": data.submitted }))}</div>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi">
      <small>${escHtml(t("Attendance"))}</small>
      <strong>${data.submitted}${data.assigned !== null ? ` / ${data.assigned}` : ""}</strong>
      <span>${data.completionRate != null ? `${data.completionRate}% ${escHtml(t("completed"))}` : `${data.started} ${escHtml(t("started"))}`}${data.absent ? ` · ${data.absent} ${escHtml(t("absent"))}` : ""}</span>
    </div>
    <div class="kpi">
      <small>${escHtml(t("Class average"))}</small>
      <strong>${Math.round(data.avg)}%</strong>
      <span>${escHtml(t("Middle score"))} ${Math.round(data.median)}% · ${Math.round(data.low)}–${Math.round(data.high)}%</span>
    </div>
    <div class="kpi">
      <small>${escHtml(t("Pass rate (≥60%)"))}</small>
      <strong>${Math.round(data.passRate)}%</strong>
      <span>${data.passCount} ${escHtml(t("passed"))} · ${Math.max(0, data.submitted - data.passCount)} ${escHtml(t("did not pass"))}</span>
    </div>
    <div class="kpi">
      <small>${escHtml(t("Flagged questions"))}</small>
      <strong>${flagged.length} / ${data.questions.length}</strong>
      <span>${escHtml(t("≥{0}% wrong", { "0": wrongThreshold }))}</span>
    </div>
  </div>

  <div class="two-col">
    <div class="box">
      <h2>${escHtml(t("Score distribution & spread"))}</h2>
      ${histSvg}
      <div class="spread-note">
        ${escHtml(t("Low"))} ${Math.round(data.low)}% · Q1 ${Math.round(data.q1 ?? data.low)}% · ${escHtml(t("Median"))} ${Math.round(data.median)}% · Q3 ${Math.round(data.q3 ?? data.high)}% · ${escHtml(t("High"))} ${Math.round(data.high)}%
      </div>
    </div>
    <div class="box">
      <h2>${escHtml(t("Grade breakdown"))}</h2>
      <table>
        <thead>
          <tr>
            <th>${escHtml(t("Grade level"))}</th>
            <th class="num">${escHtml(t("Students"))}</th>
            <th class="num">%</th>
          </tr>
        </thead>
        <tbody>${tierRowsHtml}</tbody>
      </table>
    </div>
  </div>

  ${
    data.sections.length > 0
      ? `<div class="section box">
          <h2>${escHtml(t("Sections vs. class average"))}</h2>
          <table>
            <thead>
              <tr>
                <th>${escHtml(t("Section"))}</th>
                <th class="num">${escHtml(t("Students"))}</th>
                <th class="num">${escHtml(t("Average"))}</th>
                <th class="num">${escHtml(t("Pass rate (≥60%)"))}</th>
              </tr>
            </thead>
            <tbody>${sectionRowsHtml}</tbody>
          </table>
        </div>`
      : ""
  }

  <div class="section">
    <h2>${escHtml(t("Questions review"))}</h2>
    <table>
      <thead>
        <tr>
          <th class="num" style="width:42px">#</th>
          <th>${escHtml(t("Question"))}</th>
          <th class="num">${escHtml(t("Correct %"))}</th>
          <th class="num">${escHtml(t("Correct"))}</th>
          <th class="num">${escHtml(t("Avg marks"))}</th>
          <th class="num">${escHtml(t("Status"))}</th>
        </tr>
      </thead>
      <tbody>${allQuestionsHtml}</tbody>
    </table>
  </div>

  <div class="footer">
    <span>${escHtml(t("O6U Examination Portal"))}</span>
    <span>${escHtml(t("Avg time"))}: ${Math.round(data.avgMinutesUsed)}m · ${escHtml(t("Auto-submitted"))}: ${data.autoSubmitted}</span>
  </div>

  <script>
    window.addEventListener("load", () => {
      const imgs = Array.from(document.images);
      Promise.all(imgs.map((img) => img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r; })))
        .then(() => setTimeout(() => window.print(), 220));
    });
  </script>
</body>
</html>`;

  const w = window.open("", "_blank", "width=980,height=920");
  if (!w) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(examTitle || "exam").replace(/[^a-zA-Z0-9_-]+/g, "_")}-analytics.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
