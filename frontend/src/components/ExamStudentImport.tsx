import { useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Upload,
  UserCheck,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { apiUrl } from "../lib/seb";
import { Feedback } from "./ui";

export interface ImportedStudent {
  line: number;
  id: string;
  username: string | null;
  name: string;
  email: string;
  enrolled: boolean;
  sectionNames: string[];
  inMySections: boolean;
  warnings: string[];
}

export interface StudentImportReport {
  filename: string;
  sheetName: string;
  detectedColumns: string[];
  totalRows: number;
  validCount: number;
  errorCount: number;
  duplicateCount: number;
  warningCount: number;
  maxAllowed: number;
  students: ImportedStudent[];
  errors: { line: number; value: string; reason: string }[];
  duplicates: { line: number; firstLine: number; value: string }[];
}

export function ExamStudentImport({
  subjectId,
  selectedIds,
  onApplyStudents,
}: {
  subjectId: string;
  selectedIds: string[];
  onApplyStudents: (
    ids: string[],
    importedRoster: { id: string; name: string; username?: string | null; sub?: string }[],
    mode: "replace" | "merge",
  ) => void;
}) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [enrolledOnly, setEnrolledOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<StudentImportReport | null>(null);
  const [appliedMode, setAppliedMode] = useState<"replace" | "merge" | null>(null);
  const [dragging, setDragging] = useState(false);

  async function validateFile(file: File) {
    setError("");
    setAppliedMode(null);
    const lower = file.name.toLowerCase();
    if (!(lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv"))) {
      setError(t("Please upload an Excel (.xlsx, .xls) or CSV (.csv) spreadsheet."));
      return;
    }
    if (!subjectId) {
      setError(t("Select a subject first before importing students."));
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("subjectId", subjectId);
      fd.append("enrolledOnly", enrolledOnly ? "true" : "false");
      const res = await api.upload<StudentImportReport>("/api/v1/exams/import-students", fd);
      setReport(res);
    } catch (err) {
      setReport(null);
      setError(err instanceof Error ? err.message : t("Failed to validate spreadsheet."));
    } finally {
      setBusy(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void validateFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void validateFile(file);
  }

  function apply(mode: "replace" | "merge") {
    if (!report || !report.students.length) return;
    const ids = report.students.map((s) => s.id);
    const roster = report.students.map((s) => ({
      id: s.id,
      name: s.name,
      username: s.username,
      sub: s.sectionNames.length
        ? s.sectionNames.join(", ")
        : s.enrolled
          ? t("Enrolled")
          : t("Imported via spreadsheet"),
    }));
    onApplyStudents(ids, roster, mode);
    setAppliedMode(mode);
  }

  const templateHref = apiUrl("/api/v1/exams/import-students/template");
  const prefillHref = subjectId
    ? apiUrl(`/api/v1/exams/import-students/template?subject_id=${encodeURIComponent(subjectId)}&prefill=true`)
    : templateHref;

  return (
    <div className="student-import-box">
      <div className="student-import-head">
        <div className="student-import-title">
          <FileSpreadsheet size={16} />
          <div>
            <b>{t("Import eligible students from Excel / CSV")}</b>
            <small>
              {t(
                "Upload an .xlsx, .xls, or .csv sheet with a 'username' (or 'student_id') or 'email' column. Every row is validated against active student accounts.",
              )}
            </small>
          </div>
        </div>
        <div className="student-import-templates">
          <a href={templateHref} download className="text-button">
            <Download size={13} /> {t("Blank template (.xlsx)")}
          </a>
          {subjectId && (
            <a href={prefillHref} download className="text-button">
              <Download size={13} /> {t("Download subject roster (.xlsx)")}
            </a>
          )}
        </div>
      </div>

      <div
        className={`student-dropzone ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
          className="sr-only"
          disabled={busy}
          onChange={handleFileChange}
          id="exam-student-xlsx-input"
        />
        <Upload size={20} />
        <div>
          <strong>
            {busy
              ? t("Validating spreadsheet…")
              : t("Drop an .xlsx or .csv file here, or click to browse")}
          </strong>
          <small>
            {t("Required column: username (or student_id) or email · Optional: full_name")}
          </small>
        </div>
        <button
          type="button"
          className="secondary"
          disabled={busy || !subjectId}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={14} /> {t("Choose file")}
        </button>
      </div>

      <label className="student-import-toggle">
        <input
          type="checkbox"
          checked={enrolledOnly}
          disabled={busy}
          onChange={(e) => setEnrolledOnly(e.target.checked)}
        />
        <span>
          {t("Only accept students already enrolled in this subject (reject external students)")}
        </span>
      </label>

      <Feedback error={error || undefined} />

      {report && (
        <div className="student-import-report">
          <div className="sir-header">
            <div className="sir-file">
              <FileSpreadsheet size={15} />
              <b>{report.filename}</b>
              <span className="subtle">
                ({report.totalRows} {t("rows")} · {t("columns")}:{" "}
                {report.detectedColumns.join(", ")})
              </span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t("Dismiss validation report")}
              onClick={() => {
                setReport(null);
                setAppliedMode(null);
              }}
            >
              <X size={15} />
            </button>
          </div>

          <div className="sir-stats">
            <div className="sir-stat ok">
              <CheckCircle2 size={14} />
              <b>{report.validCount}</b>
              <span>{t("Valid students")}</span>
            </div>
            <div className={`sir-stat ${report.errorCount > 0 ? "err" : "muted"}`}>
              <AlertCircle size={14} />
              <b>{report.errorCount}</b>
              <span>{t("Invalid rows")}</span>
            </div>
            <div className={`sir-stat ${report.duplicateCount > 0 ? "warn" : "muted"}`}>
              <AlertTriangle size={14} />
              <b>{report.duplicateCount}</b>
              <span>{t("Duplicates skipped")}</span>
            </div>
            {report.warningCount > 0 && (
              <div className="sir-stat warn">
                <AlertTriangle size={14} />
                <b>{report.warningCount}</b>
                <span>{t("With notes")}</span>
              </div>
            )}
          </div>

          {report.validCount > 0 && (
            <div className="sir-actions">
              <button
                type="button"
                className="primary"
                onClick={() => apply("replace")}
              >
                <UserCheck size={14} />
                {t("Use these {0} students for exam", { "0": report.validCount })}
              </button>
              {selectedIds.length > 0 && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => apply("merge")}
                >
                  {t("Add to current selection ({0})", { "0": selectedIds.length })}
                </button>
              )}
              {appliedMode && (
                <span className="sir-applied-pill" role="status">
                  <CheckCircle2 size={13} />
                  {appliedMode === "replace"
                    ? t("Applied {0} students to exam audience", { "0": report.validCount })
                    : t("Merged into exam audience")}
                </span>
              )}
            </div>
          )}

          {report.errors.length > 0 && (
            <div className="sir-table-block">
              <div className="sir-table-title err">
                <AlertCircle size={13} /> {t("Invalid rows (excluded)")} ({report.errors.length})
              </div>
              <div className="table-wrap sir-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("Row")}</th>
                      <th scope="col">{t("Value")}</th>
                      <th scope="col">{t("Validation issue")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.errors.slice(0, 50).map((e, i) => (
                      <tr key={`${e.line}-${i}`}>
                        <td>#{e.line}</td>
                        <td>
                          <bdi>{e.value}</bdi>
                        </td>
                        <td>{e.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.errors.length > 50 && (
                <p className="subtle">
                  {t("Showing first 50 of {0} invalid rows.", { "0": report.errors.length })}
                </p>
              )}
            </div>
          )}

          {report.duplicates.length > 0 && (
            <div className="sir-table-block">
              <div className="sir-table-title warn">
                <AlertTriangle size={13} /> {t("Duplicate rows skipped")} ({report.duplicates.length})
              </div>
              <div className="sir-dupe-chips">
                {report.duplicates.slice(0, 20).map((d, i) => (
                  <span className="meta-pill" key={`${d.line}-${i}`}>
                    #{d.line} · <bdi>{d.value}</bdi> ({t("same as #{0}", { "0": d.firstLine })})
                  </span>
                ))}
              </div>
            </div>
          )}

          {report.students.length > 0 && (
            <div className="sir-table-block">
              <div className="sir-table-title ok">
                <CheckCircle2 size={13} /> {t("Validated students preview")} (
                {Math.min(25, report.students.length)} / {report.students.length})
              </div>
              <div className="table-wrap sir-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("Row")}</th>
                      <th scope="col">{t("Student")}</th>
                      <th scope="col">{t("Username")}</th>
                      <th scope="col">{t("Status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.students.slice(0, 25).map((s) => (
                      <tr key={s.id}>
                        <td>#{s.line}</td>
                        <td>
                          <b>{s.name}</b>
                          {s.warnings.length > 0 && (
                            <small className="sir-warn-note">{s.warnings.join(" · ")}</small>
                          )}
                        </td>
                        <td>
                          <bdi>{s.username ?? s.email}</bdi>
                        </td>
                        <td>
                          <span className={`badge ${s.enrolled ? "badge-approved" : "badge-medium"}`}>
                            {s.sectionNames.length
                              ? s.sectionNames.join(", ")
                              : s.enrolled
                                ? t("Enrolled")
                                : t("Direct list")}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
