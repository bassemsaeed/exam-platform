import { BulkUsers } from "../components/BulkUsers";
import { useT } from "../lib/i18n";
import { useEffect, useState } from "react";
import { Link, useParams, useLocation } from "react-router-dom";
import { Plus, Pencil, Trash2, ArrowUpRight } from "lucide-react";
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
    label: String(r.name ?? r.username ?? r.id),
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
    { key: "college", label: "College" },
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
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [assignment, setAssignment] = useState("doctors");
  const [resetUser, setResetUser] = useState<Entity | null>(null);
  const [resetSuccess, setResetSuccess] = useState("");
  const [resetMismatch, setResetMismatch] = useState("");
  useEffect(
    () => setSelectedUsers([]),
    [resource, page, roleFilter, activeFilter, departmentFilter, search],
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
  const query = useResource<Envelope<Entity> | Entity[]>(
    user,
    `${path}?page=${page}&limit=20${resource === "users" ? `&role=${roleFilter}&active=${activeFilter}&department_id=${departmentFilter}` : ""}${["users", "subjects", "departments", "sections"].includes(resource) ? "&search=" + encodeURIComponent(search) : ""}`,
  );
  const subjects = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/subjects?limit=100",
    ["sections", "assignments"].includes(resource),
  );
  const terms = useResource<Entity[]>(
    user,
    "/api/v1/admin/terms",
    ["sections", "assignments"].includes(resource),
  );
  const users = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/users?limit=100",
    ["sections", "assignments"].includes(resource),
  );
  const departments = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/departments?limit=100",
    ["users", "subjects"].includes(resource),
  );
  const tasSections = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/sections?limit=100",
    resource === "assignments" && assignment === "tas",
  );
  const action = useAction(user, [path, "/api/v1/exams"]);
  useEffect(() => {
    setPage(1);
    setSearch(new URLSearchParams(location.search).get("search") ?? "");
    setRoleFilter("");
    setActiveFilter("");
    setDepartmentFilter("");
    setEdit(null);
    setRemove(null);
    setRoster(null);
  }, [resource, location.search]);
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
        options: pick(rowsOf(users.data).filter((r) => r.role === "ta")),
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
              options: pick(
                rowsOf(users.data).filter((r) => r.role === "ta"),
              ),
            },
          ]
        : [
            {
              key: assignment === "doctors" ? "doctorId" : "studentId",
              label: assignment === "doctors" ? "Educator" : "Student",
              required: true,
              options: pick(
                rowsOf(users.data).filter(
                  (r) =>
                    r.role === (assignment === "doctors" ? "doctor" : "student"),
                ),
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
              options: pick(rowsOf(terms.data)),
            },
          ];
  const columns: Record<string, string[]> = {
    users: ["name", "username", "role", "isActive"],
    subjects: ["code", "name", "department"],
    departments: ["code", "name"],
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
  return (
    <>
      <PageTitle
        title={title}
        description={
          resource === "audit"
            ? t("Review administrative activity and accountability.")
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
        ) : (
          ["users", "subjects", "departments", "sections"].includes(
            resource,
          ) && (
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
      <Feedback error={!edit && !remove && !current ? action.error : null} />
      {query.isPending ? (
        <Loading />
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
                <tr key={r.id ?? i}>
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
          title={edit === "new" ? "Add record" : "Edit record"}
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
  const doctorAssignments = useResource<Envelope<Entity> | Entity[]>(
    user,
    "/api/v1/admin/assignments/doctors",
  );
  const enrollments = useResource<Envelope<Entity> | Entity[]>(
    user,
    "/api/v1/admin/assignments/enrollments",
  );
  const taSections = useResource<Envelope<Entity>>(
    user,
    "/api/v1/admin/sections?limit=100",
  );
  const action = useAction(user, [
    "/api/v1/admin/users",
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
  async function addMany(path: string, bodies: Record<string, unknown>[], done: string, clear: () => void) {
    setAssignDone("");
    try {
      await Promise.all(bodies.map((body) => action.mutateAsync({ path, body })));
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
                {["username", "email", "role", "college", "academicYear"].map(
                  (k) => (
                    <div key={k}>
                      <dt>{t(label(k))}</dt>
                      <dd>{display(query.data?.[k])}</dd>
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
                          <tr key={String(a.id ?? i)}>
                            <td>{display(a.subject)}</td>
                            <td>{display(a.term)}</td>
                            <td>
                              <button
                                className="text-button"
                                disabled={action.isPending}
                                onClick={() =>
                                  action.mutate({
                                    path: "/api/v1/admin/assignments/doctors",
                                    method: "DELETE",
                                    body: Object.fromEntries(
                                      ["doctorId", "subjectId", "termId"]
                                        .filter((k) => a[k])
                                        .map((k) => [k, a[k]]),
                                    ),
                                  })
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
                          <tr key={String(a.id ?? i)}>
                            <td>{display(a.subject)}</td>
                            <td>{display(a.term)}</td>
                            <td>
                              <button
                                className="text-button"
                                disabled={action.isPending}
                                onClick={() =>
                                  action.mutate({
                                    path: "/api/v1/admin/assignments/enrollments",
                                    method: "DELETE",
                                    body: Object.fromEntries(
                                      ["studentId", "subjectId", "termId"]
                                        .filter((k) => a[k])
                                        .map((k) => [k, a[k]]),
                                    ),
                                  })
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
                      { onSuccess: () => setTaSection("") },
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
              { key: "college", label: "College" },
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
