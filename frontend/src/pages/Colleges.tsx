import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { BookOpen, Building2, Users } from "lucide-react";
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
  department?: { id: string; name: string } | null;
  _count?: { questions: number; exams: number; enrollments: number };
}

interface CollegeDetail extends Entity {
  code: string;
  name: string;
  students?: number;
  doctors?: number;
  departments?: CollegeDeptInfo[] | number;
  years: { year: number | null; students: number }[];
  subjects?: CollegeSubject[];
  subjectTotal?: number;
  subjectsTruncated?: boolean;
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
  return (
    <>
      <PageTitle
        title={t("Colleges")}
        description={t("Faculties, their years, and enrolled students.")}
        action={
          <button
            className="primary"
            onClick={() => {
              action.reset();
              setModal(true);
            }}
          >
            {t(" New college ")}
          </button>
        }
      />
      <div className="toolbar">
        <SearchBox
          value={q}
          onChange={setQ}
          placeholder={t("Find a student by name or username…")}
        />
      </div>
      {q.trim().length > 1 && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{t("Students")}</h2>
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
      ) : rowsOf(query.data).length ? (
        <div className="exam-grid">
          {rowsOf(query.data).map((c) => (
            <article className="exam-card" key={c.id}>
              <div className="exam-card-top">
                <span className="assessment-icon">
                  <Building2 size={18} />
                </span>
                <Badge value="active" />
              </div>
              <small className="course-code">{c.code}</small>
              <h2>
                <Link to={`/colleges/${c.id}`}>{c.name}</Link>
              </h2>
              <p>
                {c.students ?? 0} {t("students")} · {c.doctors ?? 0}{" "}
                {t("doctors")} ·{" "}
                {typeof c.departments === "number" ? c.departments : 0}{" "}
                {t("departments")} · {c.subjects ?? 0} {t("subjects")}
              </p>
              <Link className="exam-card-action" to={`/colleges/${c.id}`}>
                {t("Open college")}
              </Link>
            </article>
          ))}
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
  const query = useResource<CollegeDetail>(
    user,
    `/api/v1/admin/colleges/${id}`,
  );
  const action = useAction(user, [
    "/api/v1/admin/colleges",
    `/api/v1/admin/colleges/${id}`,
  ]);
  const [year, setYear] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [moveYear, setMoveYear] = useState<number | null>(null);
  const [op, setOp] = useState<"edit" | "merge" | "delete" | "dept" | null>(null);
  const [deptTarget, setDeptTarget] = useState("");
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
  const c = query.data;
  const toggle = (sid: string) =>
    setSelected((prev) =>
      prev.includes(sid) ? prev.filter((x) => x !== sid) : [...prev, sid],
    );
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
              description={`${c.code} · ${c.students ?? 0} ${t("students")} · ${c.doctors ?? 0} ${t("doctors")}`}
              action={
                <div className="action-row">
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
                <div>{t("Doctors")}</div>
                <strong>{c.doctors ?? 0}</strong>
                <small>{t("teaching in this college")}</small>
              </div>
              <div className="stat-card">
                <div>{t("Departments")}</div>
                <strong>
                  {Array.isArray(c.departments) ? c.departments.length : 0}
                </strong>
                <small>{t("linked departments")}</small>
              </div>
            </div>
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
                        {n}
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
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    {t("Subjects")}
                    {typeof c.subjectTotal === "number" && ` · ${c.subjectTotal}`}
                  </h2>
                  <p>{t("Subjects in this college's departments.")}</p>
                </div>
              </div>
              {c.subjects?.length ? (
                <>
                  <div className="exam-grid">
                    {c.subjects.map((s) => (
                      <article className="exam-card" key={s.id}>
                        <div className="exam-card-top">
                          <span className="assessment-icon">
                            <BookOpen size={18} />
                          </span>
                        </div>
                        <small className="course-code">{s.code}</small>
                        <h2>{s.name}</h2>
                        <p>
                          {s.department?.name ?? "—"} ·{" "}
                          {s._count?.questions ?? 0} {t("questions")} ·{" "}
                          {s._count?.exams ?? 0} {t("exams")} ·{" "}
                          {s._count?.enrollments ?? 0} {t("enrolled")}
                        </p>
                        <Link
                          className="exam-card-action"
                          to={`/admin/subjects?search=${encodeURIComponent(s.code)}`}
                        >
                          {t("Open subject")}
                        </Link>
                      </article>
                    ))}
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
            {Array.isArray(c.departments) && c.departments.length > 0 && (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>{t("Departments")}</h2>
                    <p>{t("Departments in this college, with their subjects.")}</p>
                  </div>
                </div>
                <div className="exam-grid">
                  {c.departments.map((d) => {
                    const owned = (c.subjects ?? []).filter(
                      (s) => s.department?.id === d.id,
                    );
                    return (
                      <article className="exam-card" key={d.id}>
                        <div className="exam-card-top">
                          <span className="assessment-icon">
                            <Building2 size={18} />
                          </span>
                        </div>
                        <small className="course-code">{d.code}</small>
                        <h2>{d.name}</h2>
                        <p>
                          {d._count?.users ?? 0} {t("users")} ·{" "}
                          {d._count?.subjects ?? owned.length}{" "}
                          {t("subjects")}
                        </p>
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
              </section>
            )}
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
