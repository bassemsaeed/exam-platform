import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertCircle,
  BookOpen,
  Building2,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  KeyRound,
  Upload,
  Users,
} from "lucide-react";
import { api, type SessionUser } from "../lib/api";
import { useT } from "../lib/i18n";
import {
  useResource,
  rowsOf,
  invalidateResources,
  date,
  time,
  previewMode,
  type Envelope,
  type Subject,
} from "../lib/platform";
import { apiUrl } from "../lib/seb";
import { Combo } from "./builder";
import { Badge, Feedback } from "./ui";

interface CollegeOpt {
  id: string;
  code: string;
  name: string;
}

interface DeptOpt {
  id: string;
  code: string;
  name: string;
  collegeId?: string | null;
}

interface TermOpt {
  id: string;
  name: string;
  isCurrent?: boolean;
}

interface SectionOpt {
  id: string;
  name: string;
  ta?: { id: string; name: string } | null;
}

interface DryRunResponse {
  batchId: string;
  target: "college" | "subject";
  targetSummary: {
    college?: { id: string; code: string; name: string } | null;
    department?: { id: string; code: string; name: string } | null;
    subject?: { id: string; code: string; name: string } | null;
    term?: { id: string; name: string } | null;
    section?: { id: string; name: string } | null;
  };
  counts: {
    total: number;
    valid: number;
    newAccounts: number;
    existingStudents: number;
    alreadyEnrolled: number;
    errors: number;
  };
  errors: { line: number; reason: string }[];
  preview: {
    line: number;
    status: "new" | "existing" | "already_enrolled";
    username: string;
    fullName: string;
    email: string;
    academicYear: number | null;
    sectionName: string | null;
  }[];
  previewTruncated: boolean;
  expiresAt: string;
}

interface CommitResponse {
  ok: boolean;
  imported: number;
  created: number;
  updated: number;
  enrolled: number;
  sectionAssigned: number;
  skipped: number;
  errors: { line: number; reason: string }[];
  credentials: { username: string; fullName: string; email: string; password: string }[];
  logId: string;
}

export function StudentTargetImport({
  user,
  initialTarget = "college",
  initialCollegeId = "",
  initialSubjectId = "",
}: {
  user: SessionUser;
  initialTarget?: "college" | "subject";
  initialCollegeId?: string;
  initialSubjectId?: string;
}) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [target, setTarget] = useState<"college" | "subject">(initialTarget);
  const [collegeId, setCollegeId] = useState(initialCollegeId);
  const [departmentId, setDepartmentId] = useState("");
  const [subjectId, setSubjectId] = useState(initialSubjectId);
  const [termId, setTermId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [defaultYear, setDefaultYear] = useState("");
  const [createMissing, setCreateMissing] = useState(true);
  const [passwordMode, setPasswordMode] = useState<"auto" | "student_id" | "fixed">("auto");
  const [fixedPassword, setFixedPassword] = useState("");

  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [batch, setBatch] = useState<DryRunResponse | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);
  const [credDownloading, setCredDownloading] = useState(false);
  const [credError, setCredError] = useState<string | null>(null);

  const collegesQ = useResource<Envelope<CollegeOpt> | CollegeOpt[]>(
    user,
    "/api/v1/admin/colleges?limit=100",
  );
  const departmentsQ = useResource<Envelope<DeptOpt> | DeptOpt[]>(
    user,
    `/api/v1/admin/departments?limit=100${collegeId ? `&college_id=${encodeURIComponent(collegeId)}` : ""}`,
    target === "college",
  );
  const subjectsQ = useResource<Envelope<Subject> | Subject[]>(
    user,
    "/api/v1/admin/subjects?limit=100",
    target === "subject",
  );
  const termsQ = useResource<Envelope<TermOpt> | TermOpt[]>(
    user,
    "/api/v1/admin/terms",
    target === "subject",
  );

  const colleges = rowsOf(collegesQ.data as Envelope<CollegeOpt> | CollegeOpt[] | undefined);
  const allDepts = rowsOf(departmentsQ.data as Envelope<DeptOpt> | DeptOpt[] | undefined);
  const collegeDepts = collegeId
    ? allDepts.filter((d) => !d.collegeId || d.collegeId === collegeId)
    : allDepts;
  const subjects = rowsOf(subjectsQ.data as Envelope<Subject> | Subject[] | undefined);
  const terms = rowsOf(termsQ.data as Envelope<TermOpt> | TermOpt[] | undefined);
  const currentTerm = terms.find((tm) => tm.isCurrent) ?? terms[0];
  const activeTermId = termId || currentTerm?.id || "";

  const sectionsQ = useResource<Envelope<SectionOpt> | SectionOpt[]>(
    user,
    `/api/v1/admin/sections?subject_id=${encodeURIComponent(subjectId)}&term_id=${encodeURIComponent(activeTermId)}&limit=100`,
    target === "subject" && Boolean(subjectId && activeTermId),
  );
  const sections = rowsOf(sectionsQ.data as Envelope<SectionOpt> | SectionOpt[] | undefined);

  useEffect(() => {
    setBatch(null);
    setCommitResult(null);
  }, [target, collegeId, departmentId, subjectId, activeTermId, sectionId, defaultYear, createMissing, passwordMode, fixedPassword]);

  const dryRun = useMutation({
    mutationFn: async () => {
      if (previewMode) {
        throw new Error(
          t("Spreadsheet imports require the connected backend. Use manual entry in this demo."),
        );
      }
      if (!file) throw new Error(t("Choose an Excel or CSV file first."));
      if (target === "college" && !collegeId) {
        throw new Error(t("Select a target college first."));
      }
      if (target === "subject" && !subjectId) {
        throw new Error(t("Select a target subject first."));
      }
      const fd = new FormData();
      fd.set("file", file);
      fd.set("target", target);
      if (target === "college") {
        fd.set("collegeId", collegeId);
        if (departmentId) fd.set("departmentId", departmentId);
      } else {
        fd.set("subjectId", subjectId);
        if (activeTermId) fd.set("termId", activeTermId);
        if (sectionId) fd.set("sectionId", sectionId);
        fd.set("createMissing", String(createMissing));
      }
      if (defaultYear) fd.set("defaultYear", defaultYear);
      fd.set("passwordMode", passwordMode);
      if (passwordMode === "fixed" && fixedPassword) {
        fd.set("fixedPassword", fixedPassword);
      }
      return api.upload<DryRunResponse>(
        "/api/v1/admin/users/import/students/dry-run",
        fd,
      );
    },
    onSuccess: (data) => {
      setBatch(data);
      setCommitResult(null);
    },
  });

  const commit = useMutation({
    mutationFn: async () => {
      if (!batch) throw new Error("No batch");
      return api.post<CommitResponse>(
        "/api/v1/admin/users/import/students/commit",
        { batchId: batch.batchId },
      );
    },
    onSuccess: (data) => {
      setCommitResult(data);
      setBatch(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      void invalidateResources(user.id, [
        "/api/v1/admin/users",
        "/api/v1/admin/colleges",
        "/api/v1/admin/subjects",
        "/api/v1/admin/sections",
        "/api/v1/exams/subjects",
      ]);
    },
  });

  async function downloadCredentialsXlsx() {
    if (!commitResult?.credentials?.length) return;
    setCredDownloading(true);
    setCredError(null);
    try {
      const targetLabel =
        target === "college"
          ? colleges.find((c) => c.id === collegeId)?.code || "college"
          : subjects.find((s) => s.id === subjectId)?.code || "subject";
      const res = await fetch(
        apiUrl("/api/v1/admin/users/import/students/credentials-xlsx"),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rows: commitResult.credentials,
            label: targetLabel,
          }),
        },
      );
      if (!res.ok) throw new Error(t("Failed to export credentials"));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `o6u-credentials-${targetLabel}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setCredError(err instanceof Error ? err.message : t("Failed to export credentials"));
    } finally {
      setCredDownloading(false);
    }
  }

  const templateUrl = apiUrl(
    `/api/v1/admin/users/import/students/template?target=${target}${
      target === "college" && collegeId
        ? `&collegeId=${encodeURIComponent(collegeId)}`
        : target === "subject" && subjectId
          ? `&subjectId=${encodeURIComponent(subjectId)}`
          : ""
    }`,
  );

  const canValidate =
    Boolean(file) &&
    (target === "college" ? Boolean(collegeId) : Boolean(subjectId)) &&
    !dryRun.isPending;

  const showPasswordPolicy = target === "college" || createMissing;

  return (
    <div className="sti-wrap">
      {/* Target Mode Switcher */}
      <div className="sti-mode-grid" role="tablist" aria-label={t("Import target")}>
        <button
          type="button"
          role="tab"
          aria-selected={target === "college"}
          className={`sti-mode-card ${target === "college" ? "on" : ""}`}
          onClick={() => setTarget("college")}
        >
          <span className="sti-mode-ico">
            <Building2 size={18} />
          </span>
          <div>
            <b>{t("Import to College")}</b>
            <small>{t("Link students to a college")}</small>
          </div>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={target === "subject"}
          className={`sti-mode-card ${target === "subject" ? "on" : ""}`}
          onClick={() => setTarget("subject")}
        >
          <span className="sti-mode-ico">
            <BookOpen size={18} />
          </span>
          <div>
            <b>{t("Import to Subject")}</b>
            <small>{t("Enroll students in a subject")}</small>
          </div>
        </button>
      </div>

      {/* Step 1: Target Selection */}
      <section className="panel sti-section">
        <Feedback error={collegesQ.error || departmentsQ.error || subjectsQ.error || termsQ.error || sectionsQ.error} />
        <div className="panel-heading">
          <h2>
            {target === "college"
              ? t("1. Target college")
              : t("1. Target subject")}
          </h2>
          <a href={templateUrl} download className="button secondary">
            <Download size={15} />
            {target === "college"
              ? t("College template (.xlsx)")
              : t("Subject template (.xlsx)")}
          </a>
        </div>

        {target === "college" ? (
          <div className="sti-fields-grid">
            <div className="field">
              <span className="field-label">{t("College")} *</span>
              <Combo
                value={collegeId}
                options={colleges.map((c) => ({
                  value: c.id,
                  label: `${c.code} · ${c.name}`,
                }))}
                onChange={(v) => {
                  setCollegeId(v);
                  setDepartmentId("");
                }}
                placeholder={t("Select target college…")}
                ariaLabel={t("College")}
              />
            </div>

            <div className="field">
              <span className="field-label">{t("Department (optional)")}</span>
              <Combo
                value={departmentId}
                options={[
                  { value: "", label: t("No specific department") },
                  ...collegeDepts.map((d) => ({
                    value: d.id,
                    label: `${d.code} · ${d.name}`,
                  })),
                ]}
                onChange={setDepartmentId}
                placeholder={t("No specific department")}
                ariaLabel={t("Department (optional)")}
              />
            </div>

            <div className="field">
              <label htmlFor="sti-col-year">{t("Default academic year (optional)")}</label>
              <select
                id="sti-col-year"
                value={defaultYear}
                onChange={(e) => setDefaultYear(e.target.value)}
              >
                <option value="">{t("Use year column from spreadsheet")}</option>
                {[1, 2, 3, 4, 5, 6, 7].map((y) => (
                  <option key={y} value={String(y)}>
                    {t("Year {0}", { "0": y })}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <>
            <div className="sti-fields-grid">
              <div className="field">
                <span className="field-label">{t("Subject")} *</span>
                <Combo
                  value={subjectId}
                  options={subjects.map((s) => ({
                    value: s.id,
                    label: `${s.code} · ${s.name}`,
                  }))}
                  onChange={(v) => {
                    setSubjectId(v);
                    setSectionId("");
                  }}
                  placeholder={t("Select target subject…")}
                  ariaLabel={t("Subject")}
                />
              </div>

              <div className="field">
                <label htmlFor="sti-sub-term">{t("Term")}</label>
                <select
                  id="sti-sub-term"
                  value={activeTermId}
                  onChange={(e) => {
                    setTermId(e.target.value);
                    setSectionId("");
                  }}
                >
                  {terms.map((tm) => (
                    <option key={tm.id} value={tm.id}>
                      {tm.name}
                      {tm.isCurrent ? ` (${t("Current")})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="sti-sub-sec">{t("Section (optional)")}</label>
                <select
                  id="sti-sub-sec"
                  value={sectionId}
                  disabled={!subjectId}
                  onChange={(e) => setSectionId(e.target.value)}
                >
                  <option value="">{t("Use section column or enroll without section")}</option>
                  {sections.map((sec) => (
                    <option key={sec.id} value={sec.id}>
                      {sec.name}
                      {sec.ta?.name ? ` · ${sec.ta.name}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="sti-check-row">
              <input
                type="checkbox"
                checked={createMissing}
                onChange={(e) => setCreateMissing(e.target.checked)}
              />
              <span>
                <b>{t("Create missing student accounts")}</b>
              </span>
            </label>
          </>
        )}

        {/* Password policy for newly created accounts */}
        {showPasswordPolicy && (
          <div className="sti-pw-box">
            <div className="sti-pw-head">
              <KeyRound size={14} />
              <span>{t("New account passwords")}</span>
            </div>
            <div className="sti-pw-opts">
              <label className={`sti-pw-opt ${passwordMode === "auto" ? "on" : ""}`}>
                <input
                  type="radio"
                  name="sti-pw-mode"
                  checked={passwordMode === "auto"}
                  onChange={() => setPasswordMode("auto")}
                />
                <span>
                  <b>{t("Auto-generate")}</b>
                  <small>{t("One-time Excel download")}</small>
                </span>
              </label>

              <label className={`sti-pw-opt ${passwordMode === "student_id" ? "on" : ""}`}>
                <input
                  type="radio"
                  name="sti-pw-mode"
                  checked={passwordMode === "student_id"}
                  onChange={() => setPasswordMode("student_id")}
                />
                <span>
                  <b>{t("Student ID")}</b>
                  <small>{t("Matches student ID")}</small>
                </span>
              </label>

              <label className={`sti-pw-opt ${passwordMode === "fixed" ? "on" : ""}`}>
                <input
                  type="radio"
                  name="sti-pw-mode"
                  checked={passwordMode === "fixed"}
                  onChange={() => setPasswordMode("fixed")}
                />
                <span>
                  <b>{t("Custom password")}</b>
                  <small>{t("Same for all new accounts")}</small>
                </span>
              </label>
            </div>

            {passwordMode === "fixed" && (
              <div className="field" style={{ maxWidth: 320, margin: "8px 0 0" }}>
                <input
                  type="text"
                  value={fixedPassword}
                  onChange={(e) => setFixedPassword(e.target.value)}
                  placeholder={t("Temporary password (8+ characters)…")}
                />
              </div>
            )}
          </div>
        )}
      </section>

      {/* Step 2: Upload & Validate */}
      <section className="panel sti-section">
        <div className="panel-heading">
          <h2>{t("2. Upload file")}</h2>
          <a href={templateUrl} download className="text-button sti-tpl-link">
            <FileSpreadsheet size={14} />
            {t("Download template (.xlsx)")}
          </a>
        </div>

        <div
          className={`student-dropzone ${dragging ? "dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) {
              setFile(dropped);
              setBatch(null);
              setCommitResult(null);
            }
          }}
        >
          <Upload size={20} />
          <div>
            <strong>
              {file
                ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`
                : t("Drop an .xlsx or .csv file here, or click to browse")}
            </strong>
            <small>{t("Accepts .xlsx, .xls, or .csv")}</small>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() => fileRef.current?.click()}
          >
            {t("Choose file")}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: "none" }}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setBatch(null);
              setCommitResult(null);
            }}
          />
        </div>

        <Feedback error={dryRun.error || commit.error} />

        <div className="sti-action-bar">
          <button
            type="button"
            className="primary"
            disabled={!canValidate}
            onClick={() => dryRun.mutate()}
          >
            {dryRun.isPending ? t("Validating spreadsheet…") : t("Validate spreadsheet")}
          </button>
        </div>

        {/* Commit Success Banner + Credentials Download */}
        {commitResult && (
          <div className="sti-commit-done" role="status">
            <div className="sti-commit-head">
              <CheckCircle2 size={20} />
              <div>
                <strong>{t("Student import completed")}</strong>
                <p>
                  {t("{0} new accounts created · {1} updated · {2} enrolled", {
                    "0": commitResult.created,
                    "1": commitResult.updated,
                    "2": commitResult.enrolled,
                  })}
                  {commitResult.sectionAssigned > 0
                    ? ` · ${t("{0} placed in sections", { "0": commitResult.sectionAssigned })}`
                    : ""}
                  {commitResult.skipped > 0
                    ? ` · ${t("{0} already up to date", { "0": commitResult.skipped })}`
                    : ""}
                </p>
              </div>
            </div>

            {commitResult.credentials.length > 0 && (
              <>
                <div className="sti-creds-bar">
                  <span>
                    {t("{0} newly created accounts have initial passwords ready to export (one-time download).", {
                      "0": commitResult.credentials.length,
                    })}
                  </span>
                  <button
                    type="button"
                    className="primary"
                    disabled={credDownloading}
                    onClick={() => void downloadCredentialsXlsx()}
                  >
                    <Download size={14} />
                    {credDownloading
                      ? t("Preparing Excel…")
                      : t("Download new credentials (.xlsx)")}
                  </button>
                </div>
                <Feedback error={credError || undefined} />
              </>
            )}
          </div>
        )}

        {/* Dry-Run Validation Report & Preview */}
        {batch && (
          <div className="validation-report sti-report">
            <div className="sti-report-head">
              <div>
                <h3>
                  {t("Validation summary")}
                  {batch.targetSummary.college && batch.target === "college"
                    ? ` → ${batch.targetSummary.college.code} · ${batch.targetSummary.college.name}`
                    : ""}
                  {batch.targetSummary.subject && batch.target === "subject"
                    ? ` → ${batch.targetSummary.subject.code} · ${batch.targetSummary.subject.name}`
                    : ""}
                </h3>
                <p className="subtle">
                  {t("Expires")} {date(batch.expiresAt)} · {time(batch.expiresAt)}
                </p>
              </div>
              <button
                type="button"
                className="primary"
                disabled={commit.isPending || batch.counts.valid === 0}
                onClick={() => commit.mutate()}
              >
                <Users size={15} />
                {commit.isPending
                  ? t("Importing students…")
                  : t("Commit {0} students", { "0": batch.counts.valid })}
              </button>
            </div>

            <div className="sir-stats">
              <div className="sir-stat ok">
                <b>{batch.counts.newAccounts}</b>
                <span>{t("New accounts")}</span>
              </div>
              <div className="sir-stat">
                <b>{batch.counts.existingStudents}</b>
                <span>{t("Existing students")}</span>
              </div>
              <div className="sir-stat muted">
                <b>{batch.counts.alreadyEnrolled}</b>
                <span>{t("Already linked")}</span>
              </div>
              <div className={`sir-stat ${batch.counts.errors > 0 ? "err" : "muted"}`}>
                <b>{batch.counts.errors}</b>
                <span>{t("Invalid rows")}</span>
              </div>
            </div>

            {batch.errors.length > 0 && (
              <div className="sir-table-block">
                <div className="sir-table-title err">
                  <AlertCircle size={14} />
                  {t("Invalid rows (excluded)")} ({batch.errors.length})
                </div>
                <div className="sir-scroll">
                  <table className="compact">
                    <thead>
                      <tr>
                        <th>{t("Row")}</th>
                        <th>{t("Validation issue")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.errors.slice(0, 60).map((e, idx) => (
                        <tr key={idx}>
                          <td>{e.line}</td>
                          <td>{e.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {batch.preview.length > 0 && (
              <div className="sir-table-block">
                <div className="sir-table-title ok">
                  {t("Preview")} · {batch.counts.valid}{" "}
                  {batch.previewTruncated
                    ? t("showing first {0}", { "0": batch.preview.length })
                    : t("rows")}
                </div>
                <div className="sir-scroll">
                  <table className="compact">
                    <thead>
                      <tr>
                        <th>{t("Row")}</th>
                        <th>{t("Student ID")}</th>
                        <th>{t("Full name")}</th>
                        <th>{t("Year")}</th>
                        {batch.target === "subject" && <th>{t("Section")}</th>}
                        <th>{t("Status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.preview.map((r) => (
                        <tr key={r.line}>
                          <td>{r.line}</td>
                          <td><bdi><b>{r.username}</b></bdi></td>
                          <td dir="auto">{r.fullName}</td>
                          <td>{r.academicYear ?? "—"}</td>
                          {batch.target === "subject" && <td>{r.sectionName ?? "—"}</td>}
                          <td>
                            <Badge
                              value={
                                r.status === "new"
                                  ? "approved"
                                  : r.status === "already_enrolled"
                                    ? "inactive"
                                    : "pending_approval"
                              }
                            />
                            <span className="subtle" style={{ marginInlineStart: 6 }}>
                              {r.status === "new"
                                ? t("New account")
                                : r.status === "already_enrolled"
                                  ? t("Already linked")
                                  : t("Existing")}
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
      </section>
    </div>
  );
}
