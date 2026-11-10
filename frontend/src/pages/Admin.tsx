import { BulkUsers } from "../components/BulkUsers";
import { useT } from "../lib/i18n";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useLocation } from "react-router-dom";
import {
  Plus,
  Pencil,
  Trash2,
  ArrowUpRight,
  BookOpen,
  Building2,
  GraduationCap,
  Layers,
  Users,
  X,
} from "lucide-react";
import type { SessionUser } from "../lib/api";
import {
  useResource,
  useAction,
  rowsOf,
  label,
  date,
  type Entity,
  type Envelope,
} from "../lib/platform";
import {
  PageTitle,
  FieldsForm,
  Dialog,
  Confirm,
  Feedback,
  Loading,
  Empty,
  Badge,
  Pagination,
  SearchBox,
  Success,
} from "../components/ui";
import type { Field } from "../components/ui";
import { Combo, MultiPicker } from "../components/builder";

const options = (values: string[]) =>
  values.map((value) => ({ value, label: label(value) }));
const pick = (rows: Entity[]) =>
  rows.map((r) => ({
    value: r.id,
    label: r.code && r.name ? `${String(r.code)} · ${String(r.name)}` : String(r.name ?? r.username ?? r.id),
  }));

const baseFields: Record<string, Field[]> = {
  users: [
    { key: "name", label: "Full name", required: true },
    { key: "username", label: "Username", required: true },
    { key: "email", label: "Email", type: "email" },
    {
      key: "role",
      label: "Role",
      required: true,
      segmented: true,
      options: options(["student", "doctor", "ta"]),
    },
    { key: "academicYear", label: "Academic year", type: "number", min: 1 },
  ],
  subjects: [
    { key: "code", label: "Subject code", required: true },
    { key: "name", label: "Subject name", required: true },
  ],
  departments: [
    { key: "code", label: "Department code", required: true },
    { key: "name", label: "Department name", required: true },
  ],
  terms: [
    { key: "name", label: "Term name", required: true },
    {
      key: "startsOn",
      label: "Starts on",
      type: "datetime-local",
      required: true,
    },
    { key: "endsOn", label: "Ends on", type: "datetime-local", required: true },
  ],
  sections: [{ key: "name", label: "Section name", required: true }],
  "seb-keys": [
    { key: "label", label: "Lab / key label", required: true },
    {
      key: "rawKey",
      label: "Browser configuration key",
      type: "password",
      required: true,
      hint: "At least 16 characters. Never displayed after saving.",
    },
  ],
};

const display = (value: unknown): string =>
  value == null
    ? "—"
    : typeof value === "object"
      ? String(
          (value as Entity).name ??
            (value as Entity).code ??
            (value as Entity).username ??
            "—",
        )
      : String(value);

interface SubjectDoctorAssignment {
  doctorId: string;
  termId: string;
  doctor: { id: string; name: string; username: string };
  term: { id: string; name: string; isCurrent?: boolean };
}

interface RichSubjectRow extends Entity {
  code: string;
  name: string;
  departmentId?: string | null;
  department?: {
    id: string;
    code: string;
    name: string;
    collegeId?: string | null;
    college?: { id: string; code: string; name: string } | null;
  } | null;
  _count?: {
    enrollments: number;
    sections: number;
    questions: number;
    exams: number;
  };
  doctorAssignments?: SubjectDoctorAssignment[];
}

interface DoctorAssignmentRow extends Entity {
  doctorId: string;
  subjectId: string;
  termId: string;
  doctor: {
    id: string;
    username: string;
    name: string;
    email?: string;
    department?: { id: string; code: string; name: string } | null;
    collegeRef?: { id: string; code: string; name: string } | null;
  };
  subject: {
    id: string;
    code: string;
    name: string;
    department?: {
      id: string;
      code: string;
      name: string;
      college?: { id: string; code: string; name: string } | null;
    } | null;
  };
  term: { id: string; name: string; isCurrent?: boolean };
}

function RosterEditor({
  user,
  sectionId,
}: {
  user: SessionUser;
  sectionId: string;
}) {
  const t = useT();
  const [addSel, setAddSel] = useState<string[]>([]);
  const [removeSel, setRemoveSel] = useState<string[]>([]);
  const path = `/api/v1/admin/sections/${sectionId}/members`;
  const membersQ = useResource<{ rows: Entity[]; total: number; truncated: boolean }>(user, path);
  const poolQ = useResource<Envelope<Entity>>(
    user,
    `/api/v1/admin/users?role=student&active=true&limit=100`,
  );
  const action = useAction(user, [path]);
  const current: Entity[] = membersQ.data?.rows ?? [];
  const memberIds = new Set(current.map((m) => m.id));
  const candidates = rowsOf(poolQ.data).filter((u) => !memberIds.has(u.id));
  return (
    <>
      <Feedback error={membersQ.error || poolQ.error} />
      <p className="subtle">
        {membersQ.data?.total ?? 0}
        {t(" members ")}
        {membersQ.data?.truncated ? t(" · list truncated") : ""}
      </p>
      <h3 className="subtle">{t("Add students")}</h3>
      {poolQ.isPending ? (
        <Loading />
      ) : (
        <MultiPicker
          options={candidates.map((u) => ({
            id: u.id,
            name: String(u.name ?? u.username),
            username: String(u.username ?? ""),
          }))}
          value={addSel.filter((x) => !memberIds.has(x))}
          onChange={setAddSel}
          placeholder="Search active students…"
          emptyText="No matching students (they may already be members)."
        />
      )}
      <h3 className="subtle">{t("Remove students")}</h3>
      <MultiPicker
        options={current.map((m) => ({
          id: m.id,
          name: String(m.name ?? m.username),
          username: String(m.username ?? ""),
        }))}
        value={removeSel}
        onChange={setRemoveSel}
        placeholder="Search current members…"
        emptyText="No members to remove."
      />
      <Feedback error={action.error} />
      <div className="dialog-actions">
        <button
          className="primary"
          disabled={(!addSel.length && !removeSel.length) || action.isPending}
          onClick={() =>
            action.mutate(
              { path, body: { add: addSel, remove: removeSel } },
              {
                onSuccess: () => {
                  setAddSel([]);
                  setRemoveSel([]);
                },
              },
            )
          }
        >
          {action.isPending ? t("Saving…") : t("Apply changes")}
        </button>
      </div>
    </>
  );
}

export function AdminResource({ user }: { user: SessionUser }) {
  const t = useT();
  const { resource = "users" } = useParams();
  const location = useLocation();
  const [roleFilter, setRoleFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [collegeFilter, setCollegeFilter] = useState("");
  const [termFilter, setTermFilter] = useState("");
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [assignment, setAssignment] = useState("doctors");
  const [assignViewMode, setAssignViewMode] = useState<"doctors" | "subjects" | "table">("doctors");
  const [resetUser, setResetUser] = useState<Entity | null>(null);
  const [resetSuccess, setResetSuccess] = useState("");
  const [resetMismatch, setResetMismatch] = useState("");

  // Quick assignment modal states for Subject cards and Doctor cards
  const [assignToSubject, setAssignToSubject] = useState<RichSubjectRow | null>(null);
  const [assignToDoctor, setAssignToDoctor] = useState<{ id: string; name: string; username: string; assignedSubjectIds: string[] } | null>(null);
  const [quickPickIds, setQuickPickIds] = useState<string[]>([]);
  const [quickTermId, setQuickTermId] = useState("");
  const [quickBusy, setQuickBusy] = useState(false);

  useEffect(
    () => setSelectedUsers([]),
    [resource, page, roleFilter, activeFilter, departmentFilter, collegeFilter, search],
  );
  const [edit, setEdit] = useState<Entity | "new" | null>(null);
  const [remove, setRemove] = useState<Entity | null>(null);
  const [current, setCurrent] = useState<Entity | null>(null);
  const [roster, setRoster] = useState<Entity | null>(null);

  const path =
    resource === "assignments"
      ? assignment === "tas"
        ? "/api/v1/admin/sections"
        : "/api/v1/admin/assignments/" + assignment
      : "/api/v1/admin/" + resource;

  const queryParams = useMemo(() => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("limit", resource === "subjects" || (resource === "assignments" && assignment === "doctors") ? "60" : "20");
    if (resource === "users") {
      if (roleFilter) p.set("role", roleFilter);
      if (activeFilter) p.set("active", activeFilter);
      if (departmentFilter) p.set("department_id", departmentFilter);
      if (collegeFilter) p.set("college_id", collegeFilter);
    }
    if (resource === "subjects") {
      if (departmentFilter) p.set("department_id", departmentFilter);
      if (collegeFilter) p.set("college_id", collegeFilter);
    }
    if (resource === "departments" && collegeFilter) {
      p.set("college_id", collegeFilter);
    }
    if (resource === "assignments" && termFilter) {
      p.set("term_id", termFilter);
    }
    if (["users", "subjects", "departments", "sections", "assignments"].includes(resource) && search.trim()) {
      p.set("search", search.trim());
    }
    return p.toString();
  }, [resource, assignment, page, roleFilter, activeFilter, departmentFilter, collegeFilter, termFilter, search]);

  const query = useResource<Envelope<Entity> | Entity[]>(
    user,
    `${path}?${queryParams}`,
  );
  const subjects = useResource<Envelope<RichSubjectRow>>(
    user,
    "/api/v1/admin/subjects?limit=100",
    ["sections", "assignments", "subjects"].includes(resource),
  );
  const terms = useResource<Entity[]>(
    user,
    "/api/v1/admin/terms",
    ["sections", "assignments", "subjects"].includes(resource),
  );
  const doctorsPool = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/users?role=doctor&limit=100",
    ["subjects", "assignments"].includes(resource),
  );
  const tasPool = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/users?role=ta&limit=100",
    ["sections", "assignments"].includes(resource),
  );
  const studentsPool = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/users?role=student&limit=100",
    resource === "assignments" && assignment === "enrollments",
  );
  const departments = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/departments?limit=100",
    ["users", "subjects", "departments"].includes(resource),
  );
  const colleges = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/colleges?limit=100",
    ["users", "subjects", "departments"].includes(resource),
  );
  const tasSections = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/sections?limit=100",
    resource === "assignments" && assignment === "tas",
  );
  const action = useAction(user, [
    path,
    "/api/v1/admin/subjects",
    "/api/v1/admin/assignments/doctors",
    "/api/v1/admin/assignments/enrollments",
    "/api/v1/exams",
  ]);

  const currentTerm = useMemo(
    () => rowsOf(terms.data).find((x) => Boolean(x.isCurrent)) ?? rowsOf(terms.data)[0] ?? null,
    [terms.data],
  );

  useEffect(() => {
    if (currentTerm && !quickTermId) {
      setQuickTermId(currentTerm.id);
    }
  }, [currentTerm, quickTermId]);

  useEffect(() => {
    setPage(1);
    setSearch(new URLSearchParams(location.search).get("search") ?? "");
    setRoleFilter("");
    setActiveFilter("");
    setDepartmentFilter("");
    setCollegeFilter("");
    setTermFilter("");
    setEdit(null);
    setRemove(null);
    setRoster(null);
    setAssignToSubject(null);
    setAssignToDoctor(null);
  }, [resource, location.search]);

  async function submitBatchAssignments(
    endpoint: string,
    payloads: Record<string, unknown>[],
    onDone: () => void,
  ) {
    setQuickBusy(true);
    try {
      await Promise.all(payloads.map((body) => action.mutateAsync({ path: endpoint, body })));
      query.refetch();
      subjects.refetch();
      onDone();
    } catch {
      // surfaced via action.error
    } finally {
      setQuickBusy(false);
    }
  }

  const titles: Record<string, string> = {
    users: "Users",
    subjects: "Subjects",
    departments: "Departments",
    terms: "Academic terms",
    sections: "Sections",
    assignments: "Assignments",
    "seb-keys": "Browser security",
    audit: "Audit log",
  };
  const title = titles[resource] ?? "Administration";
  let fields = [...(baseFields[resource] ?? [])];
  if (resource === "users")
    fields.push(
      {
        key: "collegeId",
        label: "College",
        options: pick(rowsOf(colleges.data)),
      },
      edit === "new"
        ? {
            key: "password",
            label: "Initial password",
            type: "password",
            required: true,
            hint: "At least 8 characters.",
          }
        : { key: "isActive", label: "Active account", type: "checkbox" },
      {
        key: "canChangePassword",
        label: "Allow password changes",
        type: "checkbox",
      },
    );
  if (["users", "subjects"].includes(resource))
    fields.push({
      key: "departmentId",
      label: "Department",
      options: pick(rowsOf(departments.data)),
    });
  if (resource === "departments")
    fields.push({
      key: "collegeId",
      label: "College",
      options: pick(rowsOf(colleges.data)),
    });
  if (resource === "sections")
    fields.push(
      {
        key: "subjectId",
        label: "Subject",
        required: true,
        options: pick(rowsOf(subjects.data)),
      },
      {
        key: "termId",
        label: "Academic term",
        required: true,
        options: pick(rowsOf(terms.data)),
      },
      {
        key: "taId",
        label: "Teaching assistant",
        required: true,
        options: pick(rowsOf(tasPool.data)),
      },
    );
  if (resource === "assignments")
    fields =
      assignment === "tas"
        ? [
            {
              key: "sectionId",
              label: "Section",
              required: true,
              options: pick(rowsOf(tasSections.data)),
            },
            {
              key: "taId",
              label: "Teaching assistant",
              required: true,
              options: pick(rowsOf(tasPool.data)),
            },
          ]
        : [
            {
              key: assignment === "doctors" ? "doctorId" : "studentId",
              label: assignment === "doctors" ? "Educator" : "Student",
              required: true,
              options: pick(
                rowsOf(assignment === "doctors" ? doctorsPool.data : studentsPool.data),
              ),
            },
            {
              key: "subjectId",
              label: "Subject",
              required: true,
              options: pick(rowsOf(subjects.data)),
            },
            {
              key: "termId",
              label: "Term",
              required: true,
              value: currentTerm?.id ?? "",
              options: pick(rowsOf(terms.data)),
            },
          ];

  const columns: Record<string, string[]> = {
    users: ["name", "username", "role", "department", "isActive"],
    subjects: ["code", "name", "department"],
    departments: ["code", "name", "college"],
    terms: ["name", "startsOn", "endsOn", "isCurrent"],
    sections: ["name", "subject", "ta", "term"],
    assignments:
      assignment === "tas"
        ? ["name", "subject", "ta", "term"]
        : [assignment === "doctors" ? "doctor" : "student", "subject", "term"],
    "seb-keys": ["label", "isActive", "createdAt"],
    audit: ["action", "actor", "entityType", "createdAt"],
  };
  const cols = columns[resource] ?? ["name"];
  const readOnly = resource === "audit";
  const rowList = rowsOf(query.data);

  // Group doctor assignments by Doctor or by Subject for the rich card views
  const doctorCardsData = useMemo(() => {
    if (resource !== "assignments" || assignment !== "doctors") return [];
    const assignRows = rowList as DoctorAssignmentRow[];
    const docsMap = new Map<
      string,
      {
        id: string;
        name: string;
        username: string;
        departmentName?: string;
        collegeName?: string;
        assignments: DoctorAssignmentRow[];
      }
    >();
    // Include all doctors from doctorsPool (filtered by search if active) so unassigned doctors can also be assigned subjects directly
    for (const d of rowsOf(doctorsPool.data)) {
      const q = search.trim().toLowerCase();
      const deptObj = d.department as Entity | undefined;
      const colObj = (d.collegeRef as Entity | undefined) ?? (deptObj?.college as Entity | undefined);
      if (
        q &&
        !String(d.name ?? "").toLowerCase().includes(q) &&
        !String(d.username ?? "").toLowerCase().includes(q) &&
        !String(deptObj?.name ?? "").toLowerCase().includes(q)
      ) {
        continue;
      }
      docsMap.set(d.id, {
        id: d.id,
        name: String(d.name ?? d.username),
        username: String(d.username ?? ""),
        departmentName: deptObj?.name ? String(deptObj.name) : undefined,
        collegeName: colObj?.name ? String(colObj.name) : d.college ? String(d.college) : undefined,
        assignments: [],
      });
    }
    for (const r of assignRows) {
      if (!r.doctor) continue;
      const existing = docsMap.get(r.doctor.id) ?? {
        id: r.doctor.id,
        name: r.doctor.name,
        username: r.doctor.username,
        departmentName: r.doctor.department?.name,
        collegeName: r.doctor.collegeRef?.name,
        assignments: [],
      };
      existing.assignments.push(r);
      docsMap.set(r.doctor.id, existing);
    }
    return [...docsMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [resource, assignment, rowList, doctorsPool.data, search]);

  return (
    <>
      <PageTitle
        title={title}
        description={
          resource === "audit"
            ? t("Review administrative activity and accountability.")
            : resource === "subjects"
              ? t("Course catalog, department links, question bank metrics, and assigned educators.")
              : resource === "assignments"
                ? t("Bind educators to subjects, enroll students, and assign teaching assistants.")
                : t("Manage university records and access.")
        }
        action={
          !readOnly && (
            <button
              className="primary"
              onClick={() => {
                action.reset();
                setEdit("new");
              }}
            >
              <Plus size={16} />{" "}
              {resource === "assignments"
                ? assignment === "tas"
                  ? t("Assign teaching assistant")
                  : t("Add assignment")
                : resource === "seb-keys"
                  ? t("Register browser key")
                  : t("Add {0}", {
                      "0": t(
                        resource === "terms"
                          ? "term"
                          : resource.replace(/s$/, ""),
                      ),
                    })}
            </button>
          )
        }
      />
      <div className="toolbar">
        {resource === "assignments" ? (
          <>
            <Combo
              value={assignment}
              options={[
                { value: "doctors", label: t("Educator assignments") },
                { value: "enrollments", label: t("Student enrollments") },
                { value: "tas", label: t("Teaching assistant sections") },
              ]}
              onChange={(v) => {
                setAssignment(v);
                setPage(1);
              }}
              ariaLabel={t("Assignment type")}
            />
            {assignment !== "tas" && (
              <Combo
                value={termFilter}
                options={[
                  { value: "", label: t("All terms") },
                  ...rowsOf(terms.data).map((tr) => ({
                    value: tr.id,
                    label: `${String(tr.name)}${tr.isCurrent ? ` (${t("Current")})` : ""}`,
                  })),
                ]}
                onChange={(v) => {
                  setTermFilter(v);
                  setPage(1);
                }}
                ariaLabel={t("Filter by term")}
              />
            )}
            <SearchBox
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder={
                assignment === "doctors"
                  ? t("Search educators or subjects…")
                  : assignment === "enrollments"
                    ? t("Search students or subjects…")
                    : t("Search sections…")
              }
            />
            {assignment === "doctors" && (
              <div className="segmented">
                <button
                  type="button"
                  className={assignViewMode === "doctors" ? "active" : ""}
                  onClick={() => setAssignViewMode("doctors")}
                >
                  {t("By Educator")}
                </button>
                <button
                  type="button"
                  className={assignViewMode === "subjects" ? "active" : ""}
                  onClick={() => setAssignViewMode("subjects")}
                >
                  {t("By Subject")}
                </button>
                <button
                  type="button"
                  className={assignViewMode === "table" ? "active" : ""}
                  onClick={() => setAssignViewMode("table")}
                >
                  {t("Table")}
                </button>
              </div>
            )}
          </>
        ) : (
          ["users", "subjects", "departments", "sections"].includes(
            resource,
          ) && (
            <>
              <SearchBox
                value={search}
                onChange={(v) => {
                  setSearch(v);
                  setPage(1);
                }}
                placeholder={t("Search {0}\u2026", {
                  "0": t(title.toLowerCase()),
                })}
              />
              {["subjects", "departments"].includes(resource) && (
                <Combo
                  value={collegeFilter}
                  options={[
                    { value: "", label: t("All colleges") },
                    ...rowsOf(colleges.data).map((c) => ({
                      value: c.id,
                      label: `${String(c.code)} · ${String(c.name)}`,
                    })),
                  ]}
                  onChange={(v) => {
                    setCollegeFilter(v);
                    setPage(1);
                  }}
                  ariaLabel={t("Filter college")}
                />
              )}
              {resource === "subjects" && (
                <Combo
                  value={departmentFilter}
                  options={[
                    { value: "", label: t("All departments") },
                    ...rowsOf(departments.data).map((d) => ({
                      value: d.id,
                      label: `${String(d.code)} · ${String(d.name)}`,
                    })),
                  ]}
                  onChange={(v) => {
                    setDepartmentFilter(v);
                    setPage(1);
                  }}
                  ariaLabel={t("Filter department")}
                />
              )}
            </>
          )
        )}
        <span className="subtle">
          {Array.isArray(query.data)
            ? query.data.length
            : (query.data?.total ?? 0)}{" "}
          {t(" records ")}
        </span>
      </div>
      {resource === "users" && (
        <>
          <div className="toolbar user-filters">
            <Combo
              value={roleFilter}
              options={[
                { value: "", label: t("All roles") },
                ...["student", "doctor", "ta", "admin"].map((r) => ({
                  value: r,
                  label: t(label(r)),
                })),
              ]}
              onChange={(v) => {
                setRoleFilter(v);
                setPage(1);
              }}
              ariaLabel={t("Filter user role")}
            />
            <Combo
              value={activeFilter}
              options={[
                { value: "", label: t("All account statuses") },
                { value: "true", label: t("Active") },
                { value: "false", label: t("Inactive") },
              ]}
              onChange={(v) => {
                setActiveFilter(v);
                setPage(1);
              }}
              ariaLabel={t("Filter account status")}
            />
            <Combo
              value={collegeFilter}
              options={[
                { value: "", label: t("All colleges") },
                ...rowsOf(colleges.data).map((c) => ({
                  value: c.id,
                  label: String(c.name),
                })),
              ]}
              onChange={(v) => {
                setCollegeFilter(v);
                setPage(1);
              }}
              ariaLabel={t("Filter college")}
            />
            <Combo
              value={departmentFilter}
              options={[
                { value: "", label: t("All departments") },
                ...rowsOf(departments.data).map((d) => ({
                  value: d.id,
                  label: String(d.name),
                })),
              ]}
              onChange={(v) => {
                setDepartmentFilter(v);
                setPage(1);
              }}
              ariaLabel={t("Filter department")}
            />
            <button
              className="text-button"
              onClick={() => {
                setRoleFilter("");
                setActiveFilter("");
                setCollegeFilter("");
                setDepartmentFilter("");
                setSearch("");
                setPage(1);
              }}
            >
              {t("Clear filters")}
            </button>
          </div>
          <BulkUsers
            user={user}
            rows={rowList}
            selected={selectedUsers}
            clear={(succeededIds) =>
              setSelectedUsers((prev) =>
                succeededIds === undefined
                  ? []
                  : prev.filter((id) => !succeededIds.includes(id)),
              )
            }
          />
        </>
      )}
      <Feedback error={query.error} />
      <Feedback
        error={
          !edit && !remove && !current && !assignToSubject && !assignToDoctor
            ? action.error
            : null
        }
      />
      {query.isPending ? (
        <Loading />
      ) : resource === "subjects" ? (
        rowList.length ? (
          <div className="exam-grid academic-card-grid">
            {(rowList as RichSubjectRow[]).map((subj) => {
              const docs = subj.doctorAssignments ?? [];
              return (
                <article className="exam-card academic-card" key={subj.id}>
                  <div className="exam-card-top">
                    <span className="assessment-icon">
                      <BookOpen size={18} />
                    </span>
                    <div className="card-badge-group">
                      <span className="code-pill">{subj.code}</span>
                      {subj.department?.code && (
                        <span className="dept-pill" title={subj.department.name}>
                          {subj.department.code}
                        </span>
                      )}
                      {subj.department?.college && (
                        <Link
                          to={`/colleges/${subj.department.college.id}`}
                          className="college-pill"
                          title={subj.department.college.name}
                        >
                          <Building2 size={12} /> {subj.department.college.code}
                        </Link>
                      )}
                    </div>
                  </div>
                  <h2>{subj.name}</h2>
                  <p className="card-subtitle">
                    {subj.department?.name ?? t("No department assigned")}
                  </p>
                  <div className="card-metrics-grid">
                    <div className="card-metric-pill">
                      <Users size={14} />
                      <strong>{subj._count?.enrollments ?? 0}</strong>
                      <span>{t("Enrolled")}</span>
                    </div>
                    <div className="card-metric-pill">
                      <Layers size={14} />
                      <strong>{subj._count?.sections ?? 0}</strong>
                      <span>{t("Sections")}</span>
                    </div>
                    <div className="card-metric-pill">
                      <BookOpen size={14} />
                      <strong>{subj._count?.questions ?? 0}</strong>
                      <span>{t("Questions")}</span>
                    </div>
                    <div className="card-metric-pill">
                      <strong>{subj._count?.exams ?? 0}</strong>
                      <span>{t("Exams")}</span>
                    </div>
                  </div>
                  <div className="card-educators-block">
                    <div className="card-section-header">
                      <span className="card-section-label">
                        {t("Assigned Educators")} ({docs.length})
                      </span>
                      <button
                        type="button"
                        className="chip-add-btn"
                        onClick={() => {
                          action.reset();
                          setQuickPickIds([]);
                          if (currentTerm) setQuickTermId(currentTerm.id);
                          setAssignToSubject(subj);
                        }}
                      >
                        <Plus size={12} /> {t("Assign")}
                      </button>
                    </div>
                    {docs.length > 0 ? (
                      <div className="educator-chip-list">
                        {docs.map((da) => (
                          <span
                            key={`${da.doctorId}-${da.termId}`}
                            className="educator-chip removable"
                            title={`${da.doctor.name} · ${da.term.name}`}
                          >
                            <GraduationCap size={13} />
                            <Link to={`/admin/users/${da.doctor.id}`}>
                              {da.doctor.name}
                            </Link>
                            <small>{da.term.name}</small>
                            <button
                              type="button"
                              aria-label={t("Unassign {0}", { "0": da.doctor.name })}
                              disabled={action.isPending}
                              onClick={() =>
                                action.mutate(
                                  {
                                    path: "/api/v1/admin/assignments/doctors",
                                    method: "DELETE",
                                    body: {
                                      doctorId: da.doctorId,
                                      subjectId: subj.id,
                                      termId: da.termId,
                                    },
                                  },
                                  {
                                    onSuccess: () => {
                                      query.refetch();
                                      subjects.refetch();
                                    },
                                  },
                                )
                              }
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="subtle">{t("No educators assigned yet")}</span>
                    )}
                  </div>
                  <div className="exam-card-action">
                    <button
                      type="button"
                      className="secondary small-btn"
                      onClick={() => {
                        action.reset();
                        setEdit(subj);
                      }}
                    >
                      <Pencil size={14} /> {t("Edit")}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("Delete subject")}
                      onClick={() => {
                        action.reset();
                        setRemove(subj);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <Empty
            title={t("No subjects found")}
            text={t("Add a subject or clear your filters.")}
          />
        )
      ) : resource === "assignments" &&
        assignment === "doctors" &&
        assignViewMode === "doctors" ? (
        doctorCardsData.length ? (
          <div className="exam-grid academic-card-grid">
            {doctorCardsData.map((doc) => (
              <article className="exam-card academic-card" key={doc.id}>
                <div className="exam-card-top">
                  <span className="assessment-icon">
                    <GraduationCap size={18} />
                  </span>
                  <div className="card-badge-group">
                    {doc.departmentName && (
                      <span className="dept-pill">{doc.departmentName}</span>
                    )}
                    {doc.collegeName && (
                      <span className="college-pill">
                        <Building2 size={12} /> {doc.collegeName}
                      </span>
                    )}
                  </div>
                </div>
                <small className="course-code">@{doc.username}</small>
                <h2>
                  <Link to={`/admin/users/${doc.id}`}>{doc.name}</Link>
                </h2>
                <div className="card-educators-block">
                  <div className="card-section-header">
                    <span className="card-section-label">
                      {t("Assigned Subjects")} ({doc.assignments.length})
                    </span>
                    <button
                      type="button"
                      className="chip-add-btn"
                      onClick={() => {
                        action.reset();
                        setQuickPickIds([]);
                        if (currentTerm) setQuickTermId(currentTerm.id);
                        setAssignToDoctor({
                          id: doc.id,
                          name: doc.name,
                          username: doc.username,
                          assignedSubjectIds: doc.assignments.map((a) => a.subjectId),
                        });
                      }}
                    >
                      <Plus size={12} /> {t("Assign subjects")}
                    </button>
                  </div>
                  {doc.assignments.length > 0 ? (
                    <div className="educator-chip-list">
                      {doc.assignments.map((a) => (
                        <span
                          key={`${a.doctorId}-${a.subjectId}-${a.termId}`}
                          className="subject-assign-chip removable"
                          title={`${a.subject.name} · ${a.term.name}`}
                        >
                          <b>{a.subject.code}</b>
                          <span>{a.subject.name}</span>
                          <small>{a.term.name}</small>
                          <button
                            type="button"
                            aria-label={t("Unassign {0}", { "0": a.subject.code })}
                            disabled={action.isPending}
                            onClick={() =>
                              action.mutate(
                                {
                                  path: "/api/v1/admin/assignments/doctors",
                                  method: "DELETE",
                                  body: {
                                    doctorId: a.doctorId,
                                    subjectId: a.subjectId,
                                    termId: a.termId,
                                  },
                                },
                                {
                                  onSuccess: () => {
                                    query.refetch();
                                    subjects.refetch();
                                  },
                                },
                              )
                            }
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="subtle">
                      {t("No subjects assigned for the selected term filter.")}
                    </span>
                  )}
                </div>
                <div className="exam-card-action">
                  <Link className="button secondary small-btn" to={`/admin/users/${doc.id}`}>
                    {t("Educator profile")} <ArrowUpRight size={14} />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty title={t("No educators found")} />
        )
      ) : resource === "assignments" &&
        assignment === "doctors" &&
        assignViewMode === "subjects" ? (
        rowsOf(subjects.data).length ? (
          <div className="exam-grid academic-card-grid">
            {rowsOf(subjects.data)
              .filter(
                (s) =>
                  !search.trim() ||
                  s.code.toLowerCase().includes(search.trim().toLowerCase()) ||
                  s.name.toLowerCase().includes(search.trim().toLowerCase()),
              )
              .map((subj) => {
                const docs = (subj.doctorAssignments ?? []).filter(
                  (da) => !termFilter || da.termId === termFilter,
                );
                return (
                  <article className="exam-card academic-card" key={subj.id}>
                    <div className="exam-card-top">
                      <span className="assessment-icon">
                        <BookOpen size={18} />
                      </span>
                      <div className="card-badge-group">
                        <span className="code-pill">{subj.code}</span>
                        {subj.department?.code && (
                          <span className="dept-pill">{subj.department.code}</span>
                        )}
                      </div>
                    </div>
                    <h2>{subj.name}</h2>
                    <div className="card-educators-block">
                      <div className="card-section-header">
                        <span className="card-section-label">
                          {t("Educators")} ({docs.length})
                        </span>
                        <button
                          type="button"
                          className="chip-add-btn"
                          onClick={() => {
                            action.reset();
                            setQuickPickIds([]);
                            if (currentTerm) setQuickTermId(currentTerm.id);
                            setAssignToSubject(subj);
                          }}
                        >
                          <Plus size={12} /> {t("Assign educator")}
                        </button>
                      </div>
                      {docs.length > 0 ? (
                        <div className="educator-chip-list">
                          {docs.map((da) => (
                            <span
                              key={`${da.doctorId}-${da.termId}`}
                              className="educator-chip removable"
                            >
                              <GraduationCap size={13} />
                              <Link to={`/admin/users/${da.doctor.id}`}>
                                {da.doctor.name}
                              </Link>
                              <small>{da.term.name}</small>
                              <button
                                type="button"
                                aria-label={t("Unassign {0}", { "0": da.doctor.name })}
                                disabled={action.isPending}
                                onClick={() =>
                                  action.mutate(
                                    {
                                      path: "/api/v1/admin/assignments/doctors",
                                      method: "DELETE",
                                      body: {
                                        doctorId: da.doctorId,
                                        subjectId: subj.id,
                                        termId: da.termId,
                                      },
                                    },
                                    {
                                      onSuccess: () => {
                                        query.refetch();
                                        subjects.refetch();
                                      },
                                    },
                                  )
                                }
                              >
                                <X size={12} />
                              </button>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="subtle">{t("No educators assigned")}</span>
                      )}
                    </div>
                  </article>
                );
              })}
          </div>
        ) : (
          <Empty title={t("No subjects found")} />
        )
      ) : rowList.length ? (
        <section className="panel table-wrap">
          <table>
            <thead>
              <tr>
                {resource === "users" && (
                  <th scope="col">
                    <input
                      type="checkbox"
                      aria-label={t("Select eligible accounts on this page")}
                      disabled={
                        !rowList.some(
                          (r) => r.role !== "admin" && r.id !== user.id,
                        )
                      }
                      checked={
                        rowList.some(
                          (r) => r.role !== "admin" && r.id !== user.id,
                        ) &&
                        rowList
                          .filter((r) => r.role !== "admin" && r.id !== user.id)
                          .every((r) => selectedUsers.includes(r.id))
                      }
                      onChange={(e) =>
                        setSelectedUsers(
                          e.target.checked
                            ? rowList
                                .filter(
                                  (r) => r.role !== "admin" && r.id !== user.id,
                                )
                                .map((r) => r.id)
                            : [],
                        )
                      }
                    />
                  </th>
                )}
                {cols.map((c) => (
                  <th scope="col" key={c}>
                    {t(label(c.replace(/([A-Z])/g, " $1")))}
                  </th>
                ))}
                {!readOnly && <th scope="col">{t("Actions")}</th>}
              </tr>
            </thead>
            <tbody>
              {rowList.map((r, i) => (
                <tr key={r.id ?? `${r.doctorId ?? r.studentId}-${r.subjectId}-${r.termId}-${i}`}>
                  {resource === "users" && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={t("Select {0}", {
                          "0": String(r.name ?? r.username),
                        })}
                        disabled={r.role === "admin" || r.id === user.id}
                        checked={selectedUsers.includes(r.id)}
                        onChange={(e) =>
                          setSelectedUsers((prev) =>
                            e.target.checked
                              ? [...prev, r.id]
                              : prev.filter((id) => id !== r.id),
                          )
                        }
                      />
                    </td>
                  )}
                  {cols.map((c) => (
                    <td key={c}>
                      {["isActive", "isCurrent"].includes(c) ? (
                        <Badge
                          value={
                            r[c]
                              ? c === "isCurrent"
                                ? "current"
                                : "active"
                              : "inactive"
                          }
                        />
                      ) : c === "role" ? (
                        <Badge value={r[c]} />
                      ) : c.endsWith("At") ||
                        ["startsOn", "endsOn"].includes(c) ? (
                        date(r[c])
                      ) : c === "name" ? (
                        <b>{display(r[c])}</b>
                      ) : (
                        display(r[c])
                      )}
                    </td>
                  ))}
                  {!readOnly && (
                    <td>
                      <div className="action-row">
                        {resource === "sections" && (
                          <button
                            className="text-button"
                            onClick={() => {
                              action.reset();
                              setRoster(r);
                            }}
                          >
                            {t(" Roster ")}
                          </button>
                        )}
                        {resource === "users" && (
                          <>
                            <Link
                              className="icon-button"
                              aria-label={t("User details")}
                              to={"/admin/users/" + r.id}
                            >
                              <ArrowUpRight size={16} />
                            </Link>
                            <button
                              className="text-button"
                              onClick={() => {
                                action.reset();
                                setResetSuccess("");
                                setResetMismatch("");
                                setResetUser(r);
                              }}
                            >
                              {t("Reset pw")}
                            </button>
                          </>
                        )}
                        {resource === "terms" ? (
                          !r.isCurrent && (
                            <button
                              className="text-button"
                              onClick={() => setCurrent(r)}
                            >
                              {t(" Make current ")}
                            </button>
                          )
                        ) : resource === "seb-keys" ? (
                          <button
                            className="text-button"
                            onClick={() =>
                              action.mutate({
                                path: path + "/" + r.id,
                                method: "PATCH",
                                body: { isActive: !r.isActive },
                              })
                            }
                          >
                            {r.isActive ? t("Deactivate") : t("Activate")}
                          </button>
                        ) : (
                          resource !== "assignments" && (
                            <button
                              className="icon-button"
                              aria-label={t("Edit record")}
                              onClick={() => {
                                action.reset();
                                setEdit(r);
                              }}
                            >
                              <Pencil size={15} />
                            </button>
                          )
                        )}
                        {!["users", "terms", "seb-keys"].includes(resource) &&
                          !(
                            resource === "assignments" && assignment === "tas"
                          ) && (
                          <button
                            className="icon-button"
                            aria-label={t("Delete record")}
                            onClick={() => {
                              action.reset();
                              setRemove(r);
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <Empty title={t("No records found")} />
      )}
      {!Array.isArray(query.data) && (
        <Pagination data={query.data} page={page} setPage={setPage} />
      )}{" "}
      {assignToSubject && (
        <Dialog
          title={t("Assign educators to {0} ({1})", {
            "0": assignToSubject.name,
            "1": assignToSubject.code,
          })}
          onClose={() => !quickBusy && setAssignToSubject(null)}
        >
          <div className="field">
            <span className="field-label">{t("Academic term")}</span>
            <Combo
              value={quickTermId}
              options={rowsOf(terms.data).map((tr) => ({
                value: tr.id,
                label: `${String(tr.name)}${tr.isCurrent ? ` (${t("Current")})` : ""}`,
              }))}
              onChange={setQuickTermId}
              placeholder={t("Select term…")}
              ariaLabel={t("Academic term")}
            />
          </div>
          <div className="field">
            <span className="field-label">{t("Educators (Doctors)")}</span>
            <MultiPicker
              options={rowsOf(doctorsPool.data).map((d) => ({
                id: d.id,
                name: String(d.name ?? d.username),
                username: String(d.username ?? ""),
                sub: (d.department as Entity | undefined)?.code
                  ? String((d.department as Entity).code)
                  : undefined,
              }))}
              value={quickPickIds}
              onChange={setQuickPickIds}
              placeholder={t("Search doctors by name or username…")}
              emptyText={t("No doctors found.")}
            />
          </div>
          <Feedback error={action.error} />
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={quickBusy}
              onClick={() => setAssignToSubject(null)}
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!quickTermId || !quickPickIds.length || quickBusy}
              onClick={() =>
                void submitBatchAssignments(
                  "/api/v1/admin/assignments/doctors",
                  quickPickIds.map((doctorId) => ({
                    doctorId,
                    subjectId: assignToSubject.id,
                    termId: quickTermId,
                  })),
                  () => setAssignToSubject(null),
                )
              }
            >
              {quickBusy ? t("Assigning…") : t("Assign selected educators")}
            </button>
          </div>
        </Dialog>
      )}
      {assignToDoctor && (
        <Dialog
          title={t("Assign subjects to {0}", { "0": assignToDoctor.name })}
          onClose={() => !quickBusy && setAssignToDoctor(null)}
        >
          <div className="field">
            <span className="field-label">{t("Academic term")}</span>
            <Combo
              value={quickTermId}
              options={rowsOf(terms.data).map((tr) => ({
                value: tr.id,
                label: `${String(tr.name)}${tr.isCurrent ? ` (${t("Current")})` : ""}`,
              }))}
              onChange={setQuickTermId}
              placeholder={t("Select term…")}
              ariaLabel={t("Academic term")}
            />
          </div>
          <div className="field">
            <span className="field-label">{t("Subjects")}</span>
            <MultiPicker
              options={rowsOf(subjects.data).map((s) => ({
                id: s.id,
                name: s.name,
                sub: s.code,
              }))}
              value={quickPickIds}
              onChange={setQuickPickIds}
              placeholder={t("Search subjects by code or name…")}
              emptyText={t("No subjects found.")}
            />
          </div>
          <Feedback error={action.error} />
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={quickBusy}
              onClick={() => setAssignToDoctor(null)}
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!quickTermId || !quickPickIds.length || quickBusy}
              onClick={() =>
                void submitBatchAssignments(
                  "/api/v1/admin/assignments/doctors",
                  quickPickIds.map((subjectId) => ({
                    doctorId: assignToDoctor.id,
                    subjectId,
                    termId: quickTermId,
                  })),
                  () => setAssignToDoctor(null),
                )
              }
            >
              {quickBusy ? t("Assigning…") : t("Assign selected subjects")}
            </button>
          </div>
        </Dialog>
      )}
      {roster && (
        <Dialog
          title={t("{0} \u00B7 Roster", { "0": roster.name })}
          onClose={() => setRoster(null)}
        >
          <RosterEditor user={user} sectionId={String(roster.id)} />
        </Dialog>
      )}
      {edit && (
        <Dialog
          title={edit === "new" ? t("Add record") : t("Edit record")}
          onClose={() => setEdit(null)}
        >
          <FieldsForm
            key={resource + String(edit === "new")}
            fields={
              edit !== "new" && resource === "sections"
                ? fields.filter((f) => ["name", "taId"].includes(f.key))
                : fields
            }
            initial={edit === "new" ? {} : edit}
            busy={action.isPending}
            error={action.error}
            onSubmit={(body) => {
              if (resource === "assignments" && assignment === "tas") {
                const sectionId = String(body.sectionId ?? "");
                if (!sectionId) return;
                action.mutate(
                  {
                    path: `/api/v1/admin/sections/${sectionId}`,
                    method: "PATCH",
                    body: { taId: body.taId },
                  },
                  { onSuccess: () => setEdit(null) },
                );
                return;
              }
              action.mutate(
                {
                  path: path + (edit === "new" ? "" : "/" + edit.id),
                  method: edit === "new" ? "POST" : "PATCH",
                  body,
                },
                { onSuccess: () => setEdit(null) },
              );
            }}
          />
        </Dialog>
      )}
      {resetUser && (
        <Dialog
          title={t("Reset password for {0}", {
            "0": String(resetUser.name ?? resetUser.username ?? ""),
          })}
          onClose={() => setResetUser(null)}
        >
          <FieldsForm
            fields={[
              {
                key: "password",
                label: "New password",
                type: "password",
                required: true,
                hint: "At least 8 characters. Share the password securely with the user.",
              },
              {
                key: "confirmPassword",
                label: "Confirm new password",
                type: "password",
                required: true,
              },
            ]}
            busy={action.isPending}
            error={resetMismatch || action.error}
            submitLabel={t("Reset password")}
            onSubmit={(body) => {
              setResetMismatch("");
              if (body.password !== body.confirmPassword) {
                setResetMismatch("Passwords do not match.");
                return;
              }
              action.mutate(
                {
                  path: `/api/v1/admin/users/${resetUser.id}/reset-password`,
                  body: { password: body.password },
                },
                {
                  onSuccess: () => {
                    setResetSuccess(
                      `Password reset for ${String(resetUser.name ?? resetUser.username ?? "user")}.`,
                    );
                    setResetUser(null);
                  },
                },
              );
            }}
          />
        </Dialog>
      )}
      <Success message={resetSuccess} />
      {remove && (
        <Confirm
          title={t("Delete record?")}
          text={t(
            "This cannot be undone. The server protects records that are still referenced by assessments.",
          )}
          onClose={() => setRemove(null)}
          error={action.error}
          busy={action.isPending}
          onConfirm={() =>
            action.mutate(
              {
                path:
                  path + (resource === "assignments" ? "" : "/" + remove.id),
                method: "DELETE",
                body:
                  resource === "assignments"
                    ? Object.fromEntries(
                        ["doctorId", "studentId", "subjectId", "termId"]
                          .filter((k) => remove[k])
                          .map((k) => [k, remove[k]]),
                      )
                    : undefined,
              },
              { onSuccess: () => setRemove(null) },
            )
          }
        />
      )}{" "}
      {current && (
        <Confirm
          title={t("Change current term?")}
          text={t(
            "Make {0} the current academic term? This changes which assignments and exams are current.",
            { "0": current.name },
          )}
          onClose={() => setCurrent(null)}
          busy={action.isPending}
          error={action.error}
          onConfirm={() =>
            action.mutate(
              { path: path + "/" + current.id + "/make-current" },
              { onSuccess: () => setCurrent(null) },
            )
          }
        />
      )}
    </>
  );
}

export function UserDetail({ user }: { user: SessionUser }) {
  const t = useT();
  const { id } = useParams();
  const query = useResource<Entity>(user, `/api/v1/admin/users/${id}`);
  const permissions = useResource<{
    effective: {
      key: string;
      allowed: boolean;
      overridden: boolean;
    }[];
  }>(user, `/api/v1/admin/permissions/user/${id}`);
  const sessions = useResource<Entity[]>(
    user,
    `/api/v1/admin/users/${id}/sessions`,
  );
  const subjects = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/subjects?limit=100",
  );
  const terms = useResource<Entity[]>(user, "/api/v1/admin/terms");
  const departments = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/departments?limit=100",
  );
  const colleges = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/colleges?limit=100",
  );
  const doctorAssignments = useResource<Envelope<Entity> | Entity[]>(
    user,
    `/api/v1/admin/assignments/doctors?doctor_id=${id}&limit=100`,
    !!id,
  );
  const enrollments = useResource<Envelope<Entity> | Entity[]>(
    user,
    `/api/v1/admin/assignments/enrollments?student_id=${id}&limit=100`,
    !!id,
  );
  const taSections = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/sections?limit=100",
  );
  const action = useAction(user, [
    "/api/v1/admin/users",
    `/api/v1/admin/users/${id}`,
    "/api/v1/admin/permissions",
    "/api/v1/admin/assignments/doctors",
    "/api/v1/admin/assignments/enrollments",
    "/api/v1/admin/sections",
  ]);
  const [reset, setReset] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const [editProfile, setEditProfile] = useState(false);
  const [resetMismatch, setResetMismatch] = useState("");
  const [profileDone, setProfileDone] = useState("");
  const [resetDone, setResetDone] = useState("");
  const [docSubjects, setDocSubjects] = useState<string[]>([]);
  const [docTerm, setDocTerm] = useState("");
  const [stuSubjects, setStuSubjects] = useState<string[]>([]);
  const [stuTerm, setStuTerm] = useState("");
  const [taSection, setTaSection] = useState("");
  const [assignDone, setAssignDone] = useState("");

  useEffect(() => {
    const cur = rowsOf(terms.data).find((x) => Boolean(x.isCurrent)) ?? rowsOf(terms.data)[0];
    if (cur) {
      if (!docTerm) setDocTerm(cur.id);
      if (!stuTerm) setStuTerm(cur.id);
    }
  }, [terms.data, docTerm, stuTerm]);

  async function addMany(path: string, bodies: Record<string, unknown>[], done: string, clear: () => void) {
    setAssignDone("");
    try {
      await Promise.all(bodies.map((body) => action.mutateAsync({ path, body })));
      doctorAssignments.refetch();
      enrollments.refetch();
      clear();
      setAssignDone(done);
    } catch {
      // action.error surfaces through the top Feedback + inline below
    }
  }
  const role = String(query.data?.role ?? "");
  const myDoctorRows = rowsOf(doctorAssignments.data).filter(
    (a) => a.doctorId === id || (a.doctor as Entity)?.id === id,
  );
  const myEnrollmentRows = rowsOf(enrollments.data).filter(
    (a) => a.studentId === id || (a.student as Entity)?.id === id,
  );
  const myTaSections = rowsOf(taSections.data).filter((s) => s.taId === id);
  return (
    <>
      <PageTitle
        title={query.data?.name ?? t("User details")}
        description={t("Account access, permissions, and active sessions.")}
      />
      <Link className="back-link" to="/admin/users">
        {t(" \u2190 Back to users ")}
      </Link>
      <Feedback error={query.error} />
      <Feedback error={!reset && !revoke && !editProfile ? action.error : null} />
      <Success message={profileDone} />
      <Success message={resetDone} />
      <Success message={assignDone} />
      {query.data && (
        <>
          <div className="profile-grid">
            <section className="panel">
              <h2>{t("Account")}</h2>
              <dl className="details-list">
                {["username", "email", "role", "college", "department", "academicYear"].map(
                  (k) => (
                    <div key={k}>
                      <dt>{t(label(k))}</dt>
                      <dd>
                        {k === "role"
                          ? t(label(query.data?.[k]))
                          : display(query.data?.[k])}
                      </dd>
                    </div>
                  ),
                )}
              </dl>
              <div className="action-row">
                <button
                  className="secondary"
                  onClick={() => {
                    action.reset();
                    setProfileDone("");
                    setEditProfile(true);
                  }}
                >
                  {t(" Edit profile ")}
                </button>
                <button className="secondary" onClick={() => setReset(true)}>
                  {t(" Reset password ")}
                </button>
                <button
                  className="secondary"
                  disabled={id === user.id || action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/api/v1/admin/users/${id}`,
                      method: "PATCH",
                      body: { isActive: !query.data?.isActive },
                    })
                  }
                >
                  {query.data.isActive
                    ? t("Disable account")
                    : t("Enable account")}
                </button>
              </div>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>{t("Active sessions")}</h2>
                  <p>{t("Revoking sessions signs the user out.")}</p>
                </div>
                <button className="text-button" onClick={() => setRevoke(true)}>
                  {t(" Revoke all ")}
                </button>
              </div>
              <Feedback error={sessions.error} />
              {sessions.data?.length ? (
                sessions.data.map((s) => (
                  <div className="session-row" key={s.id}>
                    <span>{String(s.ipAddress ?? "Session")}</span>
                    <small>
                      {t("Expires ")}
                      {date(s.expiresAt)}
                    </small>
                  </div>
                ))
              ) : (
                <Empty title={t("No active sessions")} />
              )}
            </section>
          </div>
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>{t("Assignments")}</h2>
                <p>
                  {t(
                    "Teaching subjects, student enrollments, and assistant sections for this account.",
                  )}
                </p>
              </div>
            </div>
            <Feedback
              error={
                doctorAssignments.error ||
                enrollments.error ||
                taSections.error
              }
            />
            {role === "doctor" && (
              <>
                {myDoctorRows.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">{t("Subject")}</th>
                          <th scope="col">{t("Term")}</th>
                          <th scope="col">{t("Actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {myDoctorRows.map((a, i) => (
                          <tr key={String(a.id ?? `${a.subjectId}-${a.termId}-${i}`)}>
                            <td>
                              <b>{String((a.subject as Entity)?.code ?? "")}</b>{" "}
                              {display(a.subject)}
                            </td>
                            <td>{display(a.term)}</td>
                            <td>
                              <button
                                className="text-button"
                                disabled={action.isPending}
                                onClick={() =>
                                  action.mutate(
                                    {
                                      path: "/api/v1/admin/assignments/doctors",
                                      method: "DELETE",
                                      body: Object.fromEntries(
                                        ["doctorId", "subjectId", "termId"]
                                          .filter((k) => a[k])
                                          .map((k) => [k, a[k]]),
                                      ),
                                    },
                                    { onSuccess: () => doctorAssignments.refetch() },
                                  )
                                }
                              >
                                {t("Remove")}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title={t("No teaching assignments")} />
                )}
                <h3 className="subtle">{t("Add teaching assignment")}</h3>
                <p className="subtle">
                  {t("Pick a term, tick one or more subjects, add them all at once.")}
                </p>
                <div className="field">
                  <span className="field-label">{t("Term")}</span>
                  <Combo
                    value={docTerm}
                    options={rowsOf(terms.data).map((x) => ({
                      value: x.id,
                      label: String(x.name ?? x.id),
                    }))}
                    onChange={setDocTerm}
                    placeholder="Search terms…"
                    ariaLabel={t("Term")}
                  />
                </div>
                <MultiPicker
                  options={rowsOf(subjects.data).map((x) => ({
                    id: x.id,
                    name: String(x.name ?? x.id),
                    sub: String((x as Entity).code ?? ""),
                  }))}
                  value={docSubjects}
                  onChange={setDocSubjects}
                  placeholder="Search subjects…"
                  emptyText="No subjects found."
                />
                <Feedback error={action.error} />
                <button
                  className="secondary"
                  disabled={!docTerm || !docSubjects.length || action.isPending}
                  onClick={() =>
                    void addMany(
                      "/api/v1/admin/assignments/doctors",
                      docSubjects.map((subjectId) => ({ doctorId: id, subjectId, termId: docTerm })),
                      t("Teaching assignments added."),
                      () => {
                        setDocSubjects([]);
                      },
                    )
                  }
                >
                  {t("Add assignments")}
                </button>
              </>
            )}
            {role === "student" && (
              <>
                {myEnrollmentRows.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">{t("Subject")}</th>
                          <th scope="col">{t("Term")}</th>
                          <th scope="col">{t("Actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {myEnrollmentRows.map((a, i) => (
                          <tr key={String(a.id ?? `${a.subjectId}-${a.termId}-${i}`)}>
                            <td>
                              <b>{String((a.subject as Entity)?.code ?? "")}</b>{" "}
                              {display(a.subject)}
                            </td>
                            <td>{display(a.term)}</td>
                            <td>
                              <button
                                className="text-button"
                                disabled={action.isPending}
                                onClick={() =>
                                  action.mutate(
                                    {
                                      path: "/api/v1/admin/assignments/enrollments",
                                      method: "DELETE",
                                      body: Object.fromEntries(
                                        ["studentId", "subjectId", "termId"]
                                          .filter((k) => a[k])
                                          .map((k) => [k, a[k]]),
                                      ),
                                    },
                                    { onSuccess: () => enrollments.refetch() },
                                  )
                                }
                              >
                                {t("Remove")}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title={t("No enrollments")} />
                )}
                <h3 className="subtle">{t("Add enrollment")}</h3>
                <p className="subtle">
                  {t("Pick a term, tick one or more subjects, add them all at once.")}
                </p>
                <div className="field">
                  <span className="field-label">{t("Term")}</span>
                  <Combo
                    value={stuTerm}
                    options={rowsOf(terms.data).map((x) => ({
                      value: x.id,
                      label: String(x.name ?? x.id),
                    }))}
                    onChange={setStuTerm}
                    placeholder="Search terms…"
                    ariaLabel={t("Term")}
                  />
                </div>
                <MultiPicker
                  options={rowsOf(subjects.data).map((x) => ({
                    id: x.id,
                    name: String(x.name ?? x.id),
                    sub: String((x as Entity).code ?? ""),
                  }))}
                  value={stuSubjects}
                  onChange={setStuSubjects}
                  placeholder="Search subjects…"
                  emptyText="No subjects found."
                />
                <Feedback error={action.error} />
                <button
                  className="secondary"
                  disabled={!stuTerm || !stuSubjects.length || action.isPending}
                  onClick={() =>
                    void addMany(
                      "/api/v1/admin/assignments/enrollments",
                      stuSubjects.map((subjectId) => ({ studentId: id, subjectId, termId: stuTerm })),
                      t("Enrollments added."),
                      () => {
                        setStuSubjects([]);
                      },
                    )
                  }
                >
                  {t("Add enrollments")}
                </button>
              </>
            )}
            {role === "ta" && (
              <>
                {myTaSections.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">{t("Section")}</th>
                          <th scope="col">{t("Subject")}</th>
                          <th scope="col">{t("Term")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {myTaSections.map((s) => (
                          <tr key={s.id}>
                            <td>
                              <b>{display(s.name)}</b>
                            </td>
                            <td>{display(s.subject)}</td>
                            <td>{display(s.term)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty title={t("No section assignments")} />
                )}
                <h3 className="subtle">{t("Assign section")}</h3>
                <Combo
                  value={taSection}
                  options={rowsOf(taSections.data).map((x) => ({
                    value: x.id,
                    label: String(x.name ?? x.id),
                    sub: String((x.subject as Entity)?.code ?? (x.subject as Entity)?.name ?? ""),
                  }))}
                  onChange={setTaSection}
                  placeholder="Search sections…"
                  ariaLabel={t("Section")}
                />
                <Feedback error={action.error} />
                <button
                  className="secondary"
                  disabled={!taSection || action.isPending}
                  onClick={() =>
                    action.mutate(
                      {
                        path: `/api/v1/admin/sections/${taSection}`,
                        method: "PATCH",
                        body: { taId: id },
                      },
                      {
                        onSuccess: () => {
                          setTaSection("");
                          taSections.refetch();
                        },
                      },
                    )
                  }
                >
                  {t("Assign section")}
                </button>
              </>
            )}
            {!["doctor", "student", "ta"].includes(role) && (
              <Empty title={t("No assignments for this role")} />
            )}
          </section>
          <section className="panel">
            <h2>{t("Effective permissions")}</h2>
            <p className="subtle">
              {t(
                " Overrides apply immediately. The API is authoritative for all access checks. ",
              )}
            </p>
            <Feedback error={permissions.error} />
            <div className="permissions-grid">
              {permissions.data?.effective.map((p) => (
                <div className="permission-row" key={p.key}>
                  <label>
                    <input
                      type="checkbox"
                      checked={p.allowed}
                      disabled={action.isPending}
                      onChange={(e) =>
                        action.mutate({
                          path: `/api/v1/admin/permissions/user/${id}`,
                          method: "PATCH",
                          body: { key: p.key, allowed: e.target.checked },
                        })
                      }
                    />
                    {t(label(p.key))}
                  </label>
                  {p.overridden && (
                    <button
                      className="text-button"
                      onClick={() =>
                        action.mutate({
                          path: `/api/v1/admin/permissions/user/${id}/${p.key}`,
                          method: "DELETE",
                        })
                      }
                    >
                      {t(" Reset default ")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      {editProfile && (
        <Dialog
          title={t("Edit profile")}
          onClose={() => {
            if (!action.isPending) setEditProfile(false);
          }}
        >
          <FieldsForm
            fields={[
              { key: "name", label: "Full name", required: true },
              { key: "username", label: "Username", required: true },
              { key: "email", label: "Email", type: "email" },
              {
                key: "role",
                label: "Role",
                required: true,
                options: options(["student", "doctor", "ta", "admin"]),
              },
              {
                key: "academicYear",
                label: "Academic year",
                type: "number",
                min: 1,
              },
              {
                key: "collegeId",
                label: "College",
                options: pick(rowsOf(colleges.data)),
              },
              {
                key: "departmentId",
                label: "Department",
                options: pick(rowsOf(departments.data)),
              },
              { key: "isActive", label: "Active account", type: "checkbox" },
              {
                key: "canChangePassword",
                label: "Allow password changes",
                type: "checkbox",
              },
            ]}
            initial={query.data ?? {}}
            busy={action.isPending}
            error={action.error}
            onSubmit={(body) =>
              action.mutate(
                { path: `/api/v1/admin/users/${id}`, method: "PATCH", body },
                {
                  onSuccess: () => {
                    setEditProfile(false);
                    setProfileDone("Profile updated.");
                  },
                },
              )
            }
          />
        </Dialog>
      )}
      {reset && (
        <Dialog
          title={t("Reset password")}
          onClose={() => {
            if (!action.isPending) {
              setReset(false);
              setResetMismatch("");
            }
          }}
        >
          <FieldsForm
            fields={[
              {
                key: "password",
                label: "New password",
                type: "password",
                required: true,
                hint: "At least 8 characters. Share the password securely with the user.",
              },
              {
                key: "confirmPassword",
                label: "Confirm new password",
                type: "password",
                required: true,
              },
            ]}
            onSubmit={(body) => {
              setResetMismatch("");
              if (body.password !== body.confirmPassword) {
                setResetMismatch("Passwords do not match.");
                return;
              }
              action.mutate(
                {
                  path: `/api/v1/admin/users/${id}/reset-password`,
                  body: { password: body.password },
                },
                {
                  onSuccess: () => {
                    setReset(false);
                    setResetDone("Password reset.");
                  },
                },
              );
            }}
            busy={action.isPending}
            error={resetMismatch || action.error}
            submitLabel={t("Reset password")}
          />
        </Dialog>
      )}
      {revoke && (
        <Confirm
          title={t("Revoke all sessions?")}
          text={t("The user will need to sign in again on every device.")}
          onClose={() => setRevoke(false)}
          onConfirm={() =>
            action.mutate(
              { path: `/api/v1/admin/users/${id}/sessions`, method: "DELETE" },
              { onSuccess: () => setRevoke(false) },
            )
          }
          error={action.error}
          busy={action.isPending}
        />
      )}
    </>
  );
}
