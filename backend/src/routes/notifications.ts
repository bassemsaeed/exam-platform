import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { rateLimit } from "../middleware/rateLimit.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
export const notifications: RouterType = Router();
notifications.use(requireAuth);
interface Notice {
  key: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
  createdAt: Date;
  read?: boolean;
}
notifications.get("/", async (req, res) => {
  const { userId, role } = req as unknown as AuthedRequest;
  const notices: Notice[] = [];
  const now = new Date();
  if (role === "student") {
    const term = await prisma.term.findFirst({
      where: { isCurrent: true },
      select: { id: true },
    });
    if (term) {
      const [enrollments, memberships] = await Promise.all([
        prisma.enrollment.findMany({
          where: { studentId: userId, termId: term.id },
          select: { subjectId: true },
        }),
        prisma.sectionMembership.findMany({
          where: { studentId: userId, section: { termId: term.id } },
          select: { sectionId: true },
        }),
      ]);
      // Schedule metadata only: no question content, entry-code hashes or SEB keys.
      const upcoming = await prisma.exam.findMany({
        where: {
          termId: term.id,
          status: "approved",
          endTime: { gte: now },
          subjectId: { in: enrollments.map((e) => e.subjectId) },
          OR: [
            { targetScope: "subject" },
            {
              targetSections: {
                some: {
                  sectionId: { in: memberships.map((m) => m.sectionId) },
                },
              },
            },
            { targetStudents: { some: { studentId: userId } } },
          ],
          instances: {
            none: {
              studentId: userId,
              status: { in: ["submitted", "auto_submitted"] },
            },
          },
        },
        select: {
          id: true,
          startTime: true,
          subject: { select: { name: true } },
        },
        orderBy: { startTime: "asc" },
        take: 50,
      });
      for (const e of upcoming)
        notices.push({
          key: `exam:${e.id}:${e.startTime.toISOString()}`,
          kind: e.startTime > now ? "upcoming" : "available",
          title: e.startTime > now ? "Upcoming exam" : "Exam available",
          detail: e.subject.name,
          href: "/exams",
          createdAt: e.startTime,
        });
    }
    const results = await prisma.studentExam.findMany({
      where: {
        studentId: userId,
        status: { in: ["submitted", "auto_submitted"] },
      },
      select: {
        id: true,
        submittedAt: true,
        exam: { select: { subject: { select: { name: true } } } },
      },
      orderBy: { submittedAt: "desc" },
      take: 50,
    });
    for (const r of results)
      notices.push({
        key: `result:${r.id}`,
        kind: "result",
        title: "Result available",
        detail: r.exam.subject.name,
        href: "/results",
        createdAt: r.submittedAt ?? now,
      });
  } else {
    const exams = await prisma.exam.findMany({
      where:
        role === "admin"
          ? { status: "pending_approval" }
          : { createdBy: userId, status: { in: ["approved", "rejected"] } },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        subject: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    for (const e of exams)
      notices.push({
        key: `decision:${e.id}:${e.status}:${e.updatedAt.toISOString()}`,
        kind: e.status,
        title:
          e.status === "pending_approval"
            ? "Approval needed"
            : e.status === "approved"
              ? "Assessment approved"
              : "Assessment rejected",
        detail: e.subject.name,
        href: `/exams/${e.id}`,
        createdAt: e.updatedAt,
      });
    if (role === "admin") {
      const [count, latest] = await Promise.all([
        prisma.accountSupportRequest.count({ where: { status: "pending" } }),
        prisma.accountSupportRequest.findFirst({
          where: { status: "pending" },
          orderBy: { createdAt: "desc" },
          select: { id: true, createdAt: true },
        }),
      ]);
      if (count && latest)
        notices.push({
          key: `support:${latest.id}`,
          kind: "support",
          title: "Account requests need review",
          detail: String(count),
          href: "/support",
          createdAt: latest.createdAt,
        });
    }
  }
  const reads = await prisma.notificationRead.findMany({
    where: { userId, key: { in: notices.map((n) => n.key) } },
    select: { key: true },
  });
  const seen = new Set(reads.map((r) => r.key));
  res.json(
    notices
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((n) => ({ ...n, read: seen.has(n.key) })),
  );
});
notifications.post(
  "/read",
  rateLimit(60, 60_000, "notification-reads"),
  async (req, res) => {
    const { keys } = z
      .object({ keys: z.array(z.string().min(1).max(250)).max(100) })
      .parse(req.body);
    const { userId } = req as unknown as AuthedRequest;
    const total = await prisma.notificationRead.count({ where: { userId } });
    if (total > 5000 || total + keys.length > 5000) {
      return res.status(422).json({ error: "too many saved reads" });
    }
    await prisma.notificationRead.createMany({
      data: [...new Set(keys)].map((key) => ({ userId, key })),
      skipDuplicates: true,
    });
    res.json({ ok: true });
  },
);
