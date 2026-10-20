import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import zhCN from "./locales/zh-CN";
import zhTW from "./locales/zh-TW";

export type Language = "en" | "zh-CN" | "zh-TW";
export type LanguagePreference = Language | "auto";
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", "zh-CN": "简体中文", "zh-TW": "繁體中文" };

const STORAGE_KEY = "rove.language";
// English text is the key. A missing entry simply shows the English text.
const dictionaries: Record<Language, Record<string, string>> = { en: {}, "zh-CN": zhCN, "zh-TW": zhTW };

export function readPreference(): LanguagePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "en" || saved === "zh-CN" || saved === "zh-TW" ? saved : "auto";
  } catch {
    return "auto";
  }
}
export function resolveLanguage(preference: LanguagePreference, browser = typeof navigator === "undefined" ? "en" : navigator.language): Language {
  if (preference !== "auto") return preference;
  const lower = browser.toLowerCase();
  if (/^zh-(tw|hk|mo|hant)/.test(lower)) return "zh-TW";
  return lower.startsWith("zh") ? "zh-CN" : "en";
}

export function translate(language: Language, text: string, vars?: Record<string, string | number>): string {
  const template = dictionaries[language][text] ?? text;
  return vars ? template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : template;
}

type Value = { language: Language; preference: LanguagePreference; setPreference: (preference: LanguagePreference) => void };
const I18nContext = createContext<Value>({ language: "en", preference: "auto", setPreference: () => {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LanguagePreference>(readPreference);
  const language = resolveLanguage(preference);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const value = useMemo<Value>(
    () => ({
      language,
      preference,
      setPreference: (next) => {
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* The choice still applies for this session. */
        }
        setPreferenceState(next);
      },
    }),
    [language, preference],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `const t = useT(); t("Back to chat"); t("{count} actions", { count })` */
export function useT() {
  const { language } = useContext(I18nContext);
  return useMemo(() => (text: string, vars?: Record<string, string | number>) => translate(language, text, vars), [language]);
}
export function useLanguage() {
  return useContext(I18nContext);
}
