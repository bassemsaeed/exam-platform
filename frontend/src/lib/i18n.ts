import { useCallback } from "react";
import { arabic } from "./ar";
import { useUIStore, type Language } from "./workspace-state";
type Params = Record<string, string | number | null | undefined>;
const normalized = new Map(
  Object.entries(arabic).map(([key, value]) => [key.toLowerCase(), value]),
);
export function translate(
  text: string,
  language: Language = useUIStore.getState().language,
  params: Params = {},
): string {
  const key = text.trim().replace(/\s+/g, " ");
  const translated =
    language === "ar"
      ? (arabic[key] ?? normalized.get(key.toLowerCase()) ?? key)
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
