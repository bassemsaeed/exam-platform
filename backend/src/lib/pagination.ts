import { z } from "zod";
import { config } from "./config.js";

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(config.pagination.maxLimit).default(config.pagination.defaultLimit),
});

export function page(q: { page: number; limit: number }) {
  return { skip: (q.page - 1) * q.limit, take: q.limit };
}

export function envelope<T>(total: number, q: { page: number; limit: number }, rows: T[]) {
  return { total, page: q.page, limit: q.limit, rows };
}
