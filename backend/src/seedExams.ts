import { hashEntryCode } from "./lib/sebCrypto.js";
import { prisma } from "./lib/prisma.js";
import { assertSeedAllowed } from "./lib/seedGuard.js";

// Test-exam matrix (rerunnable: wipes every exam, then rebuilds).
// Run: pnpm seed:exams
// Covers: live exam (open) + live exam (coded) + live section quiz +
// pending queue + rejected + past graded (results/exports/compensate) +
// one live seat for the hall. Entry code for the coded exam: 123456.

async function main() {
  // Destructive by design (wipes and rebuilds the matrix): refuse production
  // without an explicit flag, and wipe the CURRENT TERM ONLY — other terms'
  // exams, sittings and export jobs are never touched.
  assertSeedAllowed("destructive");
  const term = await prisma.term.findFirst({ where: { isCurrent: true } });
  if (!term) throw new Error("no current term — run pnpm seed first");
  const subject = await prisma.subject.findUnique({ where: { code: "CS301" } });
  if (!subject) throw new Error("no CS301 — run pnpm seed:test first");

  const user = async (username: string) =>
    prisma.user.findUniqueOrThrow({ where: { username } });
  const [admin1, doc1, ta1, stu1, stu2, stu4] = await Promise.all(
    ["admin1", "doc1", "ta1", "stu1", "stu2", "stu4"].map(user),
  );
  const sectionA = await prisma.section.findFirstOrThrow({
    where: { subjectId: subject.id, termId: term.id, name: "Section A" },
  });

  // Wipe: exam cascades take instances/questions/targets/events/compensations.
  // Export jobs are exam artifacts — drop the current term's too (files stay
  // on disk). Term-scoped two ways (exam link + params term_id): other terms
  // are untouched.
  const allJobs = await prisma.exportJob.findMany({
    select: { id: true, params: true, exam: { select: { termId: true } } },
  });
  const termJobIds = allJobs
    .filter((j) => j.exam?.termId === term.id || ((j.params ?? {}) as { term_id?: string }).term_id === term.id)
    .map((j) => j.id);
  await prisma.exportJob.deleteMany({ where: { id: { in: termJobIds } } });
  const wiped = await prisma.exam.deleteMany({ where: { termId: term.id } });
  console.log(`wiped ${wiped.count} exams (+ cascaded sittings, events, compensations, jobs)`);

  const now = Date.now();
  const H = 3_600_000;

  const liveExam = await prisma.exam.create({
    data: {
      subjectId: subject.id, termId: term.id, type: "doctor_exam",
      createdBy: doc1.id, status: "approved", approvedBy: admin1.id,
      startTime: new Date(now - 30 * 60_000), endTime: new Date(now + 3 * H),
      durationMinutes: 120, difficultyMix: { easy: 2, medium: 2 },
      questionSource: "own", targetScope: "subject",
    },
  });

  const codedExam = await prisma.exam.create({
    data: {
      subjectId: subject.id, termId: term.id, type: "doctor_exam",
      createdBy: doc1.id, status: "approved", approvedBy: admin1.id,
      startTime: new Date(now - 30 * 60_000), endTime: new Date(now + 3 * H),
      durationMinutes: 60, difficultyMix: { easy: 1, medium: 1 },
      questionSource: "own", targetScope: "subject",
      accessCodeHash: hashEntryCode("123456"),
    },
  });

  const liveQuiz = await prisma.exam.create({
    data: {
      subjectId: subject.id, termId: term.id, type: "ta_quiz",
      createdBy: ta1.id, status: "approved",
      startTime: new Date(now - 30 * 60_000), endTime: new Date(now + 2 * H),
      durationMinutes: 30, difficultyMix: { easy: 2 },
      questionSource: "shared", targetScope: "sections",
      targetSections: { create: [{ sectionId: sectionA.id }] },
    },
  });

  const pending = await prisma.exam.create({
    data: {
      subjectId: subject.id, termId: term.id, type: "doctor_exam",
      createdBy: doc1.id, status: "pending_approval",
      startTime: new Date(now + 24 * H), endTime: new Date(now + 27 * H),
      durationMinutes: 90, difficultyMix: { easy: 2, medium: 1 },
      questionSource: "own", targetScope: "subject",
    },
  });

  const rejected = await prisma.exam.create({
    data: {
      subjectId: subject.id, termId: term.id, type: "doctor_exam",
      createdBy: doc1.id, status: "rejected", approvedBy: admin1.id,
      rejectionReason: "Blueprint exceeds bank coverage — trim hard questions to 1 and resubmit.",
      startTime: new Date(now + 24 * H), endTime: new Date(now + 27 * H),
      durationMinutes: 90, difficultyMix: { easy: 2, medium: 1 },
      questionSource: "own", targetScope: "subject",
    },
  });

  const past = await prisma.exam.create({
    data: {
      subjectId: subject.id, termId: term.id, type: "doctor_exam",
      createdBy: doc1.id, status: "approved", approvedBy: admin1.id,
      startTime: new Date(now - 26 * H), endTime: new Date(now - 23 * H),
      durationMinutes: 120, difficultyMix: { easy: 1, medium: 1 },
      questionSource: "own", targetScope: "subject",
    },
  });
  const bank = await prisma.question.findMany({
    where: { subjectId: subject.id, ownerType: "doctor", doctorId: doc1.id, difficulty: { in: ["easy", "medium"] } },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  const pastStart = new Date(now - 26 * H + H);
  for (const [idx, stu] of [stu1, stu2].entries()) {
    const se = await prisma.studentExam.create({
      data: {
        examId: past.id, studentId: stu.id, status: "submitted",
        startedAt: pastStart, submittedAt: new Date(pastStart.getTime() + 30 * 60_000),
        lastHeartbeatAt: new Date(pastStart.getTime() + 30 * 60_000),
        totalGrade: idx === 0 ? 5 : 2.5,
      },
    });
    for (const [qi, q] of bank.entries()) {
      const correct = idx === 0 || qi === 0;
      await prisma.studentExamQuestion.create({
        data: { studentExamId: se.id, questionId: q.id, selectedAnswer: correct ? "A" : "B", gradeAwarded: correct ? 2.5 : 0 },
      });
    }
  }

  // One live seat for the hall: stu4, 2/4 answered on the live exam.
  const seatBank = await prisma.question.findMany({
    where: { subjectId: subject.id, ownerType: "doctor", doctorId: doc1.id, difficulty: { in: ["easy", "medium"] } },
    orderBy: { createdAt: "asc" },
    take: 4,
  });
  const seat = await prisma.studentExam.create({
    data: {
      examId: liveExam.id, studentId: stu4.id, status: "in_progress",
      startedAt: new Date(now - 10 * 60_000), lastHeartbeatAt: new Date(),
    },
  });
  for (const [qi, q] of seatBank.entries()) {
    await prisma.studentExamQuestion.create({
      data: { studentExamId: seat.id, questionId: q.id, selectedAnswer: qi < 2 ? "A" : null },
    });
  }

  console.log("seed:exams ok — logins (password Password123):");
  console.log(`  live exam (open)      ${liveExam.id}`);
  console.log(`  live exam (code 123456) ${codedExam.id}`);
  console.log(`  live Section-A quiz   ${liveQuiz.id}   (stu1/stu2 only)`);
  console.log(`  pending approval      ${pending.id}`);
  console.log(`  rejected              ${rejected.id}`);
  console.log(`  past graded (results) ${past.id}   (stu1 5/5, stu2 2.5/5)`);
  console.log(`  live seat: stu4 2/4 on the live exam (hall demo)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
