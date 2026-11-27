import { useCallback } from "react";
import { arabic } from "./ar";
import { useUIStore, type Language } from "./workspace-state";

type Params = Record<string, string | number | null | undefined>;

function normalizeKey(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\.\.\./g, "…")
    .toLowerCase();
}

const normalized = new Map<string, string>();
for (const [key, value] of Object.entries(arabic)) {
  const nk = normalizeKey(key);
  if (!normalized.has(nk)) normalized.set(nk, value);
}

export function translate(
  text: string,
  language: Language = useUIStore.getState().language,
  params: Params = {},
): string {
  const key = text.trim().replace(/\s+/g, " ");
  const translated =
    language === "ar"
      ? (arabic[key] ?? normalized.get(normalizeKey(key)) ?? key)
      : key;
  const leading = /^\s/.test(text) ? " " : "";
  const trailing = /\s$/.test(text) ? " " : "";
  return (
    leading +
    translated.replace(/\{(\w+)\}/g, (match, name: string) =>
      String(params[name] ?? match),
    ) +
    trailing
  );
}

export function useT() {
  const language = useUIStore((s) => s.language);
  return useCallback(
    (text: string, params?: Params) => translate(text, language, params),
    [language],
  );
}

export const locale = () =>
  useUIStore.getState().language === "ar" ? "ar-EG" : undefined;
