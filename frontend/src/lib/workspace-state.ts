import { create } from "zustand";
import { persist } from "zustand/middleware";
export type Language = "en" | "ar";
export type Theme = "light" | "dark" | "system";
// Presentation preferences only. Authentication and API records are untouched.
export const useUIStore = create<{
  compact: boolean;
  language: Language;
  theme: Theme;
  setCompact: (v: boolean) => void;
  setLanguage: (v: Language) => void;
  setTheme: (v: Theme) => void;
}>()(
  persist(
    (set) => ({
      compact: false,
      language: "en",
      theme: "system",
      setCompact: (compact) => set({ compact }),
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
    }),
    { name: "o6u-ui-preferences" },
  ),
);
