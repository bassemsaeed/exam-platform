import { useT } from "../lib/i18n";
import { useState } from "react";
import { Link, useNavigate, useParams, useLocation } from "react-router-dom";
import {
  Plus,
  Clock,
  ArrowUpRight,
  Pencil,
  Trash2,
  Download,
  ShieldCheck,
  RefreshCw,
  Radio,
  Image as ImageIcon,
  Users,
  GraduationCap,
  BookOpen,
  LayoutGrid,
  List,
  CheckCircle2,
  Mail,
  Building2,
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { api, type SessionUser } from "../lib/api";
import {
  useResource,
  useAction,
  previewMode,
  rowsOf,
  label,
  date,
  time,
  nameOf,
  type Entity,
  type Exam,
  type Question,
  type Envelope,
  type Subject,
  type StudentResult,
  invalidateResources,
} from "../lib/platform";
import { apiUrl, sebHeaders } from "../lib/seb";
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
import { EditExamWindow, QuestionSheet } from "./Builder";
import { AccountGuide } from "./Enhancements";
import { Combo, MultiPicker } from "../components/builder";
const opts = (values: string[]) =>
  values.map((value) => ({ value, label: label(value) }));
export function Exams({ user }: { user: SessionUser }) {
  const t = useT();
  const student = user.role === "student";
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const path = student
    ? "/api/v1/student/exams"
    : `${user.role === "admin" ? "/api/v1/admin/exams" : "/api/v1/exams/mine"}?page=${page}&limit=12${status ? "&status=" + status : ""}`;
  const query = useResource<Exam[] | Envelope<Exam>>(user, path);
  const upcoming = useResource<Exam[]>(
    user,
    "/api/v1/student/exams/upcoming",
    student,
    60000,
  );
  const upcomingRows = student ? (upcoming.data ?? []) : [];
  const subjects = useResource<Envelope<Subject>>(
    user,
    "/api/v1/exams/subjects?limit=100",
    !student,
  );
  const rows = rowsOf(query.data).filter((e) =>
    `${nameOf(e, rowsOf(subjects.data))} ${e.type}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  ).filter((e) => !kind || (e.purpose ?? (e.type === "ta_quiz" ? "quiz" : "midterm")) === kind);
  // Staff grouping: the live one is unmistakable, drafts sit apart from history.
  const nowT = Date.now();
  const isLiveRow = (e: Exam) =>
    e.status === "approved" &&
    new Date(e.startTime).getTime() <= nowT &&
    new Date(e.endTime).getTime() >= nowT;
  const liveRows = student ? [] : rows.filter(isLiveRow);
  const pendingRows = student ? [] : rows.filter((e) => e.status === "pending_approval");
  const draftRows = student ? [] : rows.filter((e) => ["draft", "rejected"].includes(e.status));
  const pastRows = student
    ? []
    : rows.filter(
        (e) => !isLiveRow(e) && !["pending_approval", "draft", "rejected"].includes(e.status),
      );
  function examCards(list: Exam[]) {
    return (
      <div className="exam-grid">
        {list.map((e) => (
          <article className="exam-card" key={e.id}>
            <div className="exam-card-top">
              <span className="assessment-icon">
                <ShieldCheck size={20} />
              </span>
              <Badge value={student ? "available" : e.status} />
            </div>
            <small className="course-code">
              {e.subject?.code ?? t("ASSESSMENT")}
            </small>
            <h2>{nameOf(e, rowsOf(subjects.data))}</h2>
            <p>
              {t(label(e.purpose ?? (e.type === "ta_quiz" ? "quiz" : "midterm")))} ·{" "}
              {t(label(e.type))} · {e.durationMinutes}
              {t(" minutes ")}
            </p>
            <div className="exam-card-date">
              <Clock size={15} />
              <span>
                {date(e.startTime)} · {time(e.startTime)}
              </span>
            </div>
            {e.rejectionReason && (
              <p className="rejection-note">{e.rejectionReason}</p>
            )}
            <Link
              className="exam-card-action"
              to={student ? `/exams/${e.id}/take` : `/exams/${e.id}`}
            >
              {student ? t("Begin or resume") : t("View assessment")}{" "}
              <ArrowUpRight size={16} />
            </Link>
          </article>
        ))}
      </div>
    );
  }
  // Proctoring overview: the staffer's exams whose window is open right now,
  // with live headcounts. Students never see this; admins see everything.
  const liveNow = useResource<{
    now: string;
    rows: {
      id: string;
      type: string;
      status: string;
      endTime: string;
      subject: { code: string; name: string };
      inProgress: number;
      stale: number;
      submitted: number;
    }[];
  }>(user, "/api/v1/exams/live", !student, 30000);
  return (
    <>
      <PageTitle
        title={student ? t("My exams") : t("Exams & quizzes")}
        description={
          student
            ? t("Available assessments assigned to your account.")
            : t("Create, review, and manage your assessments.")
        }
        action={
          !student && (
            <Link className="button primary" to="/exams/new">
              <Plus size={16} />
              {t(" Create exam ")}
            </Link>
          )
        }
      />
      {!student && !!liveNow.data?.rows.length && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{t("Happening now")}</h2>
              <p>{t("Your assessments with the window open right now.")}</p>
            </div>
          </div>
          <div className="assessment-list">
            {liveNow.data.rows.map((e) => (
              <Link key={e.id} to={`/exams/${e.id}`}>
                <span className="assessment-icon">
                  <Radio size={17} />
                </span>
                <div>
                  <b>
                    {e.subject.code} · {e.subject.name}
                  </b>
                  <small>
                    {t(label(e.type))} · {t("ends")} {time(e.endTime)} ·{" "}
                    {e.inProgress} {t("taking")} · {e.submitted}{" "}
                    {t("submitted")}
                    {e.stale > 0 &&
                      ` · ${e.stale} ${t("stale connection")}`}
                  </small>
                </div>
                <Badge value={e.inProgress > 0 ? "in_progress" : "approved"} />
              </Link>
            ))}
          </div>
        </section>
      )}
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder={t("Search assessments in this page…")}
        />
        {!student && (
          <Combo
            value={status}
            options={[
              { value: "", label: t("All statuses") },
              ...opts(["pending_approval", "approved", "rejected"]).map(
                (o) => ({ value: o.value, label: t(o.label) }),
              ),
            ]}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            ariaLabel={t("Filter exam status")}
          />
        )}
        {!student && (
          <Combo
            value={kind}
            options={[
              { value: "", label: t("Midterms & quizzes") },
              { value: "midterm", label: t("Midterms") },
              { value: "quiz", label: t("Quizzes") },
            ]}
            onChange={(v) => {
              setKind(v);
              setPage(1);
            }}
            ariaLabel={t("Filter exam kind")}
          />
        )}
        <button className="secondary" onClick={() => query.refetch()}>
          <RefreshCw size={15} />
          {t(" Refresh ")}
        </button>
      </div>
      <Feedback error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : student ? (
        rows.length ? (
          examCards(rows)
        ) : (
          !query.error && (
            <Empty
              title={t("No exams found")}
              text={t("Exams appear here during their availability window.")}
            />
          )
        )
      ) : (
        <>
          {liveRows.length > 0 && (
            <>
              <h3 className="analytics-sub">{t("Live now")}</h3>
              {examCards(liveRows)}
            </>
          )}
          {pendingRows.length > 0 && (
            <>
              <h3 className="analytics-sub">{t("Waiting for approval")}</h3>
              {examCards(pendingRows)}
            </>
          )}
          {draftRows.length > 0 && (
            <>
              <h3 className="analytics-sub">{t("Drafts")}</h3>
              {examCards(draftRows)}
            </>
          )}
          {pastRows.length > 0 && (
            <>
              <h3 className="analytics-sub">{t("Past")}</h3>
              {examCards(pastRows)}
            </>
          )}
          {!rows.length && !query.error && (
            <Empty
              title={t("No exams found")}
              text={t("Try a different filter or create a new assessment.")}
            />
          )}
        </>
      )}{" "}
      {student && !query.isPending && !query.error && (
        <section className="panel upcoming-panel">
          <div className="panel-heading">
            <div>
              <h2>{t("Upcoming")}</h2>
              <p>{t("Approved and assigned — opens soon.")}</p>
            </div>
          </div>
          <Feedback error={upcoming.error} />
          {upcoming.isPending ? (
            <Loading />
          ) : upcomingRows.length ? (
            <div className="assessment-list">
              {upcomingRows.map((e) => (
                <div key={e.id} className="upcoming-row">
                  <span className="assessment-icon">
                    <Clock size={20} />
                  </span>
                  <div>
                    <b>{nameOf(e, rowsOf(subjects.data))}</b>
                    <small>
                      {date(e.startTime)} · {time(e.startTime)} ·{" "}
                      {e.durationMinutes}
                      {t(" min ")}
                    </small>
                  </div>
                  <span className="badge">{t("Upcoming")}</span>
                </div>
              ))}
            </div>
          ) : (
            !upcoming.error && (
              <Empty
                title={t("Nothing scheduled")}
                text={t("Future exams will appear here once approved.")}
              />
            )
          )}
        </section>
      )}{" "}
      {!student && (
        <Pagination
          data={query.data as Envelope<Exam>}
          page={page}
          setPage={setPage}
        />
      )}
    </>
  );
}
export { ExamWizard as ExamBuilder } from "./Builder";
function CompTargetPicker({
  user,
  subjectId,
  value,
  onChange,
}: {
  user: SessionUser;
  subjectId: string;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const t = useT();
  const roster = useResource<{
    totalEnrolled: number;
    enrolledStudents?: { id: string; username: string; name: string }[];
    sections: {
      id: string;
      name: string;
      students: { id: string; username: string; name: string }[];
    }[];
  }>(user, `/api/v1/exams/roster?subject_id=${subjectId}`, !!subjectId);
  return (
    <div className="field">
      <span className="field-label">
        {t("Target students")} — {t("leave empty for everyone")}
      </span>
      <Feedback error={roster.error} />
      {roster.isPending ? (
        <p className="subtle">{t("Loading enrolled students…")}</p>
      ) : (
        <MultiPicker
          options={(() => {
            const sectionMap = new Map<string, string[]>();
            for (const sec of roster.data?.sections ?? []) {
              for (const st of sec.students) {
                const list = sectionMap.get(st.id) ?? [];
                list.push(sec.name);
                sectionMap.set(st.id, list);
              }
            }
            const seen = new Map<
              string,
              { id: string; name: string; username: string; sub: string }
            >();
            for (const st of roster.data?.enrolledStudents ?? []) {
              seen.set(st.id, {
                id: st.id,
                name: st.name,
                username: st.username,
                sub: sectionMap.get(st.id)?.join(", ") || t("Enrolled (no section)"),
              });
            }
            for (const sec of roster.data?.sections ?? []) {
              for (const st of sec.students) {
                if (!seen.has(st.id)) {
                  seen.set(st.id, {
                    id: st.id,
                    name: st.name,
                    username: st.username,
                    sub: sectionMap.get(st.id)?.join(", ") || sec.name,
                  });
                }
              }
            }
            return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
          })()}
          value={value}
          onChange={onChange}
          placeholder="Search enrolled students…"
          emptyText="No enrolled students in this subject."
        />
      )}
    </div>
  );
}

export function ExamDetail({ user }: { user: SessionUser }) {
  const t = useT();
  const navigate = useNavigate();
  const { id } = useParams();
  const admin = user.role === "admin";
  const [tab, setTab] = useState("blueprint");
  const [operation, setOperation] = useState("");
  const [conflicts, setConflicts] = useState<
    { id: string; title: string; purpose: string; status: string }[] | null
  >(null);
  const [compStudents, setCompStudents] = useState<string[]>([]);
  const action = useAction(user, ["/api/v1/exams", "/api/v1/admin/exams"]);
  const query = useResource<{
    exam: Exam;
    questions: Question[];
    mode: string;
    sittings: Record<string, number>;
  }>(user, `/api/v1/exams/${id}/blueprint`);
  const live = useResource<{
    rows: Entity[];
    total: number;
  }>(user, `/api/v1/admin/exams/${id}/live`, admin && tab === "live", 10000);
  const comp = useResource<Entity[]>(
    user,
    `/api/v1/admin/exams/${id}/compensations`,
    admin && tab === "adjustments",
  );
  const analytics = useResource<{
    examId: string;
    assigned: number | null;
    started: number;
    absent: number | null;
    submitted: number;
    inProgress: number;
    avg: number;
    median: number;
    high: number;
    low: number;
    passRate: number;
    passCount: number;
    autoSubmitted: number;
    rushSubmits: number;
    avgMinutesUsed: number;
    distribution: number[];
    submitCurve: { t: string; n: number }[];
    reentry: { single: { n: number; avg: number }; multi: { n: number; avg: number } };
    sections: { sectionId: string; name: string; n: number; avg: number; passRate: number }[];
    questions: {
      questionId: string;
      text: string;
      type: string;
      difficulty: string;
      grade: number;
      attempts: number;
      answered: number;
      skipped: number;
      correct: number;
      pctCorrect: number;
      answerRate: number;
      avgAward: number;
      flagged: number;
      voidPassDelta: number;
      options: { label: string; picks: number }[];
    }[];
    prevTerm: { termName: string; avg: number; passRate: number; submitted: number } | null;
  }>(user, `/api/v1/exams/${id}/analytics`, tab === "analytics");
  const [openQ, setOpenQ] = useState<string | null>(null);
  const e = query.data?.exam;
  const canSeeAnalytics = admin || (!!e && e.createdBy === user.id);
  function send(body: Record<string, unknown>) {
    if (operation === "edit") {
      action.mutate(
        {
          path: `/api/v1/${admin ? "admin/" : ""}exams/${id}`,
          method: "PATCH",
          body,
        },
        { onSuccess: () => setOperation("") },
      );
      return;
    }
    action.mutate(
      {
        path: `/api/v1/admin/exams/${id}/${operation}`,
        body:
          operation === "events"
            ? { type: body.type, payload: { message: body.message } }
            : body,
      },
      { onSuccess: () => setOperation("") },
    );
  }
  return (
    <>
      <PageTitle
        title={e ? nameOf(e) : t("Assessment details")}
        description={t("Blueprint, status, and assessment activity.")}
      />
      <Link className="back-link" to="/exams">
        {t(" \u2190 Back to exams ")}
      </Link>
      <Feedback error={query.error} />
      {query.isPending ? (
        <Loading />
      ) : (
        e && (
          <>
            <section className="panel exam-summary">
              <div>
                <Badge value={e.status} />
                <h2>{t(label(e.type))}</h2>
                <p>
                  {date(e.startTime)} · {time(e.startTime)} – {time(e.endTime)}{" "}
                  · {e.durationMinutes}
                  {t(" minutes ")}
                </p>
              </div>
              <div className="action-row">
                {admin && e.status === "pending_approval" && (
                  <>
                    <button
                      className="primary"
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate(
                          {
                            path: `/api/v1/admin/exams/${id}/approve`,
                          },
                          {
                            onError: (err) => {
                              const data = (err as { data?: { conflicts?: { id: string; title: string; purpose: string; status: string }[] } })?.data;
                              if (
                                err instanceof Error &&
                                "status" in err &&
                                (err as { status?: number }).status === 409 &&
                                data?.conflicts?.length
                              ) {
                                setConflicts(data.conflicts);
                              }
                            },
                          },
                        )
                      }
                    >
                      {t(" Approve exam ")}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setOperation("reject")}
                    >
                      {t(" Reject ")}
                    </button>
                  </>
                )}
                {admin && (
                  <button
                    className="secondary"
                    onClick={() => setOperation("access-code")}
                  >
                    {t(" Manage entry code ")}
                  </button>
                )}
                {(admin || e.createdBy === user.id) && (
                  <button
                    className="secondary"
                    disabled={action.isPending}
                    title={
                      e.resultsReleased
                        ? t("Grades are visible to students")
                        : t("Grades are hidden until you publish them")
                    }
                    onClick={() =>
                      action.mutate(
                        {
                          path: `/api/v1/${admin ? "admin/" : ""}exams/${id}/release`,
                          body: { released: !e.resultsReleased },
                        },
                        { onSuccess: () => query.refetch() },
                      )
                    }
                  >
                    {e.resultsReleased
                      ? t(" Unpublish grades ")
                      : t(" Publish grades ")}
                  </button>
                )}
                <button
                  className="secondary"
                  onClick={() => setOperation("edit")}
                >
                  {t(" Edit settings ")}
                </button>
                {(admin ||
                  (!admin &&
                    (["draft", "rejected", "pending_approval"].includes(
                      e.status,
                    ) ||
                      (e.status === "approved" &&
                        e.type === "ta_quiz")))) && (
                  <button
                    className="secondary"
                    onClick={() => setOperation("delete")}
                  >
                    {t(" Delete ")}
                  </button>
                )}
                <Link className="button secondary" to={"/results?exam=" + id}>
                  {t(" View results ")}
                </Link>
              </div>
            </section>
            <Feedback error={action.error} />
            <div className="tabs">
              {["blueprint", ...(admin ? ["live", "adjustments"] : []), ...(canSeeAnalytics ? ["analytics"] : [])].map(
                (tabKey) => (
                  <button
                    key={tabKey}
                    className={tab === tabKey ? "active" : ""}
                    onClick={() => setTab(tabKey)}
                  >
                    {tabKey === "live"
                      ? t("Live monitor")
                      : tabKey === "analytics"
                        ? t("Analytics")
                        : t(label(tabKey))}
                  </button>
                ),
              )}
            </div>
            {tab === "blueprint" && (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      {query.data?.mode === "manual"
                        ? t("Selected questions")
                        : t("Question pool preview")}
                    </h2>
                    <p>
                      {query.data?.mode === "manual"
                        ? t("Author-selected blueprint.")
                        : t(
                            "The server samples the configured difficulty mix when each student starts.",
                          )}
                    </p>
                  </div>
                </div>
                <div className="mix-summary">
                  {Object.entries(e.difficultyMix ?? {}).map(([key, value]) => (
                    <span key={key}>
                      {t(label(key))} <b>{value}</b>
                    </span>
                  ))}
                </div>
                {query.data?.questions.map((q, i) => (
                  <div className="question-preview" key={q.id}>
                    <span>{i + 1}</span>
                    <div>
                      <b>{q.text}</b>
                      <small>
                        {q.grade}
                        {t(" marks \u00B7 ")}
                        {t(label(q.questionType))}
                      </small>
                      <p>{q.options.join(" · ")}</p>
                    </div>
                    <Badge value={q.difficulty} />
                  </div>
                ))}
              </section>
            )}
            {tab === "live" && (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>{t("Live sittings")}</h2>
                    <p>
                      {t(
                        " Updates every 10 seconds. Stale connections are flagged. ",
                      )}
                    </p>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => setOperation("events")}
                  >
                    {t(" Send announcement ")}
                  </button>
                </div>
                <Feedback error={live.error} />
                {live.isPending ? (
                  <Loading />
                ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t("Student")}</th>
                        <th scope="col">{t("Progress")}</th>
                        <th scope="col">{t("Remaining")}</th>
                        <th scope="col">{t("Connection")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {live.data?.rows.map((r) => (
                        <tr key={r.id}>
                          <td>{(r.student as Entity)?.name}</td>
                          <td>
                            {String(r.answered)} / {String(r.totalQuestions)}
                          </td>
                          <td>
                            {Math.ceil(Number(r.remainingSeconds) / 60)}
                            {t(" min ")}
                          </td>
                          <td>
                            <Badge value={r.stale ? "stale" : "connected"} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                )}
                {!live.data?.rows.length && !live.isPending && (
                  <Empty
                    title={t("No active sittings")}
                    text={t("Students appear here when they start.")}
                  />
                )}
              </section>
            )}
            {tab === "adjustments" && (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>{t("Grade adjustments")}</h2>
                    <p>
                      {t(
                        " Apply documented compensation to a question in this exam. ",
                      )}
                    </p>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => {
                      setCompStudents([]);
                      setOperation("compensate");
                    }}
                  >
                    {t(" Add adjustment ")}
                  </button>
                </div>
                <Feedback error={comp.error} />
                {comp.isPending ? (
                  <Loading />
                ) : comp.data?.length ? (
                  comp.data.map((r) => (
                    <div className="question-preview" key={r.id}>
                      {String(r.reason)} · {t(label(r.adjustmentType))}
                    </div>
                  ))
                ) : (
                  <Empty title={t("No adjustments")} />
                )}
              </section>
            )}
            {tab === "analytics" && canSeeAnalytics && (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>{t("Analytics")}</h2>
                    <p>
                      {t(
                        "Participation, scores, stuck areas, timing and trends — read-only.",
                      )}
                    </p>
                  </div>
                  {typeof analytics.data?.submitted === "number" && (
                    <span className="subtle">
                      {t("{0} graded attempts", {
                        "0": analytics.data.submitted,
                      })}
                    </span>
                  )}
                </div>
                <Feedback error={analytics.error} />
                {analytics.isPending ? (
                  <Loading />
                ) : analytics.data && analytics.data.submitted ? (
                  <>
                    <div className="stat-grid">
                      <div className="stat-card">
                        <div>
                          {t("Participation")}
                        </div>
                        <strong>
                          {analytics.data.submitted}
                          {analytics.data.assigned !== null &&
                            ` / ${analytics.data.assigned}`}
                        </strong>
                        <small>
                          {analytics.data.started} {t("started")}
                          {analytics.data.absent !== null &&
                            ` · ${analytics.data.absent} ${t("absent")}`}
                          {analytics.data.inProgress > 0 &&
                            ` · ${analytics.data.inProgress} ${t("taking now")}`}
                        </small>
                      </div>
                      <div className="stat-card">
                        <div>{t("Average score")}</div>
                        <strong>{Math.round(analytics.data.avg)}%</strong>
                        <small>
                          {t("median")} {Math.round(analytics.data.median)}% ·{" "}
                          {t("range")} {Math.round(analytics.data.low)}–
                          {Math.round(analytics.data.high)}%
                        </small>
                      </div>
                      <div className="stat-card">
                        <div>{t("Pass rate")}</div>
                        <strong>{Math.round(analytics.data.passRate)}%</strong>
                        <small>
                          {analytics.data.passCount} {t("passed")} ·{" "}
                          {analytics.data.autoSubmitted} {t("auto-submitted")}
                        </small>
                      </div>
                    </div>
                    <h3 className="analytics-sub">{t("Score distribution")}</h3>
                    <div
                      className="dist-bars"
                      role="img"
                      aria-label={t("Score distribution")}
                    >
                      {analytics.data.distribution.map((n, i) => {
                        const max = Math.max(1, ...analytics.data!.distribution);
                        return (
                          <div className="dist-bar" key={i}>
                            <span style={{ height: `${(n / max) * 100}%` }} />
                            <small>
                              {i * 10}–{i * 10 + 10}
                            </small>
                            <b>{n}</b>
                          </div>
                        );
                      })}
                    </div>
                    <h3 className="analytics-sub">
                      {t("Where they are stuck")}
                    </h3>
                    <p className="subtle">
                      {t(
                        "Worst first. Open a question for answer splits, option heat and void impact.",
                      )}
                    </p>
                    {analytics.data.questions.map((q) => {
                      const open = openQ === q.questionId;
                      const maxPick = Math.max(1, ...q.options.map((o) => o.picks));
                      return (
                        <div className="analytics-q" key={q.questionId}>
                          <button
                            type="button"
                            className="analytics-qhead"
                            aria-expanded={open}
                            onClick={() =>
                              setOpenQ(open ? null : q.questionId)
                            }
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <b>{q.text}</b>
                              <small>
                                {t(label(q.type))} · {t(label(q.difficulty))} ·{" "}
                                {q.answered}/{q.attempts} {t("answered")}
                                {q.skipped > 0 &&
                                  ` · ${q.skipped} ${t("skipped")}`}
                                {q.flagged > 0 &&
                                  ` · ${q.flagged} ${t("flagged")}`}
                              </small>
                              <div
                                className="run-progress"
                                role="img"
                                aria-label={t("{0}% correct", {
                                  "0": q.pctCorrect,
                                })}
                              >
                                <i style={{ width: `${q.pctCorrect}%` }} />
                              </div>
                            </div>
                            <span className="badge">
                              {q.pctCorrect}
                              {t("% correct")}
                            </span>
                          </button>
                          {open && (
                            <div className="analytics-qbody">
                              <div className="heat">
                                {q.options.map((o) => (
                                  <div className="heat-row" key={o.label}>
                                    <span dir="auto">{o.label}</span>
                                    <span
                                      className="heat-bar"
                                      style={{
                                        width: `${(o.picks / maxPick) * 100}%`,
                                      }}
                                    />
                                    <b>{o.picks}</b>
                                  </div>
                                ))}
                              </div>
                              <p className="subtle">
                                {t("Average award")}: {q.avgAward} / {q.grade}
                                {q.voidPassDelta > 0 &&
                                  ` · ${t("Voiding moves {0} across the pass line", { "0": q.voidPassDelta })}`}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {analytics.data.sections.length > 1 && (
                      <>
                        <h3 className="analytics-sub">
                          {t("Sections compared")}
                        </h3>
                        {analytics.data.sections.map((s) => (
                          <div className="question-preview" key={s.sectionId}>
                            <span>
                              {s.n} {t("tries")}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <b>{s.name}</b>
                              <small>
                                {t("avg")} {Math.round(s.avg)}% ·{" "}
                                {Math.round(s.passRate)}% {t("passed")}
                              </small>
                              <div
                                className="run-progress"
                                role="img"
                                aria-label={s.name}
                              >
                                <i style={{ width: `${s.avg}%` }} />
                              </div>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                    <h3 className="analytics-sub">{t("Timing & retries")}</h3>
                    <div className="mix-summary">
                      <span>
                        {t("Avg time used")}
                        <b>
                          {Math.round(analytics.data.avgMinutesUsed)}{" "}
                          {t("min")}
                        </b>
                      </span>
                      <span>
                        {t("Rush submits")}
                        <b>{analytics.data.rushSubmits}</b>
                      </span>
                      <span>
                        {t("One entry")}
                        <b>
                          {analytics.data.reentry.single.n} ·{" "}
                          {Math.round(analytics.data.reentry.single.avg)}%
                        </b>
                      </span>
                      <span>
                        {t("Re-entered")}
                        <b>
                          {analytics.data.reentry.multi.n} ·{" "}
                          {Math.round(analytics.data.reentry.multi.avg)}%
                        </b>
                      </span>
                    </div>
                    <div
                      className="dist-bars curve"
                      role="img"
                      aria-label={t("Submissions over time")}
                    >
                      {analytics.data.submitCurve.map((b, i) => {
                        const max = Math.max(
                          1,
                          ...analytics.data!.submitCurve.map((x) => x.n),
                        );
                        return (
                          <div className="dist-bar" key={i} title={String(b.n)}>
                            <span style={{ height: `${(b.n / max) * 100}%` }} />
                          </div>
                        );
                      })}
                    </div>
                    {analytics.data.prevTerm && (
                      <p className="subtle">
                        {t("Last term ({0}): avg {1}%, pass {2}% across {3} attempts.", {
                          "0": analytics.data.prevTerm.termName,
                          "1": Math.round(analytics.data.prevTerm.avg),
                          "2": Math.round(analytics.data.prevTerm.passRate),
                          "3": analytics.data.prevTerm.submitted,
                        })}
                      </p>
                    )}
                  </>
                ) : (
                  <Empty
                    title={t("No graded attempts yet")}
                    text={t(
                      "Performance appears after students submit this assessment.",
                    )}
                  />
                )}
              </section>
            )}
          </>
        )
      )}
      {conflicts && (
        <Dialog
          title={t("Another midterm covers this window")}
          onClose={() => setConflicts(null)}
        >
          <p className="dialog-copy">
            {t(
              "Only one live midterm per subject is allowed. Close the conflicting midterm and approve this one instead?",
            )}
          </p>
          {conflicts.map((c) => (
            <div className="question-preview" key={c.id}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{c.title || t("Untitled")}</b>
                <small>
                  {t(label(c.purpose))} · {t(label(c.status))}
                </small>
              </div>
            </div>
          ))}
          <Feedback error={action.error} />
          <div className="dialog-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setConflicts(null)}
            >
              {t(" Keep both pending ")}
            </button>
            <button
              type="button"
              className="primary"
              disabled={action.isPending}
              onClick={() =>
                action.mutate(
                  {
                    path: `/api/v1/admin/exams/${id}/approve`,
                    body: { closeConflicts: true },
                  },
                  {
                    onSuccess: () => {
                      setConflicts(null);
                      query.refetch();
                    },
                  },
                )
              }
            >
              {action.isPending ? t("Working…") : t("Close & approve")}
            </button>
          </div>
        </Dialog>
      )}
      {operation === "delete" && (
        <Confirm
          title={t("Delete assessment?")}
          text={t(
            admin && new Date(e?.startTime ?? 0).getTime() <= Date.now()
              ? "This exam has started or has sittings. Deleting kicks out connected students and permanently discards their sittings and grades."
              : "This is permanent. Sittings, events and compensations for this assessment are deleted with it.",
          )}
          onClose={() => setOperation("")}
          onConfirm={() =>
            action.mutate(
              {
                path: `/api/v1/${admin ? "admin/" : ""}exams/${id}`,
                method: "DELETE",
              },
              {
                onSuccess: () => {
                  setOperation("");
                  navigate("/exams");
                },
              },
            )
          }
          error={action.error}
          busy={action.isPending}
        />
      )}{" "}
      {operation && operation !== "delete" && (
        <Dialog
          title={t(label(operation))}
          onClose={() => {
            setOperation("");
            action.reset();
          }}
        >
          {operation === "compensate" && (
            <CompTargetPicker
              user={user}
              subjectId={e?.subjectId ?? ""}
              value={compStudents}
              onChange={setCompStudents}
            />
          )}
          {operation === "edit" && e ? (
            <EditExamWindow
              startTime={e.startTime}
              endTime={e.endTime}
              durationMinutes={e.durationMinutes}
              title={e.title}
              purpose={e.purpose}
              sebRequired={e.sebRequired}
              canMidterm={admin || user.role === "doctor"}
              notesEnabled={e.notesEnabled}
              notesForDoctorEnabled={e.notesForDoctorEnabled}
              examToolsEnabled={e.examToolsEnabled}
              maxReentries={e.maxReentries}
              resultsReleased={e.resultsReleased}
              busy={action.isPending}
              error={action.error}
              onSubmit={send}
            />
          ) : (
          <FieldsForm
            fields={
              operation === "reject"
                  ? [
                      {
                        key: "reason",
                        label: "Reason",
                        type: "textarea",
                        required: true,
                      },
                    ]
                  : operation === "access-code"
                    ? [
                        {
                          key: "code",
                          label: "Entry code",
                          required: true,
                          hint: "Students must enter this code to start the exam.",
                        },
                      ]
                    : operation === "events"
                      ? [
                          {
                            key: "type",
                            label: "Event type",
                            required: true,
                            options: opts([
                              "announcement",
                              "warning",
                              "closed",
                              "voided",
                            ]),
                          },
                          {
                            key: "message",
                            label: "Message",
                            type: "textarea",
                            required: true,
                          },
                        ]
                      : [
                          {
                            key: "question_id",
                            label: "Question",
                            required: true,
                            options: (query.data?.questions ?? []).map((q) => ({
                              value: q.id,
                              label: q.text,
                            })),
                          },
                          {
                            key: "adjustment_type",
                            label: "Adjustment type",
                            options: opts(["full_credit", "delta", "set"]),
                            required: true,
                          },
                          {
                            key: "adjustment_value",
                            label: "Value",
                            type: "number",
                          },
                          {
                            key: "reason",
                            label: "Reason",
                            type: "textarea",
                            required: true,
                          },
                        ]
            }
            initial={{}}
            onSubmit={(body) =>
              send(
                operation === "compensate" && compStudents.length
                  ? { ...body, student_ids: compStudents }
                  : body,
              )
            }
            busy={action.isPending}
            error={action.error}
          />
          )}

          {operation === "access-code" && (
            <button
              className="text-button"
              onClick={() =>
                action.mutate(
                  {
                    path: `/api/v1/admin/exams/${id}/access-code`,
                    method: "DELETE",
                  },
                  { onSuccess: () => setOperation("") },
                )
              }
            >
              {t(" Remove entry code ")}
            </button>
          )}
        </Dialog>
      )}
    </>
  );
}
export function QuestionBank({ user }: { user: SessionUser }) {
  const t = useT();
  const subjects = useResource<Envelope<Subject>>(
    user,
    "/api/v1/exams/subjects?limit=100",
  );
  const [subject, setSubject] = useState("");
  const selectedSubject = subject;
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [hasImage, setHasImage] = useState("");
  const [edit, setEdit] = useState<Question | "new" | null>(null);
  const [remove, setRemove] = useState<Question | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [createdQuestion, setCreatedQuestion] = useState<Question | null>(null);
  const query = useResource<Envelope<Question>>(
    user,
    `/api/v1/question-bank?subject_id=${selectedSubject}&page=${page}&limit=10&search=${encodeURIComponent(search)}${difficulty ? "&difficulty=" + difficulty : ""}${hasImage ? "&has_image=" + hasImage : ""}`,
    !!selectedSubject,
  );
  const action = useAction<Question>(user, [
    "/api/v1/question-bank",
    "/api/v1/exams",
  ]);
  return (
    <>
      <PageTitle
        title={t("Question bank")}
        description={t("Manage questions, answer keys, and difficulty levels.")}
        action={
          <div className="action-row">
            <Link to="/imports?type=questions" className="button secondary">
              {t(" Import questions ")}
            </Link>
            <button
              className="primary"
              disabled={!selectedSubject}
              onClick={() => {
                action.reset();
                setUploadError("");
                setImageFile(null);
                setCreatedQuestion(null);
                setEdit("new");
              }}
            >
              <Plus size={16} />
              {t(" Add question ")}
            </button>
          </div>
        }
      />
      <Feedback error={subjects.error} />
      <section className="panel subject-filter">
        <h2>{t("Subject")}</h2>
        <Combo
          value={selectedSubject}
          options={rowsOf(subjects.data).map((s) => ({
            value: s.id,
            label: `${s.code} · ${s.name}`,
          }))}
          onChange={(v) => {
            setSubject(v);
            setPage(1);
          }}
          placeholder="Search subjects…"
          ariaLabel={t("Subject")}
        />
      </section>
      <div className="toolbar">
        <SearchBox
          value={search}
          onChange={(s) => {
            setSearch(s);
            setPage(1);
          }}
          placeholder={t("Search questions…")}
        />
        <Combo
          value={difficulty}
          options={[
            { value: "", label: t("All difficulties") },
            ...opts(["easy", "medium", "hard"]).map((o) => ({
              value: o.value,
              label: t(o.label),
            })),
          ]}
          onChange={(v) => {
            setDifficulty(v);
            setPage(1);
          }}
          placeholder="All difficulties"
          ariaLabel={t("Difficulty")}
        />
        <Combo
          value={hasImage}
          options={[
            { value: "", label: t("All questions") },
            { value: "true", label: t("With images") },
            { value: "false", label: t("Missing images") },
          ]}
          onChange={(v) => {
            setHasImage(v);
            setPage(1);
          }}
          ariaLabel={t("Filter by image")}
        />
      </div>
      <Feedback error={query.error} />
      {(query.isPending || query.isPlaceholderData) && selectedSubject ? (
        <Loading />
      ) : query.data?.rows.length ? (
        <section className="panel">
          {query.data.rows.map((q) => (
            <div className="bank-question" key={q.id}>
              <div>
                <div className="question-tags">
                  <Badge value={q.difficulty} />
                  <span
                    className={`img-flag ${q.imageUrl ? "has" : "missing"}`}
                    role="img"
                    aria-label={
                      q.imageUrl ? t("Has diagram") : t("No image attached")
                    }
                    title={
                      q.imageUrl ? t("Has diagram") : t("No image attached")
                    }
                  >
                    <ImageIcon size={13} />
                  </span>
                  <span>
                    {t(label(q.questionType))} · {q.grade}
                    {t(" marks ")}
                  </span>
                </div>
                <h3>{q.text}</h3>
                {q.imageUrl && (
                  <img
                    className="question-image"
                    src={
                      q.imageUrl.startsWith("/")
                        ? apiUrl(q.imageUrl)
                        : q.imageUrl
                    }
                    alt={t("Question diagram")}
                  />
                )}
                <div className="option-chips">
                  {q.options.map((o) => (
                    <span
                      key={o}
                      className={o === q.correctAnswer ? "correct" : ""}
                    >
                      {o}
                    </span>
                  ))}
                </div>
              </div>
              <div className="action-row">
                <button
                  className="icon-button"
                  aria-label={t("Edit question")}
                  onClick={() => {
                    action.reset();
                    setUploadError("");
                    setImageFile(null);
                    setCreatedQuestion(null);
                    setEdit(q);
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label={t("Delete question")}
                  onClick={() => {
                    action.reset();
                    setRemove(q);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : (
        <Empty
          title={t("No questions found")}
          text={t("Choose a subject, adjust your filters, or add a question.")}
        />
      )}
      <Pagination data={query.isPlaceholderData ? undefined : query.data} page={page} setPage={setPage} />
      {edit && (
        <QuestionSheet
          initial={edit === "new" ? {} : edit}
          subjectLocked={edit === "new"}
          busy={action.isPending || imageBusy}
          error={uploadError || action.error}
          onClose={() => setEdit(null)}
          onSubmit={async (body) => {
            setImageBusy(true); setUploadError("");
            try {
              const q = await action.mutateAsync({
                path: "/api/v1/question-bank" + (createdQuestion ? "/" + createdQuestion.id : edit === "new" ? "" : "/" + edit.id),
                method: edit === "new" && !createdQuestion ? "POST" : "PATCH",
                body: { ...body, ...(edit === "new" ? { subjectId: selectedSubject } : {}) },
              });
              // Retain the created ID if upload fails, so retry cannot create a duplicate.
              setCreatedQuestion(q);
              if (imageFile) {
                if (previewMode) throw new Error("Image uploads require the connected backend.");
                const data = new FormData(); data.set("image", imageFile);
                await api.upload(`/api/v1/question-bank/${q.id}/image`, data);
              }
              await query.refetch(); setEdit(null); setImageFile(null); setCreatedQuestion(null);
            } catch (err) { setUploadError(err instanceof Error ? err.message : "Upload failed"); }
            finally { setImageBusy(false); }
          }}
          imageUpload={<div className="field">
            <label htmlFor="qs-image">{t("Attach question image")}</label>
            {edit !== "new" && (edit as Question).imageUrl && !imageFile && (
              <div className="image-current">
                <img
                  className="question-image"
                  src={
                    String((edit as Question).imageUrl).startsWith("/")
                      ? apiUrl(String((edit as Question).imageUrl))
                      : String((edit as Question).imageUrl)
                  }
                  alt={t("Current diagram")}
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={imageBusy}
                  onClick={async () => {
                    setImageBusy(true);
                    setUploadError("");
                    try {
                      await api.delete(`/api/v1/question-bank/${(edit as Question).id}/image`);
                      await query.refetch();
                      setEdit({ ...(edit as Question), imageUrl: undefined });
                    } catch (err) {
                      setUploadError(err instanceof Error ? err.message : "Remove failed");
                    } finally {
                      setImageBusy(false);
                    }
                  }}
                >
                  {t(" Remove image ")}
                </button>
              </div>
            )}
            <input id="qs-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={imageBusy} onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
            {imageFile && <p>{imageFile.name}</p>}
          </div>}
        />
      )}
      {remove && (
        <Confirm
          title={t("Delete question?")}
          text={t(
            "Questions used by exams may be protected by the server. This cannot be undone.",
          )}
          onClose={() => setRemove(null)}
          error={action.error}
          busy={action.isPending || imageBusy}
          onConfirm={() =>
            action.mutate(
              { path: "/api/v1/question-bank/" + remove.id, method: "DELETE" },
              { onSuccess: () => setRemove(null) },
            )
          }
        />
      )}
    </>
  );
}
function studentInitials(name?: string | null) {
  if (!name) return "ST";
  const parts = name
    .replace(/^(Dr\.?|Prof\.?|Eng\.?)\s+/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "ST";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function downloadCsvFile(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
) {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join(
    "\r\n",
  );
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function Results({ user }: { user: SessionUser }) {
  const t = useT();
  const location = useLocation();
  const student = user.role === "student";
  const exams = useResource<Envelope<Exam>>(
    user,
    user.role === "admin"
      ? "/api/v1/admin/exams?limit=100"
      : "/api/v1/exams/mine?limit=100",
    !student,
  );
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("exam") ?? "",
  );
  const [search, setSearch] = useState("");
  const [sectionFilter, setSectionFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "grade_desc" | "grade_asc" | "status">("name");

  const examRows = rowsOf(exams.data);
  const selectedId = selected || examRows[0]?.id || "";
  const selectedExam = examRows.find((e) => e.id === selectedId);
  const mine = useResource<StudentResult[]>(
    user,
    "/api/v1/student/results",
    student,
  );
  const grouped = useResource<{
    groups: {
      sectionId?: string;
      sectionName: string;
      taName?: string;
      taUsername?: string | null;
      total: number;
      rows: Entity[];
    }[];
  }>(
    user,
    `/api/v1/exams/${selectedId}/results?limit=1000`,
    !student && !!selectedId,
  );

  const rawGroups = grouped.data?.groups ?? [];
  const allRows = rawGroups.flatMap((g) =>
    g.rows.map((r) => ({ ...r, _sectionName: g.sectionName, _taName: g.taName })),
  );
  const totalStudents = allRows.length;
  const submittedRows = allRows.filter((r) => {
    const st = String((r.exam as Entity)?.status ?? "not_started");
    return st === "submitted" || st === "auto_submitted";
  });
  const inProgressRows = allRows.filter(
    (r) => String((r.exam as Entity)?.status ?? "not_started") === "in_progress",
  );
  const notStartedRows = allRows.filter(
    (r) => String((r.exam as Entity)?.status ?? "not_started") === "not_started",
  );

  const gradedPercentages = submittedRows
    .map((r) => {
      const ex = r.exam as Entity | null;
      const g = Number(ex?.totalGrade);
      const m = Number(ex?.totalMarks);
      return Number.isFinite(g) && Number.isFinite(m) && m > 0 ? (g / m) * 100 : null;
    })
    .filter((v): v is number => v !== null);
  const avgPct = gradedPercentages.length
    ? Math.round(gradedPercentages.reduce((a, b) => a + b, 0) / gradedPercentages.length)
    : null;

  const q = search.trim().toLowerCase();
  const filteredGroups = rawGroups
    .filter((g) => !sectionFilter || g.sectionName === sectionFilter)
    .map((g) => {
      const rows = g.rows
        .filter((r) => {
          const ex = (r.exam as Entity) ?? null;
          const st = String(ex?.status ?? "not_started");
          if (statusFilter === "submitted" && st !== "submitted" && st !== "auto_submitted") {
            return false;
          }
          if (statusFilter === "in_progress" && st !== "in_progress") return false;
          if (statusFilter === "not_started" && st !== "not_started") return false;
          if (!q) return true;
          const hay = `${r.name ?? ""} ${r.username ?? ""} ${r.email ?? ""} ${ex?.notesForDoctor ?? ""} ${g.sectionName}`.toLowerCase();
          return hay.includes(q);
        })
        .slice()
        .sort((a, b) => {
          const exA = (a.exam as Entity) ?? null;
          const exB = (b.exam as Entity) ?? null;
          const gA = exA?.totalGrade != null ? Number(exA.totalGrade) : -1;
          const gB = exB?.totalGrade != null ? Number(exB.totalGrade) : -1;
          if (sortBy === "grade_desc") return gB - gA || String(a.name).localeCompare(String(b.name));
          if (sortBy === "grade_asc") return gA - gB || String(a.name).localeCompare(String(b.name));
          if (sortBy === "status") {
            return (
              String(exA?.status ?? "not_started").localeCompare(
                String(exB?.status ?? "not_started"),
              ) || String(a.name).localeCompare(String(b.name))
            );
          }
          return String(a.name ?? "").localeCompare(String(b.name ?? ""));
        });
      return { ...g, filteredRows: rows };
    })
    .filter((g) => g.filteredRows.length > 0 || (!q && !statusFilter));

  function exportFilteredCsv() {
    const csvRows: (string | number | null | undefined)[][] = [];
    for (const g of filteredGroups) {
      for (const r of g.filteredRows) {
        const ex = (r.exam as Entity) ?? null;
        const grade = ex?.totalGrade != null ? Number(ex.totalGrade) : null;
        const marks = ex?.totalMarks != null ? Number(ex.totalMarks) : null;
        const pct =
          grade != null && marks != null && marks > 0
            ? `${Math.round((grade / marks) * 100)}%`
            : "";
        csvRows.push([
          g.sectionName,
          g.taName ?? "",
          String(r.name ?? ""),
          String(r.username ?? ""),
          String(r.email ?? ""),
          r.academicYear != null ? String(r.academicYear) : "",
          grade != null ? grade : "",
          marks != null ? marks : "",
          pct,
          String(ex?.status ?? "not_started"),
          ex?.submittedAt ? `${date(String(ex.submittedAt))} ${time(String(ex.submittedAt))}` : "",
          ex?.notesForDoctor ? String(ex.notesForDoctor) : "",
        ]);
      }
    }
    const slug = (selectedExam ? nameOf(selectedExam) : "exam-results")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    downloadCsvFile(
      `${slug || "results"}-roster.csv`,
      [
        "Section",
        "TA",
        "Student Name",
        "Username",
        "Email",
        "Academic Year",
        "Grade",
        "Total Marks",
        "Percentage",
        "Status",
        "Submitted At",
        "Student Note",
      ],
      csvRows,
    );
  }

  return (
    <>
      <PageTitle
        title={t("Results")}
        description={
          student
            ? t("Grades from your completed assessments.")
            : t("Student grades, attempt statuses, and section performance.")
        }
        action={
          !student && selectedId ? (
            <div className="roster-header-actions">
              <button
                type="button"
                className="secondary"
                onClick={exportFilteredCsv}
                disabled={!allRows.length}
              >
                <Download size={15} />
                {t(" Quick CSV ")}
              </button>
              <Link className="button primary" to={"/exports?exam=" + selectedId}>
                <ArrowUpRight size={15} />
                {t(" Official export ")}
              </Link>
            </div>
          ) : undefined
        }
      />
      {!student && (
        <>
          <div className="toolbar">
            <Combo
              value={selectedId}
              options={examRows.map((e) => ({
                value: e.id,
                label: `${nameOf(e)} · ${date(e.startTime)} · ${t(label(e.type))}`,
              }))}
              onChange={(v) => {
                setSelected(v);
                setSectionFilter("");
              }}
              placeholder={t("Select assessment…")}
              ariaLabel={t("Select assessment")}
            />
            <button className="secondary" onClick={() => grouped.refetch()}>
              <RefreshCw size={15} />
              {t(" Refresh ")}
            </button>
            {typeof exams.data?.total === "number" &&
              exams.data.total > examRows.length && (
                <span className="subtle">
                  {t("Showing first {0} of {1}.", {
                    "0": examRows.length,
                    "1": exams.data.total,
                  })}
                </span>
              )}
          </div>

          {!grouped.isPending && allRows.length > 0 && (
            <>
              <div className="stat-grid four-col">
                <div className="stat-card">
                  <div>
                    <span>{t("Total students")}</span>
                    <Users size={18} />
                  </div>
                  <strong>{totalStudents}</strong>
                  <small>
                    {rawGroups.length} {t("sections in this assessment")}
                  </small>
                </div>
                <div className="stat-card">
                  <div>
                    <span>{t("Submitted")}</span>
                    <CheckCircle2 size={18} />
                  </div>
                  <strong>
                    {submittedRows.length}
                    <span className="stat-inline-pct">
                      {totalStudents > 0
                        ? ` (${Math.round((submittedRows.length / totalStudents) * 100)}%)`
                        : ""}
                    </span>
                  </strong>
                  <small>{t("Completed and graded attempts")}</small>
                </div>
                <div className="stat-card">
                  <div>
                    <span>{t("In progress / Not started")}</span>
                    <Clock size={18} />
                  </div>
                  <strong>
                    {inProgressRows.length} / {notStartedRows.length}
                  </strong>
                  <small>
                    {inProgressRows.length} {t("taking now")} · {notStartedRows.length}{" "}
                    {t("not started")}
                  </small>
                </div>
                <div className="stat-card">
                  <div>
                    <span>{t("Average score")}</span>
                    <GraduationCap size={18} />
                  </div>
                  <strong>{avgPct !== null ? `${avgPct}%` : "—"}</strong>
                  <small>
                    {gradedPercentages.length
                      ? `${gradedPercentages.length} ${t("graded submissions")}`
                      : t("No graded submissions yet")}
                  </small>
                </div>
              </div>

              <div className="roster-filter-bar panel">
                <SearchBox
                  value={search}
                  onChange={setSearch}
                  placeholder={t("Search student name, @username, email, or note…")}
                />
                {rawGroups.length > 1 && (
                  <Combo
                    value={sectionFilter}
                    options={[
                      { value: "", label: `${t("All sections")} (${rawGroups.length})` },
                      ...rawGroups.map((g) => ({
                        value: g.sectionName,
                        label: `${g.sectionName} (${g.rows.length})`,
                      })),
                    ]}
                    onChange={setSectionFilter}
                    ariaLabel={t("Filter by section")}
                  />
                )}
                <Combo
                  value={sortBy}
                  options={[
                    { value: "name", label: t("Sort: Name (A–Z)") },
                    { value: "grade_desc", label: t("Sort: Highest grade") },
                    { value: "grade_asc", label: t("Sort: Lowest grade") },
                    { value: "status", label: t("Sort: Attempt status") },
                  ]}
                  onChange={(v) => setSortBy((v || "name") as typeof sortBy)}
                  ariaLabel={t("Sort students")}
                />
                <div className="segmented" role="group" aria-label={t("Filter attempt status")}>
                  {[
                    ["", `${t("All")} (${totalStudents})`],
                    ["submitted", `${t("Submitted")} (${submittedRows.length})`],
                    ["in_progress", `${t("Taking")} (${inProgressRows.length})`],
                    ["not_started", `${t("Not started")} (${notStartedRows.length})`],
                  ].map(([val, lbl]) => (
                    <button
                      type="button"
                      key={val}
                      className={statusFilter === val ? "active" : ""}
                      onClick={() => setStatusFilter(val)}
                    >
                      {lbl}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}
      <Feedback error={student ? mine.error : grouped.error || exams.error} />
      {student ? (
        mine.isPending ? (
          <Loading />
        ) : mine.data?.length ? (
          <section className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("Assessment")}</th>
                  <th scope="col">{t("Submitted")}</th>
                  <th scope="col">{t("Grade")}</th>
                  <th scope="col">{t("Status")}</th>
                </tr>
              </thead>
              <tbody>
                {mine.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{nameOf(r.exam)}</b>
                      <small>{t(label(r.exam.type))}</small>
                    </td>
                    <td>{date(r.submittedAt)}</td>
                    <td>
                      {r.exam.resultsReleased === false ? (
                        <Badge value="awaiting release" />
                      ) : (
                        <strong>
                          {r.totalGrade ?? "—"}/{r.totalMarks ?? "—"}
                        </strong>
                      )}
                      {r.exam.resultsReleased !== false && t(" marks ")}
                    </td>
                    <td>
                      <Badge value={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <Empty
            title={t("No results yet")}
            text={t("Your grade will appear after you submit an assessment.")}
          />
        )
      ) : grouped.isPending && selectedId ? (
        <Loading />
      ) : filteredGroups.length ? (
        filteredGroups.map((g, i) => {
          const secSubmitted = g.rows.filter((r) => {
            const st = String((r.exam as Entity)?.status ?? "not_started");
            return st === "submitted" || st === "auto_submitted";
          });
          const secGrades = secSubmitted
            .map((r) => {
              const ex = r.exam as Entity | null;
              const gr = Number(ex?.totalGrade);
              const mk = Number(ex?.totalMarks);
              return Number.isFinite(gr) && Number.isFinite(mk) && mk > 0 ? (gr / mk) * 100 : null;
            })
            .filter((v): v is number => v !== null);
          const secAvg = secGrades.length
            ? Math.round(secGrades.reduce((a, b) => a + b, 0) / secGrades.length)
            : null;

          return (
            <section className="panel roster-section-panel" key={g.sectionId ?? i}>
              <div className="panel-heading">
                <div>
                  <div className="section-title-row">
                    <h2>{g.sectionName}</h2>
                    {g.taName && g.taName !== "—" && (
                      <span className="ta-pill">
                        {t("TA")}: <b>{g.taName}</b>
                        {g.taUsername ? ` (@${g.taUsername})` : ""}
                      </span>
                    )}
                    <span className="code-pill">
                      {g.filteredRows.length}
                      {g.filteredRows.length !== g.total ? ` / ${g.total}` : ""}{" "}
                      {t("students")}
                    </span>
                    <span className="dept-pill">
                      {secSubmitted.length}/{g.rows.length} {t("submitted")}
                    </span>
                    {secAvg !== null && (
                      <span
                        className={`score-pct-pill ${
                          secAvg >= 75 ? "good" : secAvg >= 50 ? "fair" : "low"
                        }`}
                      >
                        {t("Avg")}: {secAvg}%
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {g.filteredRows.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t("Student")}</th>
                        <th scope="col">{t("Grade & Percentage")}</th>
                        <th scope="col">{t("Submitted")}</th>
                        <th scope="col">{t("Status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.filteredRows.map((r) => {
                        const ex = (r.exam as Entity) ?? null;
                        const statusVal = String(ex?.status ?? "not_started");
                        const gradeNum =
                          ex?.totalGrade != null ? Number(ex.totalGrade) : null;
                        const marksNum =
                          ex?.totalMarks != null ? Number(ex.totalMarks) : null;
                        const pct =
                          gradeNum != null && marksNum != null && marksNum > 0
                            ? Math.round((gradeNum / marksNum) * 100)
                            : null;
                        const note = ex?.notesForDoctor ? String(ex.notesForDoctor) : "";
                        return (
                          <tr key={r.id}>
                            <td>
                              <div className="student-cell">
                                <span className="student-avatar-sm">
                                  {studentInitials(String(r.name ?? ""))}
                                </span>
                                <div>
                                  <b>{r.name}</b>
                                  <small className="student-meta-line">
                                    <span>@{r.username}</span>
                                    {r.email && <span>· {String(r.email)}</span>}
                                    {r.academicYear != null && (
                                      <span className="year-chip">
                                        {t("Year")} {String(r.academicYear)}
                                      </span>
                                    )}
                                  </small>
                                  {note && (
                                    <div className="student-doctor-note">
                                      <b>{t("Note")}:</b> {note}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td>
                              {gradeNum != null && marksNum != null ? (
                                <div className="grade-cell-wrap">
                                  <div className="grade-score-line">
                                    <strong>
                                      {gradeNum} / {marksNum}
                                    </strong>
                                    {pct !== null && (
                                      <span
                                        className={`score-pct-pill ${
                                          pct >= 75 ? "good" : pct >= 50 ? "fair" : "low"
                                        }`}
                                      >
                                        {pct}%
                                      </span>
                                    )}
                                  </div>
                                  {pct !== null && (
                                    <div className="mini-score-bar" aria-hidden="true">
                                      <span
                                        className={
                                          pct >= 75 ? "good" : pct >= 50 ? "fair" : "low"
                                        }
                                        style={{ width: `${Math.min(100, Math.max(4, pct))}%` }}
                                      />
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <span className="subtle">—</span>
                              )}
                            </td>
                            <td>
                              {ex?.submittedAt ? (
                                <div className="submitted-time-cell">
                                  <span>{date(String(ex.submittedAt))}</span>
                                  <small>{time(String(ex.submittedAt))}</small>
                                </div>
                              ) : (
                                <span className="subtle">—</span>
                              )}
                            </td>
                            <td>
                              <Badge value={statusVal} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title={t("No students match your filter in this section")} />
              )}
              {g.total > g.rows.length && (
                <p className="subtle">
                  {t(" Showing ")}
                  {g.rows.length}
                  {t(" of ")}
                  {g.total}
                  {t(". Export for the complete roster. ")}
                </p>
              )}
            </section>
          );
        })
      ) : (
        <Empty
          title={search || statusFilter ? t("No matching student results") : t("No section results")}
          text={
            search || statusFilter
              ? t("Try clearing your search or status filter.")
              : t("Select an assessment to review its roster.")
          }
        />
      )}
    </>
  );
}
export function Exports({ user }: { user: SessionUser }) {
  const t = useT();
  const location = useLocation();
  const query = useResource<Envelope<Entity>>(
    user,
    "/api/v1/exports?limit=100",
    true,
    5000,
  );
  const [modal, setModal] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const action = useAction(user, ["/api/v1/exports"]);
  const exams = useResource<Envelope<Exam>>(
    user,
    user.role === "admin"
      ? "/api/v1/admin/exams?limit=100"
      : "/api/v1/exams/mine?limit=100",
  );
  const staff = user.role !== "admin";
  // Subject names for staff cards (their /mine rows carry no subject object).
  const subjects = useResource<Envelope<Subject>>(
    user,
    "/api/v1/exams/subjects?limit=100",
    staff,
  );
  const subjectById = new Map(
    rowsOf(subjects.data).map((s) => [s.id, s as Subject]),
  );
  const examById = new Map(rowsOf(exams.data).map((e) => [e.id, e as Exam]));
  // Per-exam export dialog for staff: the exact exam is shown, never a bare id.
  const [exportExamId, setExportExamId] = useState("");
  const [exportFormat, setExportFormat] = useState("csv");
  // Freshly created job: scrolled into view and flashed once it arrives.
  const [freshJob, setFreshJob] = useState("");
  const exportExam = exportExamId ? examById.get(exportExamId) : undefined;
  function examSubject(e: Exam): string {
    const s = e.subject ?? subjectById.get(e.subjectId);
    return s ? `${s.code} · ${s.name}` : nameOf(e);
  }
  function examWindow(e: Exam): string {
    return `${date(e.startTime)} · ${time(e.startTime)} – ${time(e.endTime)} · ${e.durationMinutes}${t(" min")}`;
  }
  function jobTitle(r: Entity): string {
    const scope = String(r.scope ?? "results");
    if ((scope === "exam" || scope === "quiz") && r.examId) {
      const e = examById.get(String(r.examId));
      if (e) return `${examSubject(e)} · ${t(label(e.type))} · ${date(e.startTime)}`;
    }
    return t(label(scope));
  }
  async function download(r: Entity) {
    setDownloadError("");
    if (previewMode) {
      const csv = "Student,Grade,Status\n";
      const href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = href;
      a.download = "o6u-demo-results.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      return;
    }
    try {
      const path = `/api/v1/exports/${r.id}/download`;
      const res = await fetch(apiUrl(path), {
        credentials: "include",
        headers: await sebHeaders(path),
      });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      const downloadFormat = String(r.format ?? (r.params as Entity)?.format ?? "csv");
      a.download = `export-${r.id}.${downloadFormat === "xlsx" ? "xlsx" : "csv"}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Download failed");
    }
  }
  return (
    <>
      <PageTitle
        title={t("Exports")}
        description={t("Generate and download assessment records.")}
        action={
          !staff && (
            <button
              className="primary"
              onClick={() => {
                action.reset();
                setModal(true);
              }}
            >
              <Plus size={16} />
              {t(" New export ")}
            </button>
          )
        }
      />
      <Feedback error={query.error} />
      <Feedback error={downloadError || undefined} />
      {staff && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{t("Your exams & quizzes")}</h2>
              <p>
                {t(
                  "Export results only for assessments you created. Pick one to export its results.",
                )}
              </p>
            </div>
          </div>
          {exams.isPending ? (
            <Loading />
          ) : rowsOf(exams.data).length ? (
            <div className="assessment-list">
              {rowsOf(exams.data).map((e) => (
                <div key={e.id} className="upcoming-row">
                  <div>
                    <b>{examSubject(e as Exam)}</b>
                    <small>
                      {t(label((e as Exam).type))} · {examWindow(e as Exam)}
                    </small>
                  </div>
                  <Badge value={(e as Exam).status} />
                  <button
                    className="secondary"
                    onClick={() => {
                      action.reset();
                      setExportFormat("csv");
                      setExportExamId(e.id);
                    }}
                  >
                    <Download size={15} />
                    {t(" Export results ")}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title={t("No exams of your own yet")}
              text={t(
                "Assessments you create appear here with a one-click results export.",
              )}
            />
          )}
        </section>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.data?.rows.length ? (
        <section className="panel table-wrap" aria-label={t("Export history")}>
          <div className="panel-heading">
            <div>
              <h2>{t("Export history")}</h2>
              <p>{t("Newest first. Downloads appear when ready.")}</p>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("Export")}</th>
                <th scope="col">{t("Created")}</th>
                <th scope="col">{t("Format")}</th>
                <th scope="col">{t("Status")}</th>
                <th scope="col">{t("Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((r) => (
                <tr key={r.id} id={`export-${r.id}`} className={r.id === freshJob ? "flash-row" : ""}>
                  <td>
                    <b>{jobTitle(r)}</b>
                    <small>
                      {t("Requested")} {date(r.createdAt)}
                    </small>
                  </td>
                  <td>{date(r.createdAt)}</td>
                  <td>
                    {String(
                      r.format ?? (r.params as Entity)?.format ?? "csv",
                    ).toUpperCase()}
                  </td>
                  <td>
                    <Badge value={r.status} />
                  </td>
                  <td>
                    {r.status === "completed" || r.status === "done" ? (
                      <button
                        className="text-button"
                        onClick={() => download(r)}
                      >
                        <Download size={15} />
                        {t(" Download ")}
                      </button>
                    ) : r.status === "failed" && user.role === "admin" ? (
                      <button
                        className="text-button"
                        onClick={() =>
                          action.mutate({
                            path: "/api/v1/admin/exports/" + r.id + "/retry",
                          })
                        }
                      >
                        {t(" Retry ")}
                      </button>
                    ) : (
                      <span className="subtle">{t("Processing\u2026")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <Empty
          title={t("No export jobs")}
          text={t("Create an export to download assessment records.")}
        />
      )}
      {staff ? (
        exportExam && (          <Dialog
            title={t("Export results")}
            onClose={() => setExportExamId("")}
          >
            <div className="exam-summary">
              <div>
                <Badge value={exportExam.status} />
                <h2>{examSubject(exportExam)}</h2>
                <p>
                  {t(label(exportExam.type))} · {examWindow(exportExam)}
                </p>
              </div>
            </div>
            <p className="dialog-copy">
              {t(
                "This export contains only this assessment's results — nothing else.",
              )}
            </p>
            <form
              className="fields-form"
              onSubmit={(e) => {
                e.preventDefault();
                action.mutate(
                  {
                    path: "/api/v1/exports",
                    body: {
                      scope:
                        exportExam.type === "ta_quiz" ? "quiz" : "exam",
                      examId: exportExam.id,
                      format: exportFormat,
                    },
                  },
                  { onSuccess: (job) => {
                    setExportExamId("");
                    const created = job as unknown as { id?: string };
                    if (created?.id) {
                      setFreshJob(created.id);
                      setTimeout(() => {
                        document
                          .getElementById(`export-${created.id}`)
                          ?.scrollIntoView({ block: "center", behavior: "smooth" });
                      }, 1200);
                    }
                  } },
                );
              }}
            >
              <div className="field">
                <label htmlFor="export-format">{t("Format")}</label>
                <select
                  id="export-format"
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value)}
                >
                  <option value="csv">CSV</option>
                  <option value="xlsx">XLSX</option>
                </select>
              </div>
              <Feedback error={action.error} />
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setExportExamId("")}
                >
                  {t(" Cancel ")}
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={action.isPending}
                >
                  {action.isPending
                    ? t("Creating…")
                    : t("Create export")}
                </button>
              </div>
            </form>
          </Dialog>
        )
      ) : (
        modal && (
        <Dialog title={t("Create export")} onClose={() => setModal(false)}>
          <FieldsForm
            fields={[
              {
                key: "scope",
                label: "Scope",
                required: true,
                options: opts([
                  "exam",
                  "quiz",
                  ...(user.role === "admin" ? ["all"] : []),
                ]),
              },
              {
                key: "examId",
                label: "Assessment",
                options: rowsOf(exams.data).map((e) => ({
                  value: e.id,
                  label: nameOf(e) + " · " + date(e.startTime),
                })),
                value: new URLSearchParams(location.search).get("exam") ?? "",
              },
              {
                key: "format",
                label: "Format",
                required: true,
                options: opts(["csv", "xlsx"]),
                value: "csv",
              },
            ]}
            onSubmit={(body) =>
              action.mutate(
                { path: "/api/v1/exports", body },
                { onSuccess: () => setModal(false) },
              )
            }
            busy={action.isPending}
            error={action.error}
            submitLabel={t("Create export")}
          />
        </Dialog>
        )
      )}
    </>
  );
}
export function Profile({ user }: { user: SessionUser }) {
  const t = useT();
  const profile = useResource<Entity>(user, "/api/v1/student/me");
  const action = useAction(user, ["/api/v1/student/me"]);
  const [done, setDone] = useState(false);
  const [passwordFormVersion, setPasswordFormVersion] = useState(0);
  return (
    <>
      <PageTitle
        title={t("My account")}
        description={t("Your university profile and account security.")}
      />
      {<AccountGuide user={user} />}
      <div className="profile-grid">
        <section className="panel">
          <h2>{t("Profile details")}</h2>
          <dl className="details-list">
            {[
              ["Name", user.name],
              ["Username", user.username],
              ["Role", t(label(user.role))],
              ["Email", user.email],
              ["Academic term", (profile.data?.term as Entity)?.name],
            ].map(([title, value]) => (
              <div key={title}>
                <dt>{t(String(title))}</dt>
                <dd>{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="subtle">
            {t(
              " Profile details are managed by your university administrator. ",
            )}
          </p>
        </section>
        <section className="panel">
          <h2>{t("Change password")}</h2>
          {profile.isPending ? (
            <Loading />
          ) : profile.data?.canChangePassword === false ? (
            <p className="subtle">
              {t(
                " Your password is managed by your administrator. Contact your faculty to request a reset. ",
              )}
            </p>
          ) : (
            <>
              <p className="subtle">
                {t(
                  previewMode
                    ? "Use at least 8 characters. Demo password changes apply to this browser’s preview account."
                    : "Use at least 8 characters. Other sessions are revoked after a change.",
                )}
              </p>
              <FieldsForm
                key={passwordFormVersion}
                fields={[
                  {
                    key: "currentPassword",
                    label: "Current password",
                    type: "password",
                    required: true,
                  },
                  {
                    key: "newPassword",
                    label: "New password",
                    type: "password",
                    required: true,
                  },
                ]}
                busy={action.isPending}
                error={action.error}
                submitLabel={t("Update password")}
                onSubmit={(body) => {
                  setDone(false);
                  action.mutate(
                    { path: "/api/v1/student/change-password", body },
                    {
                      onSuccess: () => {
                        setDone(true);
                        setPasswordFormVersion((v) => v + 1);
                      },
                    },
                  );
                }}
              />
              {done && (
                <div className="success-banner" role="status">
                  {t(" Password updated. ")}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
export function Imports({ user }: { user: SessionUser }) {
  const t = useT();
  const location = useLocation();
  const question =
    new URLSearchParams(location.search).get("type") === "questions" ||
    user.role !== "admin";
  const [file, setFile] = useState<File | null>(null);
  const [images, setImages] = useState<File | null>(null);
  const [targetSubject, setTargetSubject] = useState("");
  const subjectsQ = useResource<Envelope<Subject>>(
    user,
    user.role === "admin"
      ? "/api/v1/admin/subjects?limit=100"
      : "/api/v1/exams/subjects?limit=100",
    question,
  );
  const [batch, setBatch] = useState<{
    batchId: string;
    valid: number;
    errors: {
      line: number;
      reason: string;
    }[];
    expiresAt: string;
    preview?: {
      line: number;
      text?: string;
      options?: string[];
      correctAnswer?: string;
      grade?: number;
      difficulty?: string;
      username?: string;
      fullName?: string;
      role?: string;
    }[];
    previewTruncated?: boolean;
    subject?: { code: string; name: string } | null;
  } | null>(null);
  const [done, setDone] = useState("");
  const action = useMutation({
    mutationFn: async (commit: boolean) => {
      if (previewMode)
        throw new Error(
          "Spreadsheet imports require the connected backend. Use manual entry in this demo.",
        );
      const base = question
        ? "/api/v1/question-bank/import"
        : "/api/v1/admin/users/import";
      if (commit && !question)
        return api.post<Entity>(base + "/commit", { batchId: batch?.batchId });
      const f = new FormData();
      if (commit) f.set("batchId", batch!.batchId);
      else if (file) f.set("file", file);
      if (!commit && question && targetSubject)
        f.set("subject_code", targetSubject);
      if (images) f.set("images", images);
      return api.upload<Entity>(base + (commit ? "/commit" : "/dry-run"), f);
    },
    onSuccess: (data, commit) => {
      if (commit) {
        setDone(
          `Import complete. ${String(data.created ?? data.imported ?? data.importedCount ?? "")} records processed.`,
        );
        setBatch(null);
        void invalidateResources(user.id, [
          "/api/v1/question-bank",
          "/api/v1/admin/users",
        ]);
      } else setBatch(data as unknown as typeof batch);
    },
  });
  return (
    <>
      <PageTitle
        title={question ? t("Import questions") : t("Import users")}
        description={t(
          "Validate spreadsheet rows before committing them to the university database.",
        )}
      />
      <section className="panel import-panel">
        <h2>{t("Upload spreadsheet")}</h2>
        <p className="subtle">
          {question
            ? t(
                "Required columns: subject_code, question_type, text, options (pipe-separated), correct_answer, grade, difficulty. Admin imports also require owner_type and owner.",
              )
            : t(
                "Required columns: username, password, full_name, role. Optional enrollment columns are documented in the backend import contract.",
              )}
        </p>
        <div className="field">
          <label htmlFor="sheet">{t("Excel file (.xlsx)")}</label>
          <input
            id="sheet"
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setBatch(null);
              setDone("");
            }}
          />
        </div>
        {question && (
          <div className="field">
            <span className="field-label">{t("Target subject")}</span>
            <Combo
              value={targetSubject}
              options={[
                { value: "", label: t("Use spreadsheet codes") },
                ...rowsOf(subjectsQ.data).map((x) => ({
                  value: x.code,
                  label: `${x.code} · ${x.name}`,
                })),
              ]}
              onChange={setTargetSubject}
              placeholder="Use spreadsheet codes"
              ariaLabel={t("Target subject")}
            />
            <small>
              {t("Every row goes to the chosen subject, ignoring spreadsheet codes.")}
            </small>
          </div>
        )}
        {question && (
          <div className="field">
            <label htmlFor="imageszip">
              {t("Question images ZIP (optional)")}
            </label>
            <input
              id="imageszip"
              type="file"
              accept=".zip"
              onChange={(e) => setImages(e.target.files?.[0] ?? null)}
            />
          </div>
        )}
        <Feedback error={action.error} />
        <button
          className="primary"
          disabled={!file || action.isPending}
          onClick={() => action.mutate(false)}
        >
          {action.isPending ? t("Processing…") : t("Validate spreadsheet")}
        </button>
        {done && <div className="success-banner">{done}</div>}
        {batch && (
          <div className="validation-report">
            <h3>
              {batch.valid}
              {t(" valid rows")}
              {batch.subject
                ? ` → ${batch.subject.code} · ${batch.subject.name}`
                : ""}
            </h3>
            <p className="subtle">
              {t(" Expires ")}
              {date(batch.expiresAt)} · {time(batch.expiresAt)}
            </p>
            {batch.errors.map((e, i) => (
              <p key={i} className="field-error">
                {t(" Row ")}
                {e.line}: {e.reason}
              </p>
            ))}
            {!!batch.preview?.length && (
              <div className="import-preview">
                <h3>
                  {t("Preview")} · {batch.valid}{" "}
                  {batch.previewTruncated
                    ? t("showing first {0}", { "0": batch.preview.length })
                    : t("rows")}
                </h3>
                {question ? (
                  batch.preview.map((r) => (
                    <div className="bank-question" key={r.line}>
                      <div>
                        <div className="question-tags">
                          {r.difficulty && <Badge value={r.difficulty} />}
                          <span>
                            {t("Row")} {r.line} · {r.grade} {t("marks")}
                          </span>
                        </div>
                        <h3>{r.text}</h3>
                        <div className="option-chips">
                          {(r.options ?? []).map((o) => (
                            <span
                              key={o}
                              className={o === r.correctAnswer ? "correct" : ""}
                            >
                              {o}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">{t("Row")}</th>
                          <th scope="col">{t("Username")}</th>
                          <th scope="col">{t("Full name")}</th>
                          <th scope="col">{t("Role")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batch.preview.map((r) => (
                          <tr key={r.line}>
                            <td>{r.line}</td>
                            <td><b>{r.username}</b></td>
                            <td>{r.fullName}</td>
                            <td><Badge value={r.role} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            <button
              className="primary"
              disabled={action.isPending || !batch.valid}
              onClick={() => action.mutate(true)}
            >
              {t(" Commit valid rows ")}
            </button>
          </div>
        )}
      </section>
    </>
  );
}

export interface RosterStudent {
  id: string;
  username: string;
  name: string;
  email: string;
  isActive: boolean;
  academicYear?: number | null;
  college?: string | null;
  collegeRef?: { id: string; code?: string; name: string } | null;
  department?: { id: string; code?: string; name: string } | null;
}

export interface RosterSection {
  id: string;
  name: string;
  ta: { id: string; name: string; username: string };
  students: RosterStudent[];
}

// Staff roster: my subjects' sections with TAs and students. Doctors see
// assigned subjects, TAs their own sections, admins everything (server-gated).
export function Roster({ user }: { user: SessionUser }) {
  const t = useT();
  const subjects = useResource<Envelope<Subject>>(
    user,
    "/api/v1/exams/subjects?limit=100",
  );
  const subjectList = rowsOf(subjects.data);
  const [subject, setSubject] = useState("");
  const [search, setSearch] = useState("");
  const [sectionFilter, setSectionFilter] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "username" | "year" | "section">("name");
  const [viewMode, setViewMode] = useState<"sections" | "cards" | "directory">("sections");

  const selected = subject || subjectList[0]?.id || "";
  const selectedSubj = subjectList.find((s) => s.id === selected);
  const roster = useResource<{
    totalEnrolled: number;
    enrolledStudents?: RosterStudent[];
    sections: RosterSection[];
  }>(user, `/api/v1/exams/roster?subject_id=${selected}`, !!selected);

  const secs = roster.data?.sections ?? [];
  const enrolledList = roster.data?.enrolledStudents ?? [];

  // Map each student to all sections they belong to in this subject.
  const studentSectionsMap = new Map<
    string,
    { sectionId: string; sectionName: string; taName: string; taUsername: string }[]
  >();
  for (const s of secs) {
    for (const st of s.students) {
      const arr = studentSectionsMap.get(st.id) ?? [];
      arr.push({
        sectionId: s.id,
        sectionName: s.name,
        taName: s.ta.name,
        taUsername: s.ta.username,
      });
      studentSectionsMap.set(st.id, arr);
    }
  }

  // Build deduplicated master student directory + identify students not in any section.
  const allStudentsMap = new Map<string, RosterStudent>();
  for (const st of enrolledList) allStudentsMap.set(st.id, st);
  for (const s of secs) {
    for (const st of s.students) {
      if (!allStudentsMap.has(st.id)) allStudentsMap.set(st.id, st);
    }
  }
  const allStudents = [...allStudentsMap.values()];
  const inSectionCount = studentSectionsMap.size;
  const unassignedStudents = allStudents.filter((st) => !studentSectionsMap.has(st.id));

  // Build effective sections list (including an "Unassigned / Direct Enrollment" group when applicable).
  const displaySections: (RosterSection & { isUnassigned?: boolean })[] = [
    ...secs,
    ...(unassignedStudents.length > 0
      ? [
          {
            id: "__unassigned__",
            name: t("Direct Enrollment (No Section)"),
            ta: { id: "", name: "—", username: "" },
            students: unassignedStudents,
            isUnassigned: true,
          },
        ]
      : []),
  ];

  const uniqueTas = new Set(secs.map((s) => s.ta.id).filter(Boolean));
  const activeStudentsCount = allStudents.filter((st) => st.isActive).length;
  const availableYears = [
    ...new Set(
      allStudents
        .map((st) => st.academicYear)
        .filter((y): y is number => typeof y === "number"),
    ),
  ].sort((a, b) => a - b);

  const q = search.trim().toLowerCase();
  const matchesStudent = (st: RosterStudent, secName?: string, taName?: string) => {
    if (yearFilter && String(st.academicYear ?? "") !== yearFilter) return false;
    if (statusFilter === "active" && !st.isActive) return false;
    if (statusFilter === "inactive" && st.isActive) return false;
    if (!q) return true;
    const secLabels =
      secName ??
      (studentSectionsMap.get(st.id)?.map((x) => `${x.sectionName} ${x.taName}`).join(" ") || "");
    const hay = `${st.name} ${st.username} ${st.email} ${st.collegeRef?.name ?? st.college ?? ""} ${st.department?.name ?? ""} ${secLabels} ${taName ?? ""}`.toLowerCase();
    return hay.includes(q);
  };

  const sortStudents = (list: RosterStudent[]) =>
    list.slice().sort((a, b) => {
      if (sortBy === "username") return a.username.localeCompare(b.username);
      if (sortBy === "year") {
        return (a.academicYear ?? 99) - (b.academicYear ?? 99) || a.name.localeCompare(b.name);
      }
      if (sortBy === "section") {
        const sA = studentSectionsMap.get(a.id)?.[0]?.sectionName ?? "zzz";
        const sB = studentSectionsMap.get(b.id)?.[0]?.sectionName ?? "zzz";
        return sA.localeCompare(sB) || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });

  const filteredSections = displaySections
    .filter((s) => !sectionFilter || s.id === sectionFilter)
    .map((s) => ({
      ...s,
      filteredStudents: sortStudents(
        s.students.filter((st) => matchesStudent(st, s.name, s.ta.name)),
      ),
    }))
    .filter(
      (s) => s.filteredStudents.length > 0 || (!q && !yearFilter && !statusFilter),
    );

  const filteredAllStudents = sortStudents(
    allStudents.filter((st) => {
      if (sectionFilter) {
        if (sectionFilter === "__unassigned__") {
          if (studentSectionsMap.has(st.id)) return false;
        } else {
          const secsForSt = studentSectionsMap.get(st.id) ?? [];
          if (!secsForSt.some((x) => x.sectionId === sectionFilter)) return false;
        }
      }
      return matchesStudent(st);
    }),
  );

  function exportRosterCsv() {
    const rows: (string | number | null | undefined)[][] = filteredAllStudents.map((st) => {
      const secsForSt = studentSectionsMap.get(st.id) ?? [];
      return [
        st.name,
        st.username,
        st.email,
        secsForSt.map((x) => x.sectionName).join("; ") || t("Direct Enrollment (No Section)"),
        secsForSt.map((x) => x.taName).join("; ") || "—",
        st.academicYear ?? "",
        st.department?.name ?? "",
        st.collegeRef?.name ?? st.college ?? "",
        st.isActive ? "active" : "inactive",
      ];
    });
    const code = (selectedSubj?.code || "subject").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    downloadCsvFile(
      `${code}-student-roster.csv`,
      [
        "Student Name",
        "Username",
        "Email",
        "Sections",
        "Teaching Assistant",
        "Academic Year",
        "Department",
        "College",
        "Status",
      ],
      rows,
    );
  }

  return (
    <>
      <PageTitle
        title={t("Student Roster")}
        description={
          user.role === "ta"
            ? t("Your assigned teaching sections and enrolled students.")
            : t("Sections, teaching assistants, and enrolled students across your subjects.")
        }
        action={
          selected && allStudents.length > 0 ? (
            <div className="roster-header-actions">
              <button type="button" className="secondary" onClick={() => roster.refetch()}>
                <RefreshCw size={15} />
                {t(" Refresh ")}
              </button>
              <button type="button" className="primary" onClick={exportRosterCsv}>
                <Download size={15} />
                {t(" Export CSV ")} ({filteredAllStudents.length})
              </button>
            </div>
          ) : undefined
        }
      />

      {/* Subject Switcher Bar */}
      <div className="roster-subject-bar panel">
        <div className="roster-subject-picker">
          <Combo
            value={selected}
            options={subjectList.map((s) => ({
              value: s.id,
              label: `${s.code} · ${s.name}`,
            }))}
            onChange={(v) => {
              setSubject(v);
              setSectionFilter("");
            }}
            placeholder={t("Search subjects…")}
            ariaLabel={t("Subject")}
          />
          {selectedSubj && (
            <div className="card-badge-group">
              <span className="code-pill">{selectedSubj.code}</span>
              {(selectedSubj as Entity).department && (
                <span className="dept-pill">
                  {String(((selectedSubj as Entity).department as Entity)?.name ?? "")}
                </span>
              )}
            </div>
          )}
        </div>
        {subjectList.length > 1 && subjectList.length <= 8 && (
          <div className="subject-quick-pills" role="tablist" aria-label={t("Quick subject switch")}>
            {subjectList.map((s) => (
              <button
                type="button"
                key={s.id}
                className={`subject-quick-pill ${s.id === selected ? "active" : ""}`}
                onClick={() => {
                  setSubject(s.id);
                  setSectionFilter("");
                }}
              >
                <b>{s.code}</b>
                <span>{s.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <Feedback error={subjects.error || roster.error} />

      {roster.isPending && selected ? (
        <Loading />
      ) : allStudents.length > 0 || secs.length > 0 ? (
        <>
          {/* Summary Metrics */}
          <div className="stat-grid four-col">
            <div className="stat-card">
              <div>
                <span>{t("Total students")}</span>
                <Users size={18} />
              </div>
              <strong>{roster.data?.totalEnrolled || allStudents.length}</strong>
              <small>
                {user.role === "ta"
                  ? t("Students across your sections")
                  : t("Enrolled in this subject")}
              </small>
            </div>
            <div className="stat-card">
              <div>
                <span>{t("Teaching sections")}</span>
                <BookOpen size={18} />
              </div>
              <strong>{secs.length}</strong>
              <small>
                {uniqueTas.size} {t("teaching assistants assigned")}
              </small>
            </div>
            <div className="stat-card">
              <div>
                <span>{t("Section placement")}</span>
                <Building2 size={18} />
              </div>
              <strong>
                {inSectionCount}
                {unassignedStudents.length > 0 ? ` / ${allStudents.length}` : ""}
              </strong>
              <small>
                {unassignedStudents.length > 0
                  ? `${unassignedStudents.length} ${t("in direct enrollment (no section)")}`
                  : t("All students placed in sections")}
              </small>
            </div>
            <div className="stat-card">
              <div>
                <span>{t("Active accounts")}</span>
                <GraduationCap size={18} />
              </div>
              <strong>
                {activeStudentsCount}
                <span className="stat-inline-pct">
                  {allStudents.length > 0
                    ? ` (${Math.round((activeStudentsCount / allStudents.length) * 100)}%)`
                    : ""}
                </span>
              </strong>
              <small>
                {availableYears.length
                  ? `${t("Academic years")}: ${availableYears.map((y) => `Y${y}`).join(", ")}`
                  : t("Verified student accounts")}
              </small>
            </div>
          </div>

          {/* Interactive Section Overview Cards */}
          {displaySections.length > 1 && (
            <div className="roster-section-strip">
              <button
                type="button"
                className={`roster-sec-card ${sectionFilter === "" ? "active" : ""}`}
                onClick={() => setSectionFilter("")}
              >
                <div className="roster-sec-card-top">
                  <b>{t("All Sections")}</b>
                  <span className="code-pill">{allStudents.length}</span>
                </div>
                <small>
                  {secs.length} {t("sections")} · {uniqueTas.size} {t("TAs")}
                </small>
              </button>
              {displaySections.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={`roster-sec-card ${sectionFilter === s.id ? "active" : ""} ${
                    s.isUnassigned ? "unassigned" : ""
                  }`}
                  onClick={() =>
                    setSectionFilter((cur) => (cur === s.id ? "" : s.id))
                  }
                >
                  <div className="roster-sec-card-top">
                    <b>{s.name}</b>
                    <span className={s.isUnassigned ? "college-pill" : "code-pill"}>
                      {s.students.length}
                    </span>
                  </div>
                  <small>
                    {s.isUnassigned
                      ? t("Not assigned to a TA section")
                      : `${t("TA")}: ${s.ta.name} (@${s.ta.username})`}
                  </small>
                </button>
              ))}
            </div>
          )}

          {/* Search, Filter, Sort & View Mode Toolbar */}
          <div className="roster-filter-bar panel">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder={t("Search by student name, @username, email, college, or TA…")}
            />
            {displaySections.length > 1 && (
              <Combo
                value={sectionFilter}
                options={[
                  { value: "", label: `${t("All sections")} (${allStudents.length})` },
                  ...displaySections.map((s) => ({
                    value: s.id,
                    label: `${s.name} (${s.students.length})`,
                  })),
                ]}
                onChange={setSectionFilter}
                ariaLabel={t("Filter by section")}
              />
            )}
            {availableYears.length > 1 && (
              <Combo
                value={yearFilter}
                options={[
                  { value: "", label: t("All academic years") },
                  ...availableYears.map((y) => ({
                    value: String(y),
                    label: `${t("Year")} ${y}`,
                  })),
                ]}
                onChange={setYearFilter}
                ariaLabel={t("Filter by academic year")}
              />
            )}
            <Combo
              value={statusFilter}
              options={[
                { value: "", label: t("All statuses") },
                { value: "active", label: t("Active only") },
                { value: "inactive", label: t("Inactive only") },
              ]}
              onChange={setStatusFilter}
              ariaLabel={t("Filter by account status")}
            />
            <Combo
              value={sortBy}
              options={[
                { value: "name", label: t("Sort: Name (A–Z)") },
                { value: "username", label: t("Sort: Username") },
                { value: "year", label: t("Sort: Academic year") },
                { value: "section", label: t("Sort: Section") },
              ]}
              onChange={(v) => setSortBy((v || "name") as typeof sortBy)}
              ariaLabel={t("Sort students")}
            />
            <div className="segmented" role="group" aria-label={t("View mode")}>
              <button
                type="button"
                className={viewMode === "sections" ? "active" : ""}
                onClick={() => setViewMode("sections")}
              >
                <List size={14} />
                {t("Sections")}
              </button>
              <button
                type="button"
                className={viewMode === "cards" ? "active" : ""}
                onClick={() => setViewMode("cards")}
              >
                <LayoutGrid size={14} />
                {t("Cards")}
              </button>
              <button
                type="button"
                className={viewMode === "directory" ? "active" : ""}
                onClick={() => setViewMode("directory")}
              >
                <Users size={14} />
                {t("Directory")}
              </button>
            </div>
          </div>

          {/* Active Filter Summary Chip Bar */}
          {(search || sectionFilter || yearFilter || statusFilter) && (
            <div className="active-filters-bar">
              <span className="subtle">
                {t("Showing")} <b>{filteredAllStudents.length}</b> {t("of")}{" "}
                {allStudents.length} {t("students")}
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setSearch("");
                  setSectionFilter("");
                  setYearFilter("");
                  setStatusFilter("");
                }}
              >
                {t("Clear all filters")}
              </button>
            </div>
          )}

          {/* VIEW 1: Grouped by Section */}
          {viewMode === "sections" &&
            (filteredSections.length ? (
              filteredSections.map((s) => (
                <section className="panel roster-section-panel" key={s.id}>
                  <div className="panel-heading">
                    <div>
                      <div className="section-title-row">
                        <h2>{s.name}</h2>
                        {!s.isUnassigned ? (
                          <span className="ta-pill">
                            {t("TA")}: <b>{s.ta.name}</b> (@{s.ta.username})
                          </span>
                        ) : (
                          <span className="college-pill">
                            {t("Enrolled in subject · No section assigned")}
                          </span>
                        )}
                        <span className="code-pill">
                          {s.filteredStudents.length}
                          {s.filteredStudents.length !== s.students.length
                            ? ` / ${s.students.length}`
                            : ""}{" "}
                          {t("students")}
                        </span>
                      </div>
                    </div>
                  </div>
                  {s.filteredStudents.length ? (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">{t("Student")}</th>
                            <th scope="col">{t("Email")}</th>
                            <th scope="col">{t("Academic Year")}</th>
                            <th scope="col">{t("College & Department")}</th>
                            <th scope="col">{t("Status")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.filteredStudents.map((st) => (
                            <tr key={st.id}>
                              <td>
                                <div className="student-cell">
                                  <span className="student-avatar-sm">
                                    {studentInitials(st.name)}
                                  </span>
                                  <div>
                                    <b>{st.name}</b>
                                    <small className="student-meta-line">
                                      @{st.username}
                                    </small>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <span className="student-email-cell">
                                  <Mail size={13} />
                                  {st.email}
                                </span>
                              </td>
                              <td>
                                {st.academicYear != null ? (
                                  <span className="year-chip">
                                    {t("Year")} {st.academicYear}
                                  </span>
                                ) : (
                                  <span className="subtle">—</span>
                                )}
                              </td>
                              <td>
                                <div className="card-badge-group">
                                  {(st.collegeRef?.name || st.college) && (
                                    <span className="college-pill">
                                      {st.collegeRef?.code || st.collegeRef?.name || st.college}
                                    </span>
                                  )}
                                  {st.department?.name && (
                                    <span className="dept-pill">{st.department.name}</span>
                                  )}
                                  {!st.collegeRef?.name && !st.college && !st.department?.name && (
                                    <span className="subtle">—</span>
                                  )}
                                </div>
                              </td>
                              <td>
                                <Badge value={st.isActive ? "active" : "inactive"} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty title={t("No students in this section")} />
                  )}
                </section>
              ))
            ) : (
              <Empty
                title={t("No students match your filters")}
                text={t("Try clearing your search query or section filters.")}
              />
            ))}

          {/* VIEW 2: Student Cards Grid */}
          {viewMode === "cards" &&
            (filteredAllStudents.length ? (
              <div className="student-roster-grid">
                {filteredAllStudents.map((st) => {
                  const secsForSt = studentSectionsMap.get(st.id) ?? [];
                  return (
                    <article className="student-roster-card" key={st.id}>
                      <div className="student-roster-card-head">
                        <span className="student-avatar-lg">
                          {studentInitials(st.name)}
                        </span>
                        <div className="student-roster-card-title">
                          <h3>{st.name}</h3>
                          <small>@{st.username}</small>
                        </div>
                        <Badge value={st.isActive ? "active" : "inactive"} />
                      </div>
                      <div className="student-roster-card-meta">
                        <div className="student-meta-item">
                          <Mail size={13} />
                          <span>{st.email}</span>
                        </div>
                        <div className="card-badge-group">
                          {st.academicYear != null && (
                            <span className="year-chip">
                              {t("Year")} {st.academicYear}
                            </span>
                          )}
                          {(st.collegeRef?.name || st.college) && (
                            <span className="college-pill">
                              {st.collegeRef?.name || st.college}
                            </span>
                          )}
                          {st.department?.name && (
                            <span className="dept-pill">{st.department.name}</span>
                          )}
                        </div>
                      </div>
                      <div className="student-roster-card-footer">
                        {secsForSt.length ? (
                          secsForSt.map((sec) => (
                            <div className="student-sec-tag" key={sec.sectionId}>
                              <b>{sec.sectionName}</b>
                              <span>
                                {t("TA")}: {sec.taName}
                              </span>
                            </div>
                          ))
                        ) : (
                          <div className="student-sec-tag unassigned">
                            <b>{t("Direct Enrollment")}</b>
                            <span>{t("No TA section assigned")}</span>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <Empty
                title={t("No students match your filters")}
                text={t("Try clearing your search query or section filters.")}
              />
            ))}

          {/* VIEW 3: Unified Directory Table */}
          {viewMode === "directory" &&
            (filteredAllStudents.length ? (
              <section className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t("Student")}</th>
                      <th scope="col">{t("Section & TA")}</th>
                      <th scope="col">{t("Academic Year")}</th>
                      <th scope="col">{t("College & Department")}</th>
                      <th scope="col">{t("Email")}</th>
                      <th scope="col">{t("Status")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAllStudents.map((st) => {
                      const secsForSt = studentSectionsMap.get(st.id) ?? [];
                      return (
                        <tr key={st.id}>
                          <td>
                            <div className="student-cell">
                              <span className="student-avatar-sm">
                                {studentInitials(st.name)}
                              </span>
                              <div>
                                <b>{st.name}</b>
                                <small className="student-meta-line">
                                  @{st.username}
                                </small>
                              </div>
                            </div>
                          </td>
                          <td>
                            {secsForSt.length ? (
                              <div className="card-badge-group">
                                {secsForSt.map((sec) => (
                                  <span className="ta-pill" key={sec.sectionId}>
                                    <b>{sec.sectionName}</b> · {sec.taName}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="college-pill">
                                {t("Direct Enrollment")}
                              </span>
                            )}
                          </td>
                          <td>
                            {st.academicYear != null ? (
                              <span className="year-chip">
                                {t("Year")} {st.academicYear}
                              </span>
                            ) : (
                              <span className="subtle">—</span>
                            )}
                          </td>
                          <td>
                            <div className="card-badge-group">
                              {(st.collegeRef?.name || st.college) && (
                                <span className="college-pill">
                                  {st.collegeRef?.code || st.collegeRef?.name || st.college}
                                </span>
                              )}
                              {st.department?.name && (
                                <span className="dept-pill">{st.department.name}</span>
                              )}
                              {!st.collegeRef?.name && !st.college && !st.department?.name && (
                                <span className="subtle">—</span>
                              )}
                            </div>
                          </td>
                          <td>{st.email}</td>
                          <td>
                            <Badge value={st.isActive ? "active" : "inactive"} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            ) : (
              <Empty
                title={t("No students match your filters")}
                text={t("Try clearing your search query or section filters.")}
              />
            ))}
        </>
      ) : (
        !roster.error && (
          <Empty
            title={t("No roster to show")}
            text={t("Pick a subject you are assigned to.")}
          />
        )
      )}
    </>
  );
}

