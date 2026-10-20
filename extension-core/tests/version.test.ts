import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeSettings } from "../../extension-src/validation";
import { DEFAULT_PROMPT } from "../../shared/defaults";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("versioning and rename", () => {
  it("keeps package, manifest and changelog on the same version", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(JSON.parse(read("extension-src/manifest.json")).version).toBe(version);
    expect(read("CHANGELOG.md")).toContain(`## ${version} - `);
  });
  it("moves a saved, untouched Relay default prompt to the Rove wording but keeps custom prompts", () => {
    const legacy = DEFAULT_PROMPT.replaceAll("Rove", "Relay");
    expect(legacy).not.toBe(DEFAULT_PROMPT);
    expect(normalizeSettings({ systemPrompt: legacy }).systemPrompt).toBe(DEFAULT_PROMPT);
    expect(normalizeSettings({ systemPrompt: "You are Relay. Be terse." }).systemPrompt).toBe("You are Relay. Be terse.");
  });
});
