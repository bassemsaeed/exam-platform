import { hashPassword } from "better-auth/crypto";
import { createHash } from "node:crypto";
import { config } from "./lib/config.js";
import { prisma } from "./lib/prisma.js";
import { sealSecret } from "./lib/sebCrypto.js";
import { assertSeedAllowed } from "./lib/seedGuard.js";

// Persistent demo/test data for frontend development.
// Rerunnable: every entity is skipped when its natural key already exists.
// Login password for EVERY seeded user: Password123
// Users come from the same code path as Excel import (Prisma + better-auth
// crypto hash), since public sign-up is disabled by design.
const PASSWORD = "Password123";
const SEB_DEV_RAW = "dev-frontend-lab-key-please-rotate";

async function upsertUser(username: string, name: string, role: "admin" | "doctor" | "ta" | "student") {
  const email = `${username}@${config.email.placeholderDomain}`;
  const hashed = await hashPassword(PASSWORD);
  // Atomic user+account creation; on rerun heal a missing credential row
  // (e.g. partial first run left the user without an account).
  return prisma.$transaction(async (tx) => {
    // Stable key is the id (u_<name>): Excel imports may rename usernames
    // (stu2 -> real name) while keeping the id, so lookup by id first.
    // If the id is taken, heal the credential and leave the row alone —
    // never recreate a username that collides with imported data.
    let user = await tx.user.findUnique({ where: { id: `u_${username}` } });
    if (!user) {
      user = await tx.user.findUnique({ where: { username } });
    }
    if (!user) {
      user = await tx.user.create({
        data: {
          id: `u_${username}`,
          name,
          email,
          emailVerified: false,
          username,
          role: role as never,
          canChangePassword: role !== "student",
          isActive: true,
        },
      });
    }
    const account = await tx.account.findFirst({ where: { userId: user.id, providerId: "credential" } });
    if (!account) {
      await tx.account.create({
        data: { id: `acc-${user.id}`, providerId: "credential", accountId: user.id, userId: user.id, password: hashed },
      });
    }
    return user;
  });
}

async function main() {
  // Fixed public credentials + a published SEB dev key: dev-only by design.
  assertSeedAllowed("test-data");
  const term = await prisma.term.findFirst({ where: { isCurrent: true } });
  if (!term) throw new Error("no current term — run pnpm seed first");

  const dept =
    (await prisma.department.findUnique({ where: { code: "CS" } })) ??
    (await prisma.department.create({ data: { code: "CS", name: "Computer Science" } }));
  const subject =
    (await prisma.subject.findUnique({ where: { code: "CS301" } })) ??
    (await prisma.subject.create({ data: { code: "CS301", name: "Databases", departmentId: dept.id } }));

  const admins = [];
  for (const i of [1, 2, 3]) admins.push(await upsertUser(`admin${i}`, `Admin ${i}`, "admin"));
  const docs = [];
  for (const i of [1, 2, 3, 4]) {
    const d = await upsertUser(`doc${i}`, `Doctor ${i}`, "doctor");
    docs.push(d);
    await prisma.doctorAssignment.upsert({
      where: { doctorId_subjectId_termId: { doctorId: d.id, subjectId: subject.id, termId: term.id } },
      update: {},
      create: { doctorId: d.id, subjectId: subject.id, termId: term.id },
    });
  }
  const tas = [];
  for (const i of [1, 2, 3, 4]) tas.push(await upsertUser(`ta${i}`, `TA ${i}`, "ta"));
  const stus = [];
  for (const i of [1, 2, 3, 4, 5, 6, 7, 8]) stus.push(await upsertUser(`stu${i}`, `Student ${i}`, "student"));

  const secNames = ["A", "B", "C", "D"];
  const sections = [];
  for (let s = 0; s < 4; s++) {
    const sec =
      (await prisma.section.findUnique({
        where: { subjectId_termId_name: { subjectId: subject.id, termId: term.id, name: `Section ${secNames[s]}` } },
      })) ??
      (await prisma.section.create({
        data: { subjectId: subject.id, termId: term.id, taId: tas[s].id, name: `Section ${secNames[s]}` },
      }));
    sections.push(sec);
    for (const stu of [stus[s * 2], stus[s * 2 + 1]]) {
      await prisma.sectionMembership.upsert({
        where: { studentId_sectionId: { studentId: stu.id, sectionId: sec.id } },
        update: {},
        create: { studentId: stu.id, sectionId: sec.id },
      });
      await prisma.enrollment.upsert({
        where: { studentId_subjectId_termId: { studentId: stu.id, subjectId: subject.id, termId: term.id } },
        update: {},
        create: { studentId: stu.id, subjectId: subject.id, termId: term.id },
      });
    }
  }

  // Banks: doc1 private (4/4/4), ta1 shared (2/2/2).
  const docBank = await prisma.question.count({ where: { subjectId: subject.id, ownerType: "doctor", doctorId: docs[0].id } });
  if (docBank < 12) {
    const diffs = ["easy", "easy", "easy", "easy", "medium", "medium", "medium", "medium", "hard", "hard", "hard", "hard"] as const;
    const have = await prisma.question.findMany({ where: { subjectId: subject.id, ownerType: "doctor", doctorId: docs[0].id }, select: { text: true } });
    const texts = new Set(have.map((q) => q.text));
    for (let i = 0; i < diffs.length; i++) {
      const text = `Seed DB question ${i + 1} (${diffs[i]})`;
      if (texts.has(text)) continue;
      await prisma.question.create({
        data: {
          subjectId: subject.id,
          ownerType: "doctor",
          doctorId: docs[0].id,
          questionType: "mcq",
          text,
          options: ["A", "B", "C"],
          correctAnswer: "A",
          grade: 2.5,
          difficulty: diffs[i],
        },
      });
    }
  }
  const taBank = await prisma.question.count({ where: { subjectId: subject.id, ownerType: "ta_shared", addedByTaId: tas[0].id } });
  if (taBank < 6) {
    for (const [i, d] of (["easy", "easy", "medium", "medium", "hard", "hard"] as const).entries()) {
      const text = `Seed shared quiz question ${i + 1} (${d})`;
      if (await prisma.question.findFirst({ where: { subjectId: subject.id, text } })) continue;
      await prisma.question.create({
        data: {
          subjectId: subject.id,
          ownerType: "ta_shared",
          addedByTaId: tas[0].id,
          questionType: "mcq",
          text,
          options: ["A", "B", "C"],
          correctAnswer: "A",
          grade: 2.5,
          difficulty: d,
        },
      });
    }
  }

  const now = Date.now();
  const termId = term.id;
  async function ensureExam(match: { createdBy: string; type: "doctor_exam" | "ta_quiz" }, data: Parameters<typeof prisma.exam.create>[0]["data"]) {
    // Term-scoped match: after a term rollover the old term's exams must not
    // satisfy the new term (otherwise the new term silently stays empty).
    const found = await prisma.exam.findFirst({ where: { subjectId: subject.id, termId, createdBy: match.createdBy, type: match.type }, orderBy: { startTime: "desc" } });
    if (found) return found;
    return prisma.exam.create({ data });
  }

  // E1: live doctor exam (subject-wide, window open now).
  const e1 = await ensureExam(
    { createdBy: docs[0].id, type: "doctor_exam" },
    {
      subjectId: subject.id,
      termId: term.id,
      type: "doctor_exam",
      createdBy: docs[0].id,
      status: "approved",
      approvedBy: admins[0].id,
      startTime: new Date(now - 3_600_000),
      endTime: new Date(now + 6 * 3_600_000),
      durationMinutes: 180,
      difficultyMix: { easy: 2, medium: 2 },
      questionSource: "own",
      targetScope: "subject",
    },
  );
  // E2: live TA quiz for Section A only.
  let e2 = await prisma.exam.findFirst({ where: { subjectId: subject.id, termId: term.id, createdBy: tas[0].id, type: "ta_quiz" } });
  if (!e2) {
    e2 = await prisma.exam.create({
      data: {
        subjectId: subject.id,
        termId: term.id,
        type: "ta_quiz",
        createdBy: tas[0].id,
        status: "approved",
        startTime: new Date(now - 1_800_000),
        endTime: new Date(now + 2 * 3_600_000),
        durationMinutes: 30,
        difficultyMix: { easy: 2 },
        questionSource: "shared",
        targetScope: "sections",
        targetSections: { create: [{ sectionId: sections[0].id }] },
      },
    });
  }
  // E3: pending approval (admin queue demo).
  await ensureExam(
    { createdBy: docs[1].id, type: "doctor_exam" },
    {
      subjectId: subject.id,
      termId: term.id,
      type: "doctor_exam",
      createdBy: docs[1].id,
      status: "pending_approval",
      startTime: new Date(now + 2 * 86_400_000),
      endTime: new Date(now + 3 * 86_400_000),
      durationMinutes: 60,
      difficultyMix: { easy: 1 },
      questionSource: "own",
      targetScope: "subject",
    },
  );
  // E4: past exam with two graded instances (results/export demo).
  let e4 = await prisma.exam.findFirst({
    where: { subjectId: subject.id, termId: term.id, createdBy: docs[0].id, type: "doctor_exam", status: "approved", startTime: { lt: new Date(now - 6 * 86_400_000) } },
  });
  if (!e4) {
    e4 = await prisma.exam.create({
      data: {
        subjectId: subject.id,
        termId: term.id,
        type: "doctor_exam",
        createdBy: docs[0].id,
        status: "approved",
        approvedBy: admins[0].id,
        startTime: new Date(now - 7 * 86_400_000),
        endTime: new Date(now - 7 * 86_400_000 + 3 * 3_600_000),
        durationMinutes: 120,
        difficultyMix: { easy: 1, medium: 1 },
        questionSource: "own",
        targetScope: "subject",
      },
    });
    const bank = await prisma.question.findMany({
      where: { subjectId: subject.id, ownerType: "doctor", doctorId: docs[0].id, difficulty: { in: ["easy", "medium"] } },
      orderBy: { createdAt: "asc" },
      take: 2,
    });
    const past = new Date(now - 7 * 86_400_000 + 3_600_000);
    for (const [idx, stu] of [stus[0], stus[1]].entries()) {
      const se = await prisma.studentExam.create({
        data: {
          examId: e4.id,
          studentId: stu.id,
          status: "submitted",
          startedAt: past,
          submittedAt: new Date(past.getTime() + 30 * 60_000),
          totalGrade: idx === 0 ? 5 : 2.5,
        },
      });
      for (const [qi, q] of bank.entries()) {
        const correct = idx === 0 || qi === 0;
        await prisma.studentExamQuestion.create({
          data: {
            studentExamId: se.id,
            questionId: q.id,
            selectedAnswer: correct ? "A" : "B",
            gradeAwarded: correct ? 2.5 : 0,
          },
        });
      }
    }
  }

  // Dev SEB lab key (frontend runner testing needs the raw to mint headers).
  const keyHash = createHash("sha256").update(SEB_DEV_RAW).digest("hex");
  await prisma.sebKey.upsert({
    where: { keyHash },
    update: { isActive: true, encryptedKey: sealSecret(SEB_DEV_RAW) },
    create: { label: "dev-frontend-lab", keyHash, encryptedKey: sealSecret(SEB_DEV_RAW), isActive: true },
  });

  console.log("seed:test ok — logins (password Password123):");
  console.log("  admins: admin1..3 | doctors: doc1..4 | tas: ta1..4 | students: stu1..8");
  console.log(`  subject CS301, sections A..D (ta1..4, 2 students each), exams: live E1(${e1.id}) E2(${e2.id}), pending E3, past E4(${e4.id})`);
  console.log(`  SEB dev raw: ${SEB_DEV_RAW} (header = sha256(url + raw) hex)`);
}

await main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
