import {
  changeDemoPassword,
  setDemoPassword,
  resetDemoPassword,
} from "./demo-auth";
import { ApiError } from "./api";
import type { Entity, Exam, Question, Sitting } from "./platform";
const key = "o6u-demo-data-v2";
type Db = Record<string, Entity[]>;
const iso = (days = 0, hours = 0) =>
  new Date(Date.now() + days * 86400000 + hours * 3600000).toISOString();
function initial(): Db {
  const subjects = [
    { id: "s1", code: "CS301", name: "Database Systems", departmentId: "d1" },
    { id: "s2", code: "CS204", name: "Data Structures", departmentId: "d1" },
    {
      id: "s3",
      code: "MA201",
      name: "Discrete Mathematics",
      departmentId: "d2",
    },
  ];
  const questions: Question[] = [
    ["Which SQL clause filters grouped results?", "HAVING", "easy"],
    [
      "Which property guarantees all-or-nothing transactions?",
      "Atomicity",
      "medium",
    ],
    ["A primary key can contain duplicate values.", "False", "easy"],
    [
      "Which normal form removes transitive dependencies?",
      "Third normal form",
      "hard",
    ],
    [
      "Which index structure is commonly used for range queries?",
      "B-tree",
      "medium",
    ],
    ["What does a foreign key enforce?", "Referential integrity", "easy"],
  ].map((q, i) => ({
    id: "q" + i,
    subjectId: "s1",
    text: q[0],
    questionType: i === 2 ? "true_false" : "mcq",
    options:
      i === 2
        ? ["True", "False"]
        : [
            q[1],
            ...["GROUP BY", "Isolation", "Hash table"].filter(
              (x) => x !== q[1],
            ),
          ],
    correctAnswer: q[1],
    grade: 2,
    difficulty: q[2],
    ownerType: "doctor",
  }));
  const exams = [
    {
      id: "e1",
      subjectId: "s1",
      type: "doctor_exam",
      status: "approved",
      startTime: iso(0, -1),
      endTime: iso(0, 3),
      durationMinutes: 45,
      difficultyMix: { easy: 3, medium: 2, hard: 1 },
    },
    {
      id: "e2",
      subjectId: "s2",
      type: "ta_quiz",
      status: "approved",
      startTime: iso(2),
      endTime: iso(2, 2),
      durationMinutes: 20,
      difficultyMix: { easy: 3, medium: 2 },
    },
    {
      id: "e3",
      subjectId: "s1",
      type: "doctor_exam",
      status: "pending_approval",
      startTime: iso(5),
      endTime: iso(5, 2),
      durationMinutes: 60,
      difficultyMix: { easy: 3, medium: 2, hard: 1 },
    },
    {
      id: "e4",
      subjectId: "s3",
      type: "doctor_exam",
      status: "approved",
      startTime: iso(-8),
      endTime: iso(-8, 2),
      durationMinutes: 60,
      difficultyMix: { easy: 3, medium: 2 },
    },
    {
      id: "e5",
      subjectId: "s1",
      type: "doctor_exam",
      status: "rejected",
      startTime: iso(6),
      endTime: iso(6, 2),
      durationMinutes: 45,
      rejectionReason: "Please revise the difficulty distribution.",
    },
  ].map((e) => ({
    ...e,
    subject: subjects.find((s) => s.id === e.subjectId),
    createdBy: "preview-doctor",
    termId: "t1",
    targetScope: "subject",
  })) as Exam[];
  return {
    subjects,
    exams,
    questions,
    users: [
      {
        id: "preview-student",
        name: "Alex Morgan",
        username: "alex.morgan",
        email: "alex.morgan@example.edu",
        role: "student",
        isActive: true,
      },
      {
        id: "preview-doctor",
        name: "Dr. Ahmed Hassan",
        username: "ahmed.hassan",
        role: "doctor",
        isActive: true,
      },
      {
        id: "preview-ta",
        name: "Mariam Ali",
        username: "mariam.ali",
        role: "ta",
        isActive: true,
      },
      {
        id: "preview-admin",
        name: "O6U Administrator",
        username: "o6u.admin",
        role: "admin",
        isActive: true,
      },
      {
        id: "u2",
        name: "Sara Mahmoud",
        username: "sara.mahmoud",
        role: "student",
        isActive: true,
      },
    ],
    departments: [
      { id: "d1", code: "CS", name: "Computer Science" },
      { id: "d2", code: "MA", name: "Mathematics" },
    ],
    terms: [
      {
        id: "t1",
        name: "Fall 2026",
        startsOn: "2026-09-01T00:00:00Z",
        endsOn: "2027-01-31T00:00:00Z",
        isCurrent: true,
      },
    ],
    sections: [
      {
        id: "sec1",
        name: "Section A",
        subjectId: "s1",
        termId: "t1",
        taId: "preview-ta",
        subject: subjects[0],
        ta: { name: "Mariam Ali" },
        _count: { memberships: 24 },
      },
      {
        id: "sec2",
        name: "Section B",
        subjectId: "s1",
        termId: "t1",
        taId: "preview-ta",
        subject: subjects[0],
        _count: { memberships: 22 },
      },
    ],
    results: [
      {
        id: "r1",
        status: "submitted",
        totalGrade: 9,
        submittedAt: iso(-8),
        exam: exams[3],
      },
      {
        id: "r2",
        status: "submitted",
        totalGrade: 11,
        submittedAt: iso(-12),
        exam: { ...exams[0], id: "past-db", startTime: iso(-12) },
      },
    ],
    exports: [],
    audit: [
      {
        id: "a1",
        action: "exam.approve",
        entityType: "exam",
        actor: { name: "O6U Administrator" },
        createdAt: iso(0, -1),
      },
      {
        id: "a2",
        action: "question.create",
        entityType: "question",
        actor: { name: "Dr. Ahmed Hassan" },
        createdAt: iso(-1),
      },
    ],
    "seb-keys": [
      {
        id: "k1",
        label: "Computer lab A",
        isActive: true,
        createdAt: iso(-20),
      },
    ],
    doctors: [
      {
        id: "assign1",
        doctorId: "preview-doctor",
        subjectId: "s1",
        termId: "t1",
        doctor: { name: "Dr. Ahmed Hassan" },
        subject: subjects[0],
        term: { name: "Fall 2026" },
      },
    ],
    enrollments: [
      {
        id: "en1",
        studentId: "preview-student",
        subjectId: "s1",
        termId: "t1",
        student: { name: "Alex Morgan" },
        subject: subjects[0],
        term: { name: "Fall 2026" },
      },
    ],
    imports: [],
    sittings: [],
    members: [
      { id: "preview-student", name: "Alex Morgan", username: "alex.morgan" },
      { id: "u2", name: "Sara Mahmoud", username: "sara.mahmoud" },
    ],
  };
}
let db: Db;
try {
  db = JSON.parse(localStorage.getItem(key) ?? "null") ?? initial();
} catch {
  db = initial();
}
const save = () => {
  try {
    localStorage.setItem(key, JSON.stringify(db));
  } catch {
    /* Local demo preferences only */
  }
};
const envelope = (rows: Entity[], params: URLSearchParams) => {
  const page = Number(params.get("page") ?? 1),
    limit = Number(params.get("limit") ?? 20);
  return {
    rows: rows.slice((page - 1) * limit, page * limit),
    page,
    limit,
    total: rows.length,
  };
};
export async function demoRequest<T>(
  path: string,
  method: string,
  body?: unknown,
): Promise<T> {
  await new Promise((r) => setTimeout(r, 180));
  const url = new URL(path, "https://demo.local");
  const parts = url.pathname.replace("/api/v1/", "").split("/").filter(Boolean);
  const b = (body ?? {}) as Record<string, unknown>;
  let resource = parts[0] === "admin" ? parts[1] : parts[0];
  let id: string | undefined = parts[0] === "admin" ? parts[2] : parts[1];
  let action = parts[0] === "admin" ? parts[3] : parts[2];
  if (resource === "assignments") {
    resource = id;
    id = action;
    action = parts[4];
  }
  const result = (v: unknown) => structuredClone(v) as T;
  if (resource === "support" && id === "requests" && method === "POST") {
    const row = {
      id: crypto.randomUUID(),
      ...b,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    (db.support ??= []).unshift(row as Entity);
    save();
    return result({ reference: row.id.slice(0, 8).toUpperCase() });
  }
  if (parts[0] === "admin" && resource === "support") {
    const rows = db.support ?? [];
    if (method === "GET") {
      const filtered = rows.filter(
        (r) =>
          !url.searchParams.get("status") ||
          r.status === url.searchParams.get("status"),
      );
      const p = Number(url.searchParams.get("page") ?? 1);
      return result({
        rows: filtered.slice((p - 1) * 20, p * 20),
        total: filtered.length,
        page: p,
        limit: 20,
      });
    }
    const row = rows.find((r) => r.id === id);
    if (!row) throw new ApiError(404, "not found");
    Object.assign(row, b);
    save();
    return result(row);
  }
  if (resource === "notifications") {
    const role =
      sessionStorage.getItem("exam-platform-preview-role") ?? "student";
    if (method === "POST") {
      for (const k of b.keys as string[])
        (db.notificationReads ??= []).push({ id: role + ":" + k });
      save();
      return result({ ok: true });
    }
    const reads = new Set((db.notificationReads ?? []).map((r) => r.id));
    let notices: Record<string, unknown>[] = [];
    const subject = (e: Entity) =>
      String(db.subjects.find((x) => x.id === e.subjectId)?.name ?? "Exam");
    if (role === "student") {
      notices = db.exams
        .filter(
          (e) =>
            e.status === "approved" &&
            new Date(String(e.endTime)).getTime() > Date.now() &&
            !db.results.some((r) => (r.exam as Exam).id === e.id),
        )
        .map((e) => ({
          key: `exam:${e.id}:${e.startTime}`,
          kind: "upcoming",
          title:
            new Date(String(e.startTime)).getTime() > Date.now()
              ? "Upcoming exam"
              : "Exam available",
          detail: subject(e),
          href: "/exams",
          createdAt: e.startTime,
        }));
      notices.push(
        ...db.results.map((r) => ({
          key: "result:" + r.id,
          kind: "result",
          title: "Result available",
          detail: (r.exam as Exam).subject?.name ?? subject(r.exam as Exam),
          href: "/results",
          createdAt: r.submittedAt,
        })),
      );
    } else {
      notices = db.exams
        .filter((e) =>
          role === "admin"
            ? e.status === "pending_approval"
            : ["approved", "rejected"].includes(String(e.status)),
        )
        .map((e) => ({
          key: `decision:${e.id}:${e.status}`,
          kind: e.status,
          title:
            e.status === "pending_approval"
              ? "Approval needed"
              : e.status === "approved"
                ? "Assessment approved"
                : "Assessment rejected",
          detail: subject(e),
          href: "/exams/" + e.id,
          createdAt: e.startTime,
        }));
      const count = (db.support ?? []).filter(
        (r) => r.status === "pending",
      ).length;
      if (role === "admin" && count)
        notices.push({
          key: `support:${(db.support ?? []).find((r) => r.status === "pending")?.id}`,
          kind: "support",
          title: "Account requests need review",
          detail: String(count),
          href: "/support",
          createdAt: new Date().toISOString(),
        });
    }
    return result(
      notices.map((n) => ({ ...n, read: reads.has(role + ":" + n.key) })),
    );
  }
  if (resource === "student" && id === "me")
    return result({
      ...db.users[0],
      term: db.terms[0],
      canChangePassword: true,
    });
  if (resource === "student" && id === "results") return result(db.results);
  if (resource === "student" && id === "change-password") {
    await changeDemoPassword(
      String(b.currentPassword ?? ""),
      String(b.newPassword ?? ""),
    );
    return result({ ok: true });
  }
  if (resource === "student" && id === "exams") {
    const examId = action;
    const operation = parts[3];
    if (!examId)
      return result(
        db.exams.filter(
          (e) =>
            e.status === "approved" &&
            new Date(String(e.startTime)).getTime() <= Date.now() &&
            new Date(String(e.endTime)).getTime() > Date.now() &&
            !db.results.some((r) => (r.exam as Exam).id === e.id),
        ),
      );
    let sitting = db.sittings.find(
      (s) => s.examId === examId,
    ) as unknown as Sitting;
    if (operation === "readiness") {
      const exam = db.exams.find((e) => e.id === examId);
      if (!exam) throw new ApiError(404, "exam not found");
      return result({
        subject: db.subjects.find((s) => s.id === exam.subjectId),
        durationMinutes: exam.durationMinutes,
        maxReentries: Number(exam.maxReentries ?? 3),
        sebVerified: true,
        startTime: exam.startTime,
        endTime: exam.endTime,
        requiresCode: !!exam.hasAccessCode,
        resumable: !!sitting && sitting.status === "in_progress",
        submitted: db.results.some((r) => (r.exam as Exam).id === examId),
        ready:
          !db.results.some((r) => (r.exam as Exam).id === examId) &&
          (!!sitting ||
            (exam.status === "approved" &&
              new Date(String(exam.startTime)).getTime() <= Date.now() &&
              new Date(String(exam.endTime)).getTime() > Date.now())),
        serverTime: new Date().toISOString(),
      });
    }
    if (operation === "start") {
      const exam = db.exams.find((e) => e.id === examId);
      if (!exam) throw new ApiError(404, "exam not found");
      // Mirror the server's rotating-token admission (see student.ts).
      const stored = ((sitting as unknown as Entity)?.entryTokens ?? []) as string[];
      const presented = b.entryToken != null ? String(b.entryToken) : null;
      const current = stored.length ? stored[stored.length - 1] : null;
      const previous = stored.length >= 2 ? stored[stored.length - 2] : null;
      let issued: string;
      if (presented && presented === current) {
        issued = current;
      } else if (presented && presented === previous) {
        issued = crypto.randomUUID();
        stored.push(issued);
      } else if (presented && stored.includes(presented)) {
        throw new ApiError(403, "Re-entry token already used. Reopen the exam for a fresh entry.");
      } else if (stored.length >= Number(exam.maxReentries ?? 3) + 1) {
        throw new ApiError(403, "Exam re-entry limit reached. Contact your doctor.");
      } else {
        issued = crypto.randomUUID();
        stored.push(issued);
      }
      if (!sitting) {
        sitting = {
          id: "sit-" + examId,
          entryToken: issued,
          notesEnabled: Boolean(exam.notesEnabled),
          notesForDoctorEnabled: Boolean(exam.notesForDoctorEnabled),
          examToolsEnabled: exam.examToolsEnabled !== false,
          notesForDoctor: "",
          examId,
          status: "in_progress",
          remainingSeconds: 2700,
          questions: (db.questions as Question[]).map((q) => {
            const { correctAnswer: _, ...safe } = q;
            return {
              ...safe,
              questionId: q.id,
              selectedAnswer: null,
              isFlagged: false,
            };
          }),
        };
        db.sittings.push({
          ...sitting,
          id: sitting.id,
          deadline: Date.now() + 2700000,
        });
        sitting = db.sittings[db.sittings.length - 1] as unknown as Sitting;
        save();
      }
      (sitting as unknown as Entity).entryTokens = stored;
      save();
      if (sitting.status !== "in_progress")
        throw new ApiError(409, "Exam already submitted");
      return result({
        ...sitting,
        entryToken: issued,
        remainingSeconds: Math.max(
          0,
          Math.floor(
            (Number((sitting as unknown as Entity).deadline) - Date.now()) /
              1000,
          ),
        ),
      });
    }
    if (!sitting) throw new ApiError(404, "Start the exam first");
    if (operation === "notes") {
      if (!sitting.notesEnabled || sitting.status !== "in_progress" || Number((sitting as unknown as Entity).deadline) <= Date.now()) throw new ApiError(403, "Notes are unavailable for this attempt.");
      sitting.notes = String(b.notes ?? "").slice(0, 20000); save(); return result({ ok: true });
    }
    if (operation === "notes-for-doctor") {
      if (!sitting.notesForDoctorEnabled || sitting.status !== "in_progress" || Number((sitting as unknown as Entity).deadline) <= Date.now()) throw new ApiError(403, "Doctor notes are unavailable for this attempt.");
      sitting.notesForDoctor = String(b.notes ?? "").slice(0, 20000); save(); return result({ ok: true });
    }
    if (operation === "heartbeat")
      return result({
        remainingSeconds: Math.max(
          0,
          Math.floor(
            (Number((sitting as unknown as Entity).deadline) - Date.now()) /
              1000,
          ),
        ),
      });
    if (operation === "answer" || operation === "flag") {
      const q = sitting.questions.find((q) => q.questionId === b.questionId);
      if (q) {
        if (operation === "answer")
          q.selectedAnswer = b.selectedAnswer as string;
        else q.isFlagged = Boolean(b.isFlagged);
      }
      save();
      return result({ ok: true });
    }
    if (operation === "submit") {
      if (sitting.questions.some((q) => !q.selectedAnswer))
        throw new ApiError(409, "Answer every question before submitting.");
      sitting.status = "submitted";
      const grade = sitting.questions.reduce(
        (n, q) =>
          n +
          (db.questions.find((o) => o.id === q.questionId)?.correctAnswer ===
          q.selectedAnswer
            ? Number(q.grade)
            : 0),
        0,
      );
      const totalMarks = sitting.questions.reduce(
        (s: number, q: Question) => s + Number(q.grade ?? 0),
        0,
      );
      db.results.unshift({
        id: crypto.randomUUID(),
        exam: db.exams.find((e) => e.id === examId),
        status: "submitted",
        totalGrade: grade,
        totalMarks,
        submittedAt: iso(),
      });
      save();
      return result({
        ok: true,
        status: "submitted",
        totalGrade: grade,
        totalMarks,
      });
    }
  }
  if (resource === "exams" && id === "subjects")
    return result(envelope(db.subjects, url.searchParams));
  if (resource === "exams" && id === "sections")
    return result(
      envelope(
        db.sections.filter(
          (s) => s.subjectId === url.searchParams.get("subject_id"),
        ),
        url.searchParams,
      ),
    );
  if (resource === "exams" && id === "mine") id = undefined;
  if (resource === "question-bank") {
    resource = "questions";
    if (id === "counts") {
      return result(
        Object.fromEntries(
          ["easy", "medium", "hard"].map((d) => [
            d,
            db.questions.filter((q) => q.difficulty === d).length,
          ]),
        ),
      );
    }
  }
  if (resource === "permissions") {
    const userId = action ?? "defaults";
    db.permissions ??= [];
    if (method === "PATCH") {
      const existing = db.permissions.find(
        (p) => p.userId === userId && p.key === b.key,
      );
      if (existing) Object.assign(existing, b, { overridden: true });
      else
        db.permissions.push({
          id: crypto.randomUUID(),
          userId,
          ...b,
          overridden: true,
        });
      save();
    }
    if (method === "DELETE") {
      db.permissions = db.permissions.filter(
        (p) => !(p.userId === userId && p.key === parts[4]),
      );
      save();
    }
    return result(
      id === "defaults"
        ? []
        : {
            effective: [
              "manage_question_bank",
              "create_exam",
              "create_quiz",
              "take_exam",
              "view_all_grades",
              "export_grades",
            ].map((key) => ({
              key,
              allowed: true,
              overridden: false,
              ...db.permissions.find(
                (p) => p.userId === userId && p.key === key,
              ),
            })),
          },
    );
  }
  if (resource === "audit" && id === "stats") return result({});
  if (resource === "exams" && action === "blueprint")
    return result({
      exam: db.exams.find((e) => e.id === id),
      questions: db.questions,
      mode: "sample",
      sittings: { in_progress: 2, submitted: 24 },
    });
  if (resource === "exams" && action === "results")
    return result({
      groups: [
        {
          sectionName: "Section A",
          total: 2,
          rows: db.members.map((u, i) => ({
            ...u,
            exam: {
              status: "submitted",
              totalGrade: i ? 9 : 11,
              submittedAt: iso(-1),
            },
          })),
        },
      ],
    });
  if (resource === "exams" && action === "live")
    return result({
      total: 1,
      rows: [
        {
          id: "live1",
          student: db.users[0],
          sections: ["Section A"],
          answered: 3,
          totalQuestions: 6,
          remainingSeconds: 1200,
          stale: false,
        },
      ],
    });
  if (action === "members" && method === "GET")
    return result(envelope(db.members, url.searchParams));
  if (resource === "users" && action === "sessions" && method === "GET")
    return result([]);
  if (action === "compensations" && method === "GET") return result([]);
  if (
    action === "access-code" ||
    action === "approve" ||
    action === "reject" ||
    action === "make-current" ||
    action === "events" ||
    action === "compensate" ||
    action === "reset-password" ||
    action === "sessions" ||
    action === "members" ||
    action === "retry" ||
    action === "rotate"
  ) {
    const row = db[resource]?.find((e) => e.id === id);
    if (row) {
      if (action === "reset-password" && row.username === "alex.morgan")
        await setDemoPassword(String(b.password ?? ""));
      if (action === "approve") row.status = "approved";
      if (action === "reject") {
        row.status = "rejected";
        row.rejectionReason = b.reason;
      }
      if (action === "access-code") row.hasAccessCode = method !== "DELETE";
      if (action === "make-current") {
        db.terms.forEach((t) => (t.isCurrent = t.id === id));
      }
      if (action === "retry") row.status = "completed";
      if (action === "members") {
        const add = Array.isArray(b.add) ? b.add : [],
          remove = Array.isArray(b.remove) ? b.remove : [];
        db.members = db.members.filter((m) => !remove.includes(m.id));
        for (const userId of add) {
          const u = db.users.find((u) => u.id === userId);
          if (u && !db.members.some((m) => m.id === u.id)) db.members.push(u);
        }
      }
      if (action === "rotate") row.label = b.label;
    }
    save();
    return result({ ok: true });
  }
  const list = db[resource] ?? [];
  if (method === "GET") {
    if (id) {
      const found = list.find((e) => e.id === id);
      if (!found) throw new ApiError(404, "Not found");
      return result(found);
    }
    let filtered = list;
    const search = url.searchParams.get("search")?.toLowerCase();
    if (search)
      filtered = filtered.filter((e) =>
        JSON.stringify(e).toLowerCase().includes(search),
      );
    for (const [param, field] of [
      ["status", "status"],
      ["role", "role"],
      ["subject_id", "subjectId"],
      ["difficulty", "difficulty"],
      ["department_id", "departmentId"],
    ]) {
      const v = url.searchParams.get(param);
      if (v) filtered = filtered.filter((e) => e[field] === v);
    }
    const active = url.searchParams.get("active");
    if (resource === "users" && active)
      filtered = filtered.filter(
        (e) => Boolean(e.isActive) === (active === "true"),
      );
    return result(
      resource === "terms" || resource === "seb-keys"
        ? filtered
        : envelope(filtered, url.searchParams),
    );
  }
  if (method === "POST") {
    const { password: _password, rawKey: _rawKey, ...safe } = b;
    const row = {
      ...safe,
      id: crypto.randomUUID(),
      createdAt: iso(),
    } as Entity;
    if (resource === "exams") {
      row.status = "pending_approval";
      row.subject = db.subjects.find((s) => s.id === b.subjectId);
    }
    if (resource === "exports") {
      row.status = "completed";
      row.format = b.format ?? "csv";
    }
    list.unshift(row);
    db[resource] = list;
    save();
    return result(row);
  }
  if (method === "PATCH") {
    const row = list.find((e) => e.id === id);
    if (row) Object.assign(row, b);
    save();
    return result(row);
  }
  if (method === "DELETE") {
    if ((!id && resource === "doctors") || (!id && resource === "enrollments"))
      db[resource] = list.filter(
        (e) => !Object.entries(b).every(([k, v]) => e[k] === v),
      );
    else db[resource] = list.filter((e) => e.id !== id);
    save();
    return result({ ok: true });
  }
  return result({ ok: true });
}
export function resetPreview() {
  resetDemoPassword();
  localStorage.removeItem(key);
  db = initial();
}
