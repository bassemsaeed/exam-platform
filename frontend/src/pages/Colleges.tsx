import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowUpRight,
  BookOpen,
  Building2,
  GraduationCap,
  Layers,
  Plus,
  Users,
} from "lucide-react";
import { useT } from "../lib/i18n";
import {
  useResource,
  useAction,
  rowsOf,
  type Entity,
  type Envelope,
} from "../lib/platform";
import type { SessionUser } from "../lib/api";
import {
  PageTitle,
  Badge,
  Feedback,
  Empty,
  Loading,
  Dialog,
  FieldsForm,
  Confirm,
  Pagination,
  SearchBox,
} from "../components/ui";
import { Combo } from "../components/builder";

interface CollegeDeptInfo {
  id: string;
  code: string;
  name: string;
  collegeId?: string | null;
  _count?: { users: number; subjects: number };
}

interface College extends Entity {
  code: string;
  name: string;
  students?: number;
  doctors?: number;
  subjects?: number;
  departments?: CollegeDeptInfo[] | number;
}

interface CollegeSubject extends Entity {
  code: string;
  name: string;
  department?: { id: string; name: string; code?: string } | null;
  _count?: { questions: number; exams: number; enrollments: number; sections?: number };
  doctorAssignments?: {
    doctorId: string;
    termId: string;
    doctor: { id: string; name: string; username: string };
    term: { id: string; name: string };
  }[];
}

interface CollegeDoctor extends Entity {
  username: string;
  name: string;
  email?: string;
  isActive?: boolean;
  department?: { id: string; code: string; name: string } | null;
  doctorAssignments?: {
    subjectId: string;
    termId: string;
    subject: { id: string; code: string; name: string };
    term: { id: string; name: string };
  }[];
}

interface CollegeDetailData extends Entity {
  code: string;
  name: string;
  students?: number;
  doctors?: number;
  departments?: CollegeDeptInfo[] | number;
  years: { year: number | null; students: number }[];
  subjects?: CollegeSubject[];
  subjectTotal?: number;
  subjectsTruncated?: boolean;
  doctorsList?: CollegeDoctor[];
}

interface CollegeStudent extends Entity {
  username?: string;
  name: string;
  email?: string;
  isActive?: boolean;
  academicYear?: number | null;
  department?: { id: string; name: string } | null;
  collegeRef?: { id: string; name: string } | null;
}

export function Colleges({ user }: { user: SessionUser }) {
  const t = useT();
  const query = useResource<Envelope<College>>(user, "/api/v1/admin/colleges?limit=100");
  const action = useAction(user, ["/api/v1/admin/colleges"]);
  const [modal, setModal] = useState(false);
  const [q, setQ] = useState("");
  const search = useResource<CollegeStudent[]>(
    user,
    `/api/v1/admin/colleges/students/search?q=${encodeURIComponent(q)}`,
    q.trim().length > 1,
  );
  const allColleges = rowsOf(query.data);
  const filteredColleges = q.trim()
    ? allColleges.filter(
        (c) =>
          c.name.toLowerCase().includes(q.trim().toLowerCase()) ||
          c.code.toLowerCase().includes(q.trim().toLowerCase()),
      )
    : allColleges;

  return (
    <>
      <PageTitle
        title={t("Colleges")}
        description={t("Faculties, academic departments, educators, and enrolled cohorts.")}
        action={
          <button
            className="primary"
            onClick={() => {
              action.reset();
              setModal(true);
            }}
          >
            <Plus size={16} /> {t(" New college ")}
          </button>
        }
      />
      <div className="toolbar">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder={t("Filter colleges or find a student by name / username…")}
        />
        <span className="subtle">
          {filteredColleges.length} {t("colleges")}
        </span>
      </div>
      {q.trim().length > 1 && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{t("Matching students across colleges")}</h2>
            </div>
          </div>
          <Feedback error={search.error} />
          {search.isPending ? (
            <Loading />
          ) : search.data?.length ? (
            <div className="assessment-list">
              {search.data.map((s) => (
                <Link key={s.id} to={`/admin/users/${s.id}`}>
                  <span className="assessment-icon">
                    <Users size={17} />
                  </span>
                  <div>
                    <b>{s.name}</b>
                    <small>
                      {s.username} ·{" "}
                      {s.collegeRef?.name ?? t("No college")}
                      {s.academicYear ? ` · ${t("Year")} ${s.academicYear}` : ""}
                    </small>
                  </div>
                  <Badge value={s.isActive ? "active" : "inactive"} />
                </Link>
              ))}
            </div>
          ) : (
            !search.error && (
              <Empty
                title={t("No students found")}
                text={t("Try a different name or username.")}
              />
            )
          )}
        </section>
      )}
      <Feedback error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : filteredColleges.length ? (
        <div className="exam-grid academic-card-grid">
          {filteredColleges.map((c) => {
            const deptCount = typeof c.departments === "number" ? c.departments : (c.departments?.length ?? 0);
            return (
              <article className="exam-card academic-card" key={c.id}>
                <div className="exam-card-top">
                  <span className="assessment-icon">
                    <Building2 size={18} />
                  </span>
                  <span className="code-pill">{c.code}</span>
                </div>
                <h2>
                  <Link to={`/colleges/${c.id}`}>{c.name}</Link>
                </h2>
                <div className="card-metrics-grid">
                  <div className="card-metric-pill">
                    <Users size={14} />
                    <strong>{c.students ?? 0}</strong>
                    <span>{t("Students")}</span>
                  </div>
                  <div className="card-metric-pill">
                    <GraduationCap size={14} />
                    <strong>{c.doctors ?? 0}</strong>
                    <span>{t("Educators")}</span>
                  </div>
                  <div className="card-metric-pill">
                    <Layers size={14} />
                    <strong>{deptCount}</strong>
                    <span>{t("Depts")}</span>
                  </div>
                  <div className="card-metric-pill">
                    <BookOpen size={14} />
                    <strong>{c.subjects ?? 0}</strong>
                    <span>{t("Subjects")}</span>
                  </div>
                </div>
                <div className="exam-card-action">
                  <Link className="button secondary small-btn" to={`/colleges/${c.id}`}>
                    {t("Manage college")} <ArrowUpRight size={14} />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        !query.error && (
          <Empty
            title={t("No colleges yet")}
            text={t(
              "Create your first college, or run the migration backfill from imported student records.",
            )}
          />
        )
      )}
      {modal && (
        <Dialog title={t("New college")} onClose={() => setModal(false)}>
          <FieldsForm
            fields={[
              { key: "name", label: "Name", required: true },
              { key: "code", label: "Code", required: true },
            ]}
            onSubmit={(body) =>
              action.mutate(
                { path: "/api/v1/admin/colleges", body },
                { onSuccess: () => setModal(false) },
              )
            }
            busy={action.isPending}
            error={action.error}
            submitLabel={t("Create college")}
          />
        </Dialog>
      )}
    </>
  );
}

export function CollegeDetail({ user }: { user: SessionUser }) {
  const t = useT();
  const { id } = useParams();
  const navigate = useNavigate();
  const query = useResource<CollegeDetailData>(
    user,
    `/api/v1/admin/colleges/${id}`,
  );
  const action = useAction(user, [
    "/api/v1/admin/colleges",
    `/api/v1/admin/colleges/${id}`,
    "/api/v1/admin/departments",
  ]);
  const [year, setYear] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [moveYear, setMoveYear] = useState<number | null>(null);
  const [op, setOp] = useState<"edit" | "merge" | "delete" | "dept" | "link-dept" | null>(null);
  const [deptTarget, setDeptTarget] = useState("");
  const [linkDeptId, setLinkDeptId] = useState("");
  const students = useResource<Envelope<CollegeStudent>>(
    user,
    `/api/v1/admin/colleges/${id}/students?page=${page}&limit=20${year ? `&year=${year}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}`,
    !!id,
  );
  const colleges = useResource<Envelope<College>>(
    user,
    "/api/v1/admin/colleges?limit=100",
    op === "merge",
  );
  const allDepts = useResource<Envelope<CollegeDeptInfo>>(
    user,
    "/api/v1/admin/departments?limit=100",
    op === "link-dept",
  );
  const c = query.data;
  const toggle = (sid: string) =>
    setSelected((prev) =>
      prev.includes(sid) ? prev.filter((x) => x !== sid) : [...prev, sid],
    );
  const deptList = Array.isArray(c?.departments) ? c.departments : [];
  const linkedDeptIds = new Set(deptList.map((d) => d.id));
  const linkableDepts = rowsOf(allDepts.data).filter((d) => !linkedDeptIds.has(d.id));

  return (
    <>
      <Link className="back-link" to="/colleges">
        {t(" ← Back to colleges ")}
      </Link>
      <Feedback error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : (
        c && (
          <>
            <PageTitle
              title={c.name}
              description={`${c.code} · ${c.students ?? 0} ${t("students")} · ${c.doctors ?? 0} ${t("doctors")} · ${c.subjectTotal ?? c.subjects?.length ?? 0} ${t("subjects")}`}
              action={
                <div className="action-row">
                  <button className="secondary" onClick={() => { setLinkDeptId(""); setOp("link-dept"); }}>
                    <Plus size={15} /> {t(" Link department ")}
                  </button>
                  <button className="secondary" onClick={() => setOp("edit")}>
                    {t(" Edit ")}
                  </button>
                  <button className="secondary" onClick={() => setOp("merge")}>
                    {t(" Merge… ")}
                  </button>
                  <button className="secondary" onClick={() => setOp("delete")}>
                    {t(" Delete ")}
                  </button>
                </div>
              }
            />
            <Feedback error={action.error} />
            <div className="stat-grid">
              <div className="stat-card">
                <div>{t("Students")}</div>
                <strong>{c.students ?? 0}</strong>
                <small>{t("enrolled in this college")}</small>
              </div>
              <div className="stat-card">
                <div>{t("Educators")}</div>
                <strong>{c.doctors ?? 0}</strong>
                <small>{t("doctors in this college")}</small>
              </div>
              <div className="stat-card">
                <div>{t("Departments")}</div>
                <strong>{deptList.length}</strong>
                <small>{t("linked departments")}</small>
              </div>
              <div className="stat-card">
                <div>{t("Subjects")}</div>
                <strong>{c.subjectTotal ?? c.subjects?.length ?? 0}</strong>
                <small>{t("courses in departments")}</small>
              </div>
            </div>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    {t("Departments")} · {deptList.length}
                  </h2>
                  <p>{t("Academic departments belonging to this college and their course catalog.")}</p>
                </div>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setLinkDeptId("");
                    setOp("link-dept");
                  }}
                >
                  <Plus size={15} /> {t("Link department")}
                </button>
              </div>
              {deptList.length > 0 ? (
                <div className="exam-grid academic-card-grid">
                  {deptList.map((d) => {
                    const owned = (c.subjects ?? []).filter(
                      (s) => s.department?.id === d.id,
                    );
                    return (
                      <article className="exam-card academic-card" key={d.id}>
                        <div className="exam-card-top">
                          <span className="assessment-icon">
                            <Building2 size={18} />
                          </span>
                          <span className="code-pill">{d.code}</span>
                        </div>
                        <h2>{d.name}</h2>
                        <div className="card-metrics-grid two-col">
                          <div className="card-metric-pill">
                            <Users size={14} />
                            <strong>{d._count?.users ?? 0}</strong>
                            <span>{t("Members")}</span>
                          </div>
                          <div className="card-metric-pill">
                            <BookOpen size={14} />
                            <strong>{d._count?.subjects ?? owned.length}</strong>
                            <span>{t("Subjects")}</span>
                          </div>
                        </div>
                        {owned.length > 0 && (
                          <div className="option-chips">
                            {owned.map((s) => (
                              <span key={s.id} title={s.name}>
                                {s.code}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="exam-card-action">
                          <span className="subtle">
                            {typeof d._count?.subjects === "number" &&
                            d._count.subjects > owned.length
                              ? t("Showing {0} of {1}.", {
                                  "0": owned.length,
                                  "1": d._count.subjects,
                                })
                              : ""}
                          </span>
                          <button
                            className="text-button"
                            onClick={() => {
                              setDeptTarget(d.id);
                              setOp("dept");
                            }}
                          >
                            {t(" Unlink ")}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <Empty
                  title={t("No departments linked yet")}
                  text={t("Link an existing department to organize subjects and educators under this college.")}
                />
              )}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    {t("Subjects")}
                    {typeof c.subjectTotal === "number" && ` · ${c.subjectTotal}`}
                  </h2>
                  <p>{t("Courses offered by this college's departments and their assigned educators.")}</p>
                </div>
                <Link className="button secondary" to="/admin/subjects">
                  {t("Manage all subjects")}
                </Link>
              </div>
              {c.subjects?.length ? (
                <>
                  <div className="exam-grid academic-card-grid">
                    {c.subjects.map((s) => {
                      const docs = s.doctorAssignments ?? [];
                      return (
                        <article className="exam-card academic-card" key={s.id}>
                          <div className="exam-card-top">
                            <span className="assessment-icon">
                              <BookOpen size={18} />
                            </span>
                            <div className="card-badge-group">
                              <span className="code-pill">{s.code}</span>
                              {s.department?.name && (
                                <span className="dept-pill">{s.department.name}</span>
                              )}
                            </div>
                          </div>
                          <h2>{s.name}</h2>
                          <div className="card-metrics-grid three-col">
                            <div className="card-metric-pill">
                              <strong>{s._count?.enrollments ?? 0}</strong>
                              <span>{t("Enrolled")}</span>
                            </div>
                            <div className="card-metric-pill">
                              <strong>{s._count?.questions ?? 0}</strong>
                              <span>{t("Questions")}</span>
                            </div>
                            <div className="card-metric-pill">
                              <strong>{s._count?.exams ?? 0}</strong>
                              <span>{t("Exams")}</span>
                            </div>
                          </div>
                          <div className="card-educators-block">
                            <span className="card-section-label">{t("Educators")}</span>
                            {docs.length > 0 ? (
                              <div className="educator-chip-list">
                                {docs.map((da) => (
                                  <Link
                                    key={`${da.doctorId}-${da.termId}`}
                                    to={`/admin/users/${da.doctor.id}`}
                                    className="educator-chip"
                                    title={`${da.doctor.name} (${da.term.name})`}
                                  >
                                    <GraduationCap size={13} />
                                    <span>{da.doctor.name}</span>
                                  </Link>
                                ))}
                              </div>
                            ) : (
                              <span className="subtle">{t("No educator assigned")}</span>
                            )}
                          </div>
                          <div className="exam-card-action">
                            <Link
                              className="button secondary small-btn"
                              to={`/admin/subjects?search=${encodeURIComponent(s.code)}`}
                            >
                              {t("Open subject")} <ArrowUpRight size={14} />
                            </Link>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  {c.subjectsTruncated && (
                    <p className="subtle">
                      {t("Showing {0} of {1}.", {
                        "0": c.subjects.length,
                        "1": c.subjectTotal ?? c.subjects.length,
                      })}
                    </p>
                  )}
                </>
              ) : (
                <Empty
                  title={t("No subjects yet")}
                  text={t("This college's departments have no subjects yet.")}
                />
              )}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    {t("Educators")} · {c.doctorsList?.length ?? c.doctors ?? 0}
                  </h2>
                  <p>{t("Doctors affiliated with this college or its departments and their current-term subjects.")}</p>
                </div>
                <Link className="button secondary" to="/admin/assignments">
                  {t("Manage assignments")}
                </Link>
              </div>
              {c.doctorsList?.length ? (
                <div className="exam-grid academic-card-grid">
                  {c.doctorsList.map((doc) => {
                    const assignments = doc.doctorAssignments ?? [];
                    return (
                      <article className="exam-card academic-card" key={doc.id}>
                        <div className="exam-card-top">
                          <span className="assessment-icon">
                            <GraduationCap size={18} />
                          </span>
                          <div className="card-badge-group">
                            {doc.department?.code && (
                              <span className="dept-pill" title={doc.department.name}>
                                {doc.department.code}
                              </span>
                            )}
                            <Badge value={doc.isActive !== false ? "active" : "inactive"} />
                          </div>
                        </div>
                        <small className="course-code">@{doc.username}</small>
                        <h2>
                          <Link to={`/admin/users/${doc.id}`}>{doc.name}</Link>
                        </h2>
                        <div className="card-educators-block">
                          <span className="card-section-label">
                            {t("Assigned subjects")} ({assignments.length})
                          </span>
                          {assignments.length > 0 ? (
                            <div className="educator-chip-list">
                              {assignments.map((a) => (
                                <Link
                                  key={`${a.subjectId}-${a.termId}`}
                                  to={`/admin/subjects?search=${encodeURIComponent(a.subject.code)}`}
                                  className="subject-assign-chip"
                                  title={`${a.subject.name} (${a.term.name})`}
                                >
                                  <b>{a.subject.code}</b>
                                  <span>{a.subject.name}</span>
                                </Link>
                              ))}
                            </div>
                          ) : (
                            <span className="subtle">{t("No current-term subjects assigned")}</span>
                          )}
                        </div>
                        <div className="exam-card-action">
                          <Link className="button secondary small-btn" to={`/admin/users/${doc.id}`}>
                            {t("Profile & assignments")} <ArrowUpRight size={14} />
                          </Link>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <Empty
                  title={t("No educators in this college yet")}
                  text={t("Assign doctors to this college or one of its departments in Users.")}
                />
              )}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>{t("Years")}</h2>
                  <p>{t("Cohorts with enrolled students.")}</p>
                </div>
              </div>
              {c.years.length ? (
                <div className="chip-row">
                  <button
                    type="button"
                    className={`chip ${!year ? "smart" : ""}`}
                    onClick={() => {
                      setYear("");
                      setPage(1);
                      setSelected([]);
                    }}
                  >
                    {t("All years")}
                  </button>
                  {[1, 2, 3, 4, 5, 6, 7].map((n) => {
                    const found = c.years.find((y) => y.year === n);
                    const count = found ? found.students : 0;
                    return (
                      <button
                        key={n}
                        type="button"
                        className={`chip ${year === String(n) ? "smart" : ""}`}
                        aria-label={`${t("Year")} ${n} · ${count}`}
                        title={`${t("Year")} ${n} · ${count}`}
                        onClick={() => {
                          setYear(String(n));
                          setPage(1);
                          setSelected([]);
                        }}
                      >
                        {t("Year")} {n} ({count})
                      </button>
                    );
                  })}
                </div>
              ) : (
                <Empty
                  title={t("No year data")}
                  text={t("Set academic years on student records to group cohorts.")}
                />
              )}
            </section>

            <section className="panel table-wrap">
              <div className="panel-heading">
                <div>
                  <h2>
                    {t("Students")}
                    {year ? ` · ${t("Year")} ${year}` : ""}
                  </h2>
                  <p>
                    {typeof students.data?.total === "number" &&
                      t("Showing {0} of {1}.", {
                        "0": rowsOf(students.data).length,
                        "1": students.data.total,
                      })}
                  </p>
                </div>
              </div>
              {selected.length > 0 && (
                <div className="bulk-toolbar" role="group" aria-label={t("Move selected students")}>
                  <b>
                    {t("{0} selected", { "0": selected.length })}
                  </b>
                  <span className="subtle">{t("Move to year:")}</span>
                  <div className="seg-pick" role="group" aria-label={t("Target year")}>
                    {[1, 2, 3, 4, 5, 6, 7].map((y) => (
                      <button
                        key={y}
                        type="button"
                        className={moveYear === y ? "on" : ""}
                        aria-pressed={moveYear === y}
                        onClick={() => setMoveYear(y)}
                      >
                        {y}
                      </button>
                    ))}
                  </div>
                  <button
                    className="primary"
                    disabled={moveYear === null || action.isPending}
                    onClick={() =>
                      action.mutate(
                        {
                          path: `/api/v1/admin/colleges/${id}/students/year`,
                          body: { studentIds: selected, year: moveYear },
                        },
                        {
                          onSuccess: () => {
                            setSelected([]);
                            setMoveYear(null);
                            students.refetch();
                            query.refetch();
                          },
                        },
                      )
                    }
                  >
                    {action.isPending ? t("Moving…") : t(" Move ")}
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelected([]);
                      setMoveYear(null);
                    }}
                  >
                    {t(" Clear ")}
                  </button>
                </div>
              )}
              <div className="toolbar">
                <SearchBox
                  value={search}
                  onChange={(s) => {
                    setSearch(s);
                    setPage(1);
                    setSelected([]);
                  }}
                  placeholder={t("Search students…")}
                />
              </div>
              <Feedback error={students.error} />
              {students.isPending ? (
                <Loading />
              ) : students.data?.rows.length ? (
                <table>
                  <thead>
                    <tr>
                      <th scope="col">
                        <span className="sr-only">{t("Select")}</span>
                      </th>
                      <th scope="col">{t("Name")}</th>
                      <th scope="col">{t("Username")}</th>
                      <th scope="col">{t("Year")}</th>
                      <th scope="col">{t("Department")}</th>
                      <th scope="col">{t("Status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {students.data.rows.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={t("Select {0}", { "0": s.name })}
                            checked={selected.includes(s.id)}
                            onChange={() => toggle(s.id)}
                          />
                        </td>
                        <td>
                          <Link to={`/admin/users/${s.id}`}>
                            <b>{s.name}</b>
                          </Link>
                        </td>
                        <td>{s.username}</td>
                        <td>{s.academicYear ?? "—"}</td>
                        <td>{s.department?.name ?? "—"}</td>
                        <td>
                          <Badge value={s.isActive ? "active" : "inactive"} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                !students.error && (
                  <Empty
                    title={t("No students here")}
                    text={t("Try a different year or search.")}
                  />
                )
              )}
            </section>
            <Pagination
              data={students.data}
              page={page}
              setPage={(p) => {
                setPage(p);
                setSelected([]);
              }}
            />
            {op === "link-dept" && (
              <Dialog title={t("Link department to {0}", { "0": c.name })} onClose={() => setOp(null)}>
                <p className="dialog-copy">
                  {t("Select an existing department to attach to this college.")}
                </p>
                <div className="field">
                  <span className="field-label">{t("Department")}</span>
                  <Combo
                    value={linkDeptId}
                    options={linkableDepts.map((d) => ({
                      value: d.id,
                      label: `${d.code} · ${d.name}`,
                    }))}
                    onChange={setLinkDeptId}
                    placeholder={t("Search departments…")}
                    ariaLabel={t("Department")}
                  />
                </div>
                <Feedback error={action.error} />
                <div className="dialog-actions">
                  <button type="button" className="secondary" onClick={() => setOp(null)}>
                    {t("Cancel")}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={!linkDeptId || action.isPending}
                    onClick={() =>
                      action.mutate(
                        {
                          path: `/api/v1/admin/departments/${linkDeptId}`,
                          method: "PATCH",
                          body: { collegeId: id },
                        },
                        {
                          onSuccess: () => {
                            setOp(null);
                            setLinkDeptId("");
                            query.refetch();
                          },
                        },
                      )
                    }
                  >
                    {action.isPending ? t("Linking…") : t("Link department")}
                  </button>
                </div>
              </Dialog>
            )}
            {op === "edit" && (
              <Dialog title={t("Edit college")} onClose={() => setOp(null)}>
                <FieldsForm
                  fields={[
                    { key: "name", label: "Name", value: c.name },
                    { key: "code", label: "Code", value: c.code },
                  ]}
                  onSubmit={(body) =>
                    action.mutate(
                      { path: `/api/v1/admin/colleges/${id}`, method: "PATCH", body },
                      {
                        onSuccess: () => {
                          setOp(null);
                          query.refetch();
                        },
                      },
                    )
                  }
                  busy={action.isPending}
                  error={action.error}
                  submitLabel={t("Save changes")}
                />
              </Dialog>
            )}
            {op === "merge" && (
              <Dialog title={t("Merge college")} onClose={() => setOp(null)}>
                <p className="dialog-copy">
                  {t(
                    "Move every department and student into another college, then delete this one. This cannot be undone.",
                  )}
                </p>
                <div className="field">
                  <span className="field-label">{t("Merge into")}</span>
                  <Combo
                    value=""
                    options={rowsOf(colleges.data)
                      .filter((x) => x.id !== id)
                      .map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` }))}
                    onChange={(v) =>
                      v &&
                      action.mutate(
                        { path: `/api/v1/admin/colleges/${id}/merge`, body: { intoId: v } },
                        { onSuccess: () => navigate("/colleges") },
                      )
                    }
                    placeholder="Search colleges…"
                    ariaLabel={t("Merge into")}
                  />
                </div>
                <Feedback error={action.error} />
              </Dialog>
            )}
            {op === "delete" && (
              <Confirm
                title={t("Delete college?")}
                text={t(
                  "Colleges with departments or students cannot be deleted — merge or reassign them first.",
                )}
                onClose={() => setOp(null)}
                onConfirm={() =>
                  action.mutate(
                    { path: `/api/v1/admin/colleges/${id}`, method: "DELETE" },
                    { onSuccess: () => navigate("/colleges") },
                  )
                }
                error={action.error}
                busy={action.isPending}
              />
            )}
            {op === "dept" && (
              <Confirm
                title={t("Unlink department?")}
                text={t(
                  "The department stays in the catalog with its users and subjects — it simply leaves this college.",
                )}
                onClose={() => {
                  setOp(null);
                  setDeptTarget("");
                }}
                onConfirm={() =>
                  action.mutate(
                    {
                      path: `/api/v1/admin/departments/${deptTarget}`,
                      method: "PATCH",
                      body: { collegeId: null },
                    },
                    {
                      onSuccess: () => {
                        setOp(null);
                        setDeptTarget("");
                        query.refetch();
                      },
                    },
                  )
                }
                error={action.error}
                busy={action.isPending}
              />
            )}
          </>
        )
      )}
    </>
  );
}
