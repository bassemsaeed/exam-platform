import { locale } from "./i18n";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type SessionUser } from "./api";
import { queryClient } from "./query";
import { sebHeaders } from "./seb";
export const previewMode = import.meta.env.VITE_PREVIEW_MODE === "true";
export interface Entity {
  id: string;
  name?: string;
  code?: string;
  username?: string;
  role?: string;
  isActive?: boolean;
  [key: string]: unknown;
}
export interface Subject extends Entity {
  name: string;
  code: string;
}
export interface Exam extends Entity {
  createdBy?: string;
  title?: string;
  purpose?: string;
  notesEnabled?: boolean;
  notesForDoctorEnabled?: boolean;
  examToolsEnabled?: boolean;
  maxReentries?: number;
  resultsReleased?: boolean;
  subjectId: string;
  subject?: Subject;
  type: string;
  status: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  requiresCode?: boolean;
  hasAccessCode?: boolean;
  difficultyMix?: Record<string, number>;
  rejectionReason?: string;
}
export interface Question extends Entity {
  subjectId: string;
  text: string;
  questionType: string;
  options: string[];
  correctAnswer?: string;
  grade: number;
  difficulty: string;
  imageUrl?: string;
}
export interface SittingQuestion extends Question {
  questionId: string;
  selectedAnswer: string | null;
  isFlagged: boolean;
}
export interface Sitting {
  entryToken?: string;
  entriesUsed?: number;
  resultsReleased?: boolean;
  notesEnabled?: boolean;
  notesForDoctorEnabled?: boolean;
  examToolsEnabled?: boolean;
  notes?: string;
  notesForDoctor?: string;
  maxReentries?: number;
  id: string;
  examId: string;
  remainingSeconds: number;
  status: string;
  questions: SittingQuestion[];
}
export interface StudentResult extends Entity {
  status: string;
  totalGrade: number;
  totalMarks?: number;
  submittedAt: string;
  exam: Exam;
}
export interface Envelope<T> {
  rows: T[];
  page: number;
  limit: number;
  total: number;
}
export const rowsOf = <T>(value: T[] | Envelope<T> | undefined): T[] =>
  Array.isArray(value) ? value : (value?.rows ?? []);
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  extra?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  if (previewMode) {
    const { demoRequest } = await import("./preview");
    return demoRequest<T>(path, method, body);
  }
  const headers = {
    ...(path.includes("/student/exams") ? await sebHeaders(path) : {}),
    ...extra,
  };
  if (method === "GET") return api.get<T>(path, headers, signal);
  if (method === "POST") return api.post<T>(path, body, headers, signal);
  if (method === "PATCH") return api.patch<T>(path, body, headers, signal);
  return api.delete<T>(path, body, headers, signal);
}
export function useResource<T>(
  user: SessionUser,
  path: string,
  enabled = true,
  poll?: number,
) {
  return useQuery<T>({
    queryKey: ["platform", user.id, path],
    queryFn: ({ signal }) =>
      request<T>(path, "GET", undefined, undefined, signal),
    enabled,
    placeholderData: (previous, previousQuery) =>
      String(previousQuery?.queryKey[2]).split("?")[0] === path.split("?")[0]
        ? previous
        : undefined,
    refetchInterval: poll,
    retry: (n, e) => n < 1 && !("status" in e && Number(e.status) < 500),
  });
}
export function invalidateResources(userId: string, roots: string[]) {
  return queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "platform" &&
      q.queryKey[1] === userId &&
      roots.some((root) => String(q.queryKey[2]).startsWith(root)),
  });
}
export function useAction<T = Entity>(user: SessionUser, roots: string[]) {
  return useMutation({
    mutationFn: ({
      path,
      method = "POST",
      body,
      headers,
      signal,
    }: {
      path: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }) => request<T>(path, method, body, headers, signal),
    onSuccess: () => invalidateResources(user.id, roots),
  });
}
export const label = (s: unknown) =>
  String(s ?? "—")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
export const date = (s: unknown) =>
  s
    ? new Intl.DateTimeFormat(locale(), {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(String(s)))
    : "—";
export const time = (s: unknown) =>
  s
    ? new Intl.DateTimeFormat(locale(), {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(String(s)))
    : "—";
export const nameOf = (exam: Exam, subjects: Subject[] = []) =>
  exam.title ||
  (exam.subject?.name ??
    subjects.find((s) => s.id === exam.subjectId)?.name ??
    "Exam");
