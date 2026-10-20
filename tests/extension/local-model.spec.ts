import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

// A llama.cpp-style server: /props reports no image support and a thinking template.
// The extension should detect that, and let the user replace both controls.
let context: BrowserContext, ui: Page, server: http.Server, origin: string;
const requests: any[] = [];
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: [{ id: "ling", owned_by: "llamacpp", meta: { n_ctx: 65536 } }] }));
      return;
    }
    if (request.url === "/props") {
      response.end(JSON.stringify({ build_info: "b1", modalities: { vision: false }, chat_template: "{% if enable_thinking %}<think>{% endif %}" }));
      return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw));
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }] }));
      return;
    }
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 520, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await expect(ui.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/v1", model: "ling", apiKey: "k" });
  await ui.reload();
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

async function ask(text: string) {
  requests.length = 0;
  await ui.getByRole("button", { name: "New task", exact: true }).click();
  await ui.getByRole("textbox", { name: "Task prompt" }).fill(text);
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(ui.getByText("Done.").last()).toBeVisible({ timeout: 15000 });
  return requests.at(-1);
}

test("a llama.cpp server is detected, and images and reasoning can be overridden per model", async () => {
  // Detected from /props: no images, so no screenshot tool; thinking switch becomes Off/High.
  const state = await rpc("/api/state");
  expect(state.modelInfo.contextWindow).toBe(65536);
  expect(state.modelInfo.supportsVision).toBe(false);
  const detected = await ask("first");
  expect(detected.tools.map((tool: any) => tool.function.name)).not.toContain("browser_screenshot");
  expect(detected.reasoning_effort).toBe("high");

  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(ui.getByText("The endpoint says this model cannot see images.")).toBeVisible();
  await ui.getByRole("combobox", { name: "Images", exact: true }).click();
  await ui.getByRole("option", { name: "Always send images" }).click();
  await expect.poll(async () => (await rpc("/api/state")).modelInfo.supportsVision).toBe(true);

  await ui.getByRole("combobox", { name: "Reasoning control", exact: true }).click();
  await ui.getByRole("option", { name: "Custom levels" }).click();
  await ui.getByRole("combobox", { name: "Start from a preset" }).click();
  await ui.getByRole("option", { name: /chat_template_kwargs/ }).click();
  await ui.getByRole("button", { name: "Save levels" }).click();
  await expect.poll(async () => (await rpc("/api/state")).modelInfo.customReasoning?.length).toBe(2);
  await ui.screenshot({ path: "test-results/model-abilities.png", fullPage: true });

  const custom = await ask("second");
  expect(custom.tools.map((tool: any) => tool.function.name)).toContain("browser_screenshot");
  expect(custom.chat_template_kwargs).toEqual({ enable_thinking: true });
  expect(custom).not.toHaveProperty("reasoning_effort");
  await rpc("/api/run-options", "PUT", { reasoningEffort: "off" });
  const off = await ask("third");
  expect(off.chat_template_kwargs).toEqual({ enable_thinking: false });
});

test("invalid request fields are refused", async () => {
  const result = await ui.evaluate(() => chrome.runtime.sendMessage({ type: "rove-api", path: "/api/model-override", method: "PUT", body: { baseUrl: "http://x/v1", model: "m", override: { reasoning: [{ value: "a", label: "A", body: '{"messages":[]}' }] } } }));
  expect(result.ok).toBe(false);
});

test("model details show what the endpoint reports, in Settings and in the picker", async () => {
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  const details = ui.locator(".model-details");
  await expect(details.getByText("65,536 tokens").first()).toBeVisible();
  await expect(details.getByText("Off · On (Custom levels)")).toBeVisible();
  await expect(details.getByText("Not reported").first()).toBeVisible();
  await details.getByText("Raw endpoint data").click();
  await expect(details.locator("pre")).toContainText('"owned_by": "llamacpp"');
  await details.scrollIntoViewIfNeeded();
  await ui.screenshot({ path: "test-results/model-details.png", fullPage: true });

  await ui.getByRole("button", { name: "New task", exact: true }).click();
  await ui.getByRole("button", { name: "Choose model", exact: true }).click();
  await ui.getByRole("button", { name: "Details for ling" }).hover();
  await expect(ui.getByRole("tooltip")).toContainText("Context window");
  await ui.screenshot({ path: "test-results/model-picker-details.png" });
});
