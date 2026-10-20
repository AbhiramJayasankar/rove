import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolveLanguage, translate } from "../../src/i18n";
import zhCN from "../../src/locales/zh-CN";
import zhTW from "../../src/locales/zh-TW";

const srcDir = new URL("../../src/", import.meta.url);
const staticKeys = (): string[] => {
  const keys = new Set<string>();
  for (const file of readdirSync(srcDir).filter((name) => /\.tsx?$/.test(name) && !name.startsWith("i18n"))) {
    const source = readFileSync(new URL(file, srcDir), "utf8");
    for (const match of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(match[1].replace(/\\"/g, '"'));
  }
  return [...keys];
};
// Strings that reach t() through variables rather than literal calls.
const dynamicKeys = ["Working", "Waiting for you", "Completed", "Failed", "Stopped", "Allow", "Ask", "Block", "Off", "Low", "Medium", "High", "Max", "Thinking off", "Thinking on", "Web Speech", "Groq / compatible API", "Summarize this page", "Find something on this page", "Open a site and do something"];

describe("languages", () => {
  it("translates every UI string in both Chinese dictionaries", () => {
    const missing = (dictionary: Record<string, string>) => [...staticKeys(), ...dynamicKeys].filter((key) => !(key in dictionary));
    expect(missing(zhCN)).toEqual([]);
    expect(missing(zhTW)).toEqual([]);
  });
  it("keeps placeholders intact in every translation", () => {
    for (const dictionary of [zhCN, zhTW])
      for (const [english, translated] of Object.entries(dictionary))
        expect([...(translated.match(/\{\w+\}/g) ?? [])].sort(), english).toEqual([...(english.match(/\{\w+\}/g) ?? [])].sort());
  });
  it("picks a language from the preference or the browser", () => {
    expect(resolveLanguage("auto", "en-US")).toBe("en");
    expect(resolveLanguage("auto", "zh-CN")).toBe("zh-CN");
    expect(resolveLanguage("auto", "zh-TW")).toBe("zh-TW");
    expect(resolveLanguage("auto", "zh-Hant-HK")).toBe("zh-TW");
    expect(resolveLanguage("zh-TW", "en-US")).toBe("zh-TW");
  });
  it("fills placeholders and falls back to English for unknown text", () => {
    expect(translate("zh-CN", "{n} actions", { n: 3 })).toBe("3 个操作");
    expect(translate("zh-CN", "Some text nobody translated")).toBe("Some text nobody translated");
    expect(translate("en", "Open {host}", { host: "example.com" })).toBe("Open example.com");
  });
});
