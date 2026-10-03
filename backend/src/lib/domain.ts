import type { Role } from "../generated/prisma/browser.js";

export type { Role };
export const ROLES: Role[] = ["admin", "doctor", "ta", "student"];

// Fixed, predefined permission list (spec §2.3) — NOT user-invented.
// Single source of truth: seed + override validation both read this.
export const PERMISSION_KEYS = [
  "edit_users",
  "approve_exam",
  "create_exam",
  "create_quiz",
  "view_all_grades",
  "view_own_grades",
  "manage_question_bank",
  "take_exam",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const ROLE_DEFAULTS: Record<Role, PermissionKey[]> = {
  admin: ["edit_users", "approve_exam", "create_exam", "view_all_grades", "manage_question_bank"],
  doctor: ["create_exam", "manage_question_bank", "view_all_grades"],
  ta: ["create_quiz", "manage_question_bank", "view_own_grades"],
  student: ["take_exam"],
};

export function isPermissionKey(k: string): k is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(k);
}

// Excel default per role (import path).
export function defaultCanChangePassword(role: Role): boolean {
  return role !== "student";
}

// Spec §2.2: students never self-change, even if the flag was left true
// (e.g. public-signup path). Staff need the flag on top.
export function mayChangePassword(role: Role, flag: boolean): boolean {
  return flag && role !== "student";
}

// Admin hierarchy: admins manage doctors/TAs/students (directory, assignments,
// departments, sections) but NEVER mutate another admin's account. Peer-admin
// edits (role, disable, password, permissions, sessions) are 403 — only the
// account itself (self name/email) may change, and self disable/demote stays
// 422. This prevents privilege escalation and lockout races between admins.
export function isPeerAdmin(actorId: string, target: { id: string; role: Role }): boolean {
  return target.role === "admin" && target.id !== actorId;
}

export const SUBJECT_CODE_RE = /^[a-zA-Z0-9_.-]+$/;

export function isValidRole(r: string): r is Role {
  return (ROLES as readonly string[]).includes(r);
}

export const STUDENT_EXAM_STATUSES = ["not_started", "in_progress", "submitted", "auto_submitted"] as const;
export type StudentExamStatusType = (typeof STUDENT_EXAM_STATUSES)[number];

export const EXAM_EVENT_TYPES = ["started", "voided", "warning", "submitted", "closed", "time_remaining", "announcement"] as const;
export type ExamEventType = (typeof EXAM_EVENT_TYPES)[number];

export function isExamEventType(t: string): t is ExamEventType {
  return (EXAM_EVENT_TYPES as readonly string[]).includes(t as never);
}

// Admin broadcast allowlist: server owns started/submitted; admins may send
// operational signals only (validated in adminExams POST /:id/events).
export const EXAM_BROADCAST_TYPES = ["warning", "time_remaining", "announcement", "closed", "voided"] as const;
export type ExamBroadcastType = (typeof EXAM_BROADCAST_TYPES)[number];
