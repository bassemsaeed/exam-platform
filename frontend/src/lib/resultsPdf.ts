import type { Entity } from "./platform";

export interface ResultsPdfMeta {
  title: string;
  type?: string;
  purpose?: string;
  startTime?: string;
  subjectCode?: string;
  subjectName?: string;
  termName?: string;
  doctorName?: string;
  creatorName?: string;
}

export interface ResultsPdfGroup {
  sectionName: string;
  taName?: string;
  taUsername?: string | null;
  total: number;
  filteredRows: Entity[];
}

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

export async function exportResultsPdf({
  meta,
  groups,
}: {
  meta: ResultsPdfMeta;
  groups: ResultsPdfGroup[];
  language?: "en" | "ar";
  t?: (text: string, params?: Record<string, string | number | null | undefined>) => string;
}) {
  const logoSrc = await loadLogoDataUrl();

  // Deduplicate students across sections while preserving order for clean 1 -> N numbering.
  const seen = new Set<string>();
  const students: Entity[] = [];
  for (const g of groups) {
    for (const r of g.filteredRows) {
      const key = String(r.id ?? r.username ?? Math.random());
      if (seen.has(key)) continue;
      seen.add(key);
      students.push(r);
    }
  }

  let presentCount = 0;
  let absentCount = 0;

  const rowsHtml = students
    .map((r, idx) => {
      const ex = (r.exam as Entity) ?? null;
      const st = String(ex?.status ?? "not_started");
      const isPresent =
        st === "submitted" || st === "auto_submitted" || st === "in_progress";
      if (isPresent) presentCount++;
      else absentCount++;

      const gradeNum = ex?.totalGrade != null ? Number(ex.totalGrade) : null;
      const marksNum = ex?.totalMarks != null ? Number(ex.totalMarks) : null;
      const gradeStr = !isPresent
        ? "—"
        : gradeNum != null && marksNum != null
          ? `${gradeNum} / ${marksNum}`
          : gradeNum != null
            ? String(gradeNum)
            : "—";

      const attendanceLabel = isPresent ? "حاضر" : "غائب";

      return `
        <tr>
          <td class="col-num">${idx + 1}</td>
          <td class="col-name">${escHtml(r.name ?? "")}</td>
          <td class="col-id"><bdi>${escHtml(r.username ?? "—")}</bdi></td>
          <td class="col-grade"><bdi>${escHtml(gradeStr)}</bdi></td>
          <td class="col-att ${isPresent ? "att-present" : "att-absent"}">${attendanceLabel}</td>
        </tr>`;
    })
    .join("");

  const examDateStr = meta.startTime
    ? new Intl.DateTimeFormat("ar-EG", { dateStyle: "long" }).format(
        new Date(meta.startTime),
      )
    : new Intl.DateTimeFormat("ar-EG", { dateStyle: "long" }).format(new Date());

  const subjectLine = [meta.subjectCode, meta.subjectName].filter(Boolean).join(" — ");
  const doctorDisplay = meta.doctorName || meta.creatorName || "—";

  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>كشف درجات — ${escHtml(meta.title)}</title>
  <style>
    @import url("https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400;500;600;700&display=swap");
    @page { size: A4 portrait; margin: 14mm 14mm 16mm; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    body {
      margin: 0;
      font-family: "Noto Sans Arabic", Tahoma, Arial, sans-serif;
      color: #111827;
      background: #ffffff;
      font-size: 12px;
      line-height: 1.55;
    }

    /* Classic official header: university info on right (RTL start), logo on left (RTL end) */
    .sheet-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      padding-bottom: 12px;
    }
    .uni-block {
      display: flex;
      flex-direction: column;
      gap: 2px;
      text-align: right;
    }
    .uni-name {
      margin: 0;
      font-size: 19px;
      font-weight: 700;
      color: #0f172a;
      letter-spacing: 0;
    }
    .uni-sub {
      font-size: 12.5px;
      font-weight: 500;
      color: #374151;
    }
    .logo-block {
      flex-shrink: 0;
    }
    .logo-block img {
      height: 58px;
      width: auto;
      max-width: 175px;
      object-fit: contain;
      display: block;
    }

    /* Crisp double horizontal divider */
    .double-rule {
      border-top: 2px solid #111827;
      border-bottom: 1px solid #111827;
      height: 5px;
      margin: 0 0 16px;
    }

    /* Clean exam metadata strip */
    .exam-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px 24px;
      margin-bottom: 16px;
      padding: 0 2px;
      font-size: 12px;
      color: #1f2937;
    }
    .exam-meta-col {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .exam-meta span.lbl {
      color: #4b5563;
      font-weight: 600;
      margin-left: 6px;
    }

    /* Clean classic bordered grades table */
    table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #374151;
      font-size: 12px;
    }
    thead {
      display: table-header-group;
    }
    th {
      background: #f3f4f6;
      color: #111827;
      font-weight: 700;
      text-align: center;
      padding: 8px 10px;
      border: 1px solid #374151;
    }
    th.col-name-h {
      text-align: right;
    }
    td {
      padding: 7px 10px;
      border: 1px solid #6b7280;
      vertical-align: middle;
      color: #111827;
    }
    tbody tr:nth-child(even) td {
      background: #fafafa;
    }
    tr {
      break-inside: avoid;
    }
    .col-num {
      width: 44px;
      text-align: center;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .col-name {
      text-align: right;
      font-weight: 500;
    }
    .col-id {
      width: 135px;
      text-align: center;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px;
      font-variant-numeric: tabular-nums;
    }
    .col-grade {
      width: 100px;
      text-align: center;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .col-att {
      width: 92px;
      text-align: center;
      font-weight: 600;
    }
    .att-present {
      color: #111827;
    }
    .att-absent {
      color: #6b7280;
    }
    .empty-row {
      text-align: center;
      padding: 22px;
      color: #6b7280;
    }

    /* Subtle totals & signature footer */
    .summary-line {
      margin-top: 12px;
      display: flex;
      justify-content: space-between;
      font-size: 11.5px;
      color: #374151;
      padding: 0 2px;
    }
    .sign-footer {
      margin-top: 32px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 32px;
      break-inside: avoid;
      padding-top: 8px;
    }
    .sign-item {
      font-size: 12px;
      color: #111827;
    }
    .sign-item b {
      font-weight: 700;
    }
    .sign-line {
      display: inline-block;
      width: 170px;
      border-bottom: 1px solid #374151;
      margin-right: 8px;
      vertical-align: -2px;
    }
    @media print {
      body { padding: 0; }
    }
  </style>
</head>
<body>
  <header class="sheet-header">
    <div class="uni-block">
      <h1 class="uni-name">جامعة 6 أكتوبر</h1>
      <div class="uni-sub">كشف درجات الامتحان</div>
    </div>
    <div class="logo-block">
      <img src="${escHtml(logoSrc)}" alt="شعار جامعة 6 أكتوبر" />
    </div>
  </header>

  <div class="double-rule" aria-hidden="true"></div>

  <section class="exam-meta">
    <div class="exam-meta-col">
      <div><span class="lbl">الامتحان:</span>${escHtml(meta.title)}</div>
      ${subjectLine ? `<div><span class="lbl">المقرر:</span>${escHtml(subjectLine)}</div>` : ""}
    </div>
    <div class="exam-meta-col">
      <div><span class="lbl">أستاذ المادة:</span>${escHtml(doctorDisplay)}</div>
      <div><span class="lbl">التاريخ:</span>${escHtml(examDateStr)}${meta.termName ? ` · ${escHtml(meta.termName)}` : ""}</div>
    </div>
  </section>

  <table>
    <thead>
      <tr>
        <th style="width:44px">م</th>
        <th class="col-name-h">اسم الطالب</th>
        <th style="width:135px">الرقم الجامعي</th>
        <th style="width:100px">الدرجة</th>
        <th style="width:92px">الحضور</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || `<tr><td colspan="5" class="empty-row">لا يوجد طلاب</td></tr>`}
    </tbody>
  </table>

  <div class="summary-line">
    <div>إجمالي الطلاب: <strong>${students.length}</strong> &nbsp;|&nbsp; حاضر: <strong>${presentCount}</strong> &nbsp;|&nbsp; غائب: <strong>${absentCount}</strong></div>
    <div>تاريخ الطباعة: ${escHtml(new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium" }).format(new Date()))}</div>
  </div>

  <footer class="sign-footer">
    <div class="sign-item"><b>أستاذ المادة:</b> ${escHtml(doctorDisplay)}</div>
    <div class="sign-item"><b>التوقيع:</b><span class="sign-line"></span></div>
  </footer>

  <script>
    window.addEventListener("load", () => {
      const imgs = Array.from(document.images);
      Promise.all(imgs.map((img) => img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r; })))
        .then(() => setTimeout(() => window.print(), 240));
    });
  </script>
</body>
</html>`;

  const w = window.open("", "_blank", "width=920,height=1080");
  if (!w) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(meta.title || "results").replace(/[^a-zA-Z0-9\u0600-\u06FF_-]+/g, "_")}-grades.html`;
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
