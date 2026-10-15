import { useEffect } from "react";
import { Languages, Moon, Sun, Monitor } from "lucide-react";
import { useUIStore, type Language, type Theme } from "../lib/workspace-state";
import { useT } from "../lib/i18n";
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
function applyPreferences() {
  const { language, theme } = useUIStore.getState();
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.documentElement.dataset.theme =
    theme === "system" ? (systemTheme.matches ? "dark" : "light") : theme;
  document.title =
    language === "ar"
      ? "بوابة امتحانات جامعة ٦ أكتوبر"
      : "O6U Examination Portal";
}
// Apply saved settings before React paints; no flash or route remount on switching.
applyPreferences();
useUIStore.subscribe(applyPreferences);
export function Preferences({ themeOnly = false }: { themeOnly?: boolean }) {
  const t = useT();
  const theme = useUIStore((s) => s.theme);
  const language = useUIStore((s) => s.language);
  const setTheme = useUIStore((s) => s.setTheme);
  const setLanguage = useUIStore((s) => s.setLanguage);
  useEffect(() => {
    systemTheme.addEventListener("change", applyPreferences);
    return () => systemTheme.removeEventListener("change", applyPreferences);
  }, []);
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  if (themeOnly) {
    const dark = theme === "dark" || (theme === "system" && systemTheme.matches);
    return (
      <button
        type="button"
        className="icon-button"
        aria-label={t("Theme")}
        aria-pressed={dark}
        title={t(dark ? "Light" : "Dark")}
        onClick={() => setTheme(dark ? "light" : "dark")}
      >
        {dark ? <Sun size={18} /> : <Moon size={18} />}
      </button>
    );
  }
  return (
    <div className="display-preferences">
      <label className="preference-control">
        <ThemeIcon size={16} aria-hidden="true" />
        <select
          aria-label={t("Theme")}
          value={theme}
          onChange={(e) => setTheme(e.target.value as Theme)}
        >
          <option value="system">{t("System")}</option>
          <option value="light">{t("Light")}</option>
          <option value="dark">{t("Dark")}</option>
        </select>
      </label>
      {!themeOnly && <label className="preference-control">
        <Languages size={16} aria-hidden="true" />
        <select
          aria-label={t("Language")}
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
        >
          <option value="en" lang="en">
            English
          </option>
          <option value="ar" lang="ar">
            العربية
          </option>
        </select>
      </label>}
    </div>
  );
}
