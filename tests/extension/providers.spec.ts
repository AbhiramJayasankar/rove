import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

let context: BrowserContext, ui: Page, server: http.Server, origin: string;
const calls: { provider: string; key?: string }[] = [];
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "relay-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const provider = request.url!.split("/")[1];
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      if (provider === "broken") { response.writeHead(503); response.end("Unavailable"); return; }
      response.end(JSON.stringify({ data: [{ id: "shared:free", name: "Shared model", context_length: 32768, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }] })); return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      for await (const _ of request) { /* consume fixture request */ }
      calls.push({ provider, key: request.headers.authorization });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `Answer from ${provider}` }, finish_reason: "stop" }] })); return;
    }
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage(); await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html?view=tab`);
  await expect(ui.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
});
test.afterAll(async () => { await context?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });
test("combines providers with duplicate model IDs and routes each selected model to its own key", async () => {
  const original = await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/first/v1", model: "shared:free", apiKey: "first-secret", providerName: "First provider" });
  const first = original.activeProviderId;
  await rpc("/api/providers", "POST", { name: "Second provider", baseUrl: origin + "/second/v1" });
  const secondSettings = await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/second/v1", model: "shared:free", apiKey: "second-secret" });
  const second = secondSettings.activeProviderId;
  const models = await rpc("/api/models");
  expect(models.models.map((model: any) => model.providerId).sort()).toEqual([first, second].sort());
  expect(models.models.map((model: any) => model.id)).toEqual(["shared:free", "shared:free"]);
  await ui.reload();
  await ui.locator(".task-composer").getByRole("button", { name: "Choose model", exact: true }).click();
  const picker = ui.getByRole("dialog", { name: "Model picker" });
  await expect(picker.getByRole("option")).toHaveCount(2);
  await picker.getByRole("option").filter({ hasText: "First provider" }).click();
  expect((await rpc("/api/state")).activeProviderId).toBe(first);
  const run = await rpc("/api/runs", "POST", { prompt: "Say hello", tabId: null });
  await expect.poll(async () => (await rpc(`/api/runs/${run.id}`)).status).toBe("completed");
  expect(calls.at(-1)).toEqual({ provider: "first", key: "Bearer first-secret" });
  await rpc("/api/run-options", "PUT", { providerId: second, model: "shared:free" });
  await rpc(`/api/runs/${run.id}/messages`, "POST", { message: "Say hello again", tabId: null });
  await expect.poll(async () => (await rpc(`/api/runs/${run.id}`)).status).toBe("completed");
  expect(calls.at(-1)).toEqual({ provider: "second", key: "Bearer second-secret" });
  const exported = JSON.stringify(await rpc(`/api/runs/${run.id}/export`));
  expect(exported).not.toContain("first-secret"); expect(exported).not.toContain("second-secret");
  const state = JSON.stringify(await rpc("/api/state"));
  expect(state).not.toContain("first-secret"); expect(state).not.toContain("second-secret");
  await ui.reload(); expect((await rpc("/api/state")).providers).toHaveLength(2);
});
test("one unavailable catalogue does not hide other providers", async () => {
  await rpc("/api/providers", "POST", { name: "Broken provider", baseUrl: origin + "/broken/v1" });
  const result = await rpc("/api/models");
  expect(result.models).toHaveLength(2);
  expect(result.warnings).toEqual(["Could not load Broken provider models."]);
  const current = await rpc("/api/state");
  await rpc("/api/providers", "DELETE", { id: current.activeProviderId });
  expect((await rpc("/api/state")).providers).toHaveLength(2);
});
test("settings adds OpenRouter, saves its own connection and keeps existing providers", async () => {
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await ui.getByRole("combobox", { name: "Configure provider" }).click();
  await ui.getByRole("option", { name: "+ Add OpenRouter", exact: true }).click();
  await expect(ui.getByRole("textbox", { name: "Provider name", exact: true })).toHaveValue("OpenRouter");
  await expect(ui.getByRole("textbox", { name: "API base URL", exact: true })).toHaveValue("https://openrouter.ai/api/v1");
  await ui.getByRole("textbox", { name: "API base URL", exact: true }).fill(origin + "/router/v1");
  await ui.locator("#provider-key").fill("router-ui-secret");
  await ui.getByRole("button", { name: "Choose model", exact: true }).last().click();
  await ui.getByRole("dialog", { name: "Model picker" }).getByRole("option").filter({ hasText: "OpenRouter" }).click();
  await ui.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(async () => (await rpc("/api/state")).settings.baseUrl).toBe(origin + "/router/v1");
  expect((await rpc("/api/state")).providers).toHaveLength(3);
  await ui.reload();
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(ui.getByRole("combobox", { name: "Configure provider" })).toHaveText("OpenRouter");
  await ui.setViewportSize({ width: 400, height: 900 });
  expect(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await ui.screenshot({ path: "test-results/provider-settings.png", fullPage: true });
  await ui.getByRole("button", { name: "Back to chat", exact: true }).click();
  await ui.locator(".task-composer").getByRole("button", { name: "Choose model", exact: true }).click();
  await expect(ui.getByRole("dialog", { name: "Model picker" }).getByRole("option")).toHaveCount(3);
  await ui.screenshot({ path: "test-results/provider-models.png", fullPage: true });
  await ui.keyboard.press("Escape");
  const run = await rpc("/api/runs", "POST", { prompt: "Hello router", tabId: null });
  await expect.poll(async () => (await rpc(`/api/runs/${run.id}`)).status).toBe("completed");
  expect(calls.at(-1)).toEqual({ provider: "router", key: "Bearer router-ui-secret" });
});
