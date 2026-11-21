import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import { openSection } from "./settings-nav";

// Settings added in 2.7.0, driven through the real UI: web search, the step limit without a limit,
// Gemini providers, and backup and restore. Also the fixed extension ID.
let context: BrowserContext, ui: Page, base: string;
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function openSettings(section: "Model" | "Browsing" | "Search and voice" | "Appearance" | "Backup") {
  await ui.goto(base);
  await openSection(ui, section);
}

test.beforeAll(async () => {
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, acceptDownloads: true, viewport: { width: 420, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  base = `chrome-extension://${new URL(worker.url()).host}/index.html`;
  ui = await context.newPage();
  await ui.goto(base);
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: "http://127.0.0.1:9/v1", model: "fixture", apiKey: "fixture-secret-7f3q" });
});
test.afterAll(async () => { await context?.close(); });

test("the extension ID is the same wherever the folder is", async () => {
  expect(new URL(base).host).toBe("mklgbmacaelcomgamkccjncffojpfekb");
});

test("a web search API and its key are saved from Settings, the key apart from settings", async () => {
  await openSettings("Search and voice");
  await ui.locator(".search-panel .choice-trigger").click();
  await ui.getByRole("option", { name: /Tavily/ }).click();
  await ui.getByLabel("Tavily API key").fill("tvly-e2e-key");
  await ui.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await rpc("/api/state")).settings.webSearch).toBe("tavily");
  expect((await rpc("/api/state")).searchKeys).toEqual({ exa: false, tavily: true, parallel: false });
  // The key never appears in settings or state.
  expect(JSON.stringify(await rpc("/api/state"))).not.toContain("tvly-e2e-key");
  await openSettings("Search and voice");
  await expect(ui.locator(".search-panel .field-state")).toContainText("Saved");
  await ui.locator(".search-panel .choice-trigger").click();
  await ui.getByRole("option", { name: /^Off/ }).click();
  await ui.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await rpc("/api/state")).settings.webSearch).toBe("off");
});

test("typing past 2000 turns the step limit off, and minus brings it back to 2000", async () => {
  await openSettings("Browsing");
  const steps = ui.locator("#step-limit");
  await steps.fill("2500");
  await expect(steps).toHaveValue("∞");
  await expect(ui.locator("#step-limit-note")).toContainText("No limit");
  await ui.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await rpc("/api/state")).settings.maxSteps).toBe(0);
  await openSettings("Browsing");
  await ui.getByRole("button", { name: "Fewer steps" }).click();
  await expect(steps).toHaveValue("2000");
  await ui.getByRole("button", { name: "No step limit" }).click();
  await expect(steps).toHaveValue("∞");
  await steps.fill("150");
  await ui.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await rpc("/api/state")).settings.maxSteps).toBe(150);
});

test("Vertex AI can be added from the provider menu and lists Gemini models without a request", async () => {
  await openSettings("Model");
  await ui.locator(".provider-picker-row .choice-trigger").click();
  await ui.getByRole("option", { name: "+ Add Vertex AI (Gemini)" }).click();
  await expect.poll(async () => (await rpc("/api/state")).providers.map((provider: any) => provider.name)).toContain("Vertex AI");
  const state = await rpc("/api/state");
  expect(state.settings.baseUrl).toBe("https://aiplatform.googleapis.com/v1/publishers/google");
  const { models } = await rpc("/api/models", "POST", { baseUrl: state.settings.baseUrl, apiKey: "" });
  expect(models.map((model: any) => model.id)).toEqual(expect.arrayContaining(["gemini-2.5-flash", "gemini-3.8-flash"]));
  await rpc("/api/providers", "DELETE", { id: state.activeProviderId });
});

test("a backup saved from Settings restores instructions and keys", async () => {
  await rpc("/api/settings", "PUT", { ...(await rpc("/api/state")).settings, systemPrompt: "Instructions to keep", memory: "Notes to keep" });
  await openSettings("Backup");
  const [download] = await Promise.all([ui.waitForEvent("download"), ui.getByRole("button", { name: "Save backup" }).click()]);
  const file = path.join(test.info().outputDir, download.suggestedFilename());
  await download.saveAs(file);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(saved).toMatchObject({ format: "rove-settings-backup", version: 1, includesKeys: true, storage: { modelApiKey: "fixture-secret-7f3q" } });
  expect(saved.storage.settings.systemPrompt).toBe("Instructions to keep");

  await rpc("/api/settings", "PUT", { ...(await rpc("/api/state")).settings, systemPrompt: "Something else", memory: "", apiKey: "" });
  expect((await rpc("/api/state")).hasApiKey).toBe(false);
  await openSettings("Backup");
  await ui.locator('.backup-panel input[type="file"]').setInputFiles(file);
  await expect(ui.locator(".backup-ok")).toContainText("Settings restored");
  await ui.waitForLoadState("load");
  await expect.poll(async () => (await rpc("/api/state")).settings.systemPrompt, { timeout: 10000 }).toBe("Instructions to keep");
  const state = await rpc("/api/state");
  expect(state.settings.memory).toBe("Notes to keep");
  expect(state.hasApiKey).toBe(true);
});

test("a theme picked in Settings repaints Rove at once and is kept", async () => {
  await openSettings("Appearance");
  await ui.getByRole("radio", { name: "Dark" }).click();
  await ui.getByRole("radio", { name: "Harbor" }).click();
  const ink = () => ui.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ink").trim());
  await expect.poll(ink).toBe("#e3e8ee");
  await expect(ui.getByRole("radio", { name: "Harbor" })).toHaveAttribute("aria-checked", "true");
  await ui.reload();
  await expect.poll(ink).toBe("#e3e8ee");
  expect(await ui.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.palette])).toEqual(["dark", "harbor"]);
  // The header switch keeps the theme and changes only light and dark.
  await ui.getByRole("button", { name: /use light mode/i }).click();
  await expect.poll(ink).toBe("#222831");
  await openSettings("Appearance");
  await ui.getByRole("radio", { name: "Match Chrome" }).click();
  await ui.getByRole("radio", { name: "Sage" }).click();
  expect(await ui.evaluate(() => [localStorage.getItem("relay.theme"), localStorage.getItem("relay.palette")])).toEqual([null, null]);
});

test("pitch black puts dark mode on #000000 and keeps the theme's accent", async () => {
  await openSettings("Appearance");
  await ui.getByRole("radio", { name: "Dark" }).click();
  await ui.getByRole("radio", { name: "Heather" }).click();
  const canvas = () => ui.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim());
  await expect.poll(canvas).toBe("#241f29");
  await ui.getByRole("switch", { name: "Pitch black in dark mode" }).check();
  await expect.poll(canvas).toBe("#000000");
  expect(await ui.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())).toBe("#cdb2e0");
  // Light mode is unaffected; the setting is kept for the next dark mode.
  await ui.getByRole("radio", { name: "Light" }).click();
  await expect.poll(canvas).toBe("#fcfafd");
  await ui.reload();
  expect(await ui.evaluate(() => localStorage.getItem("relay.black"))).toBe("1");
  await openSettings("Appearance");
  await ui.getByRole("switch", { name: "Pitch black in dark mode" }).uncheck();
  await ui.getByRole("radio", { name: "Match Chrome" }).click();
  await ui.getByRole("radio", { name: "Sage" }).click();
});

test("a scheduled task is made, turned off and deleted from the Scheduled tasks page", async () => {
  await ui.goto(base);
  await ui.getByRole("button", { name: "Scheduled tasks" }).click();
  await expect(ui.locator(".schedules-empty")).toBeVisible();
  await ui.getByRole("button", { name: "New schedule" }).click();
  await ui.getByLabel("What should Rove do?").fill("Check the status page and tell me if anything is down.");
  await ui.getByLabel("Name (optional)").fill("Status check");
  for (const day of ["Sat", "Sun"]) await ui.getByRole("button", { name: day, exact: true }).click();
  await ui.locator('.schedule-when input[type="time"]').fill("07:45");
  await ui.getByRole("button", { name: "Schedule", exact: true }).click();
  const card = ui.locator(".schedule-card").filter({ hasText: "Status check" });
  await expect(card).toContainText("Weekdays at");
  await expect(card).toContainText("Next:");
  const [saved] = (await rpc("/api/state")).schedules;
  expect(saved).toMatchObject({ name: "Status check", enabled: true, repeat: { kind: "days", time: "07:45", days: [1, 2, 3, 4, 5] } });
  expect(new Date(saved.nextAt).getHours()).toBe(7);
  await card.getByRole("switch").uncheck();
  await expect.poll(async () => (await rpc("/api/state")).schedules[0].enabled).toBe(false);
  ui.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Delete" }).click();
  await expect.poll(async () => (await rpc("/api/state")).schedules.length).toBe(0);
});
