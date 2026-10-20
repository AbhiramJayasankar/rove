import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

// Two providers at once: a llama.cpp server and an aggregator with several models.
// Listing both must not hide the active model's reasoning, and any listed model can be inspected.
let context: BrowserContext, ui: Page, server: http.Server, origin: string;
let local = "", router = "";
const requests: any[] = [];
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
const ROUTER_MODELS = [
  { id: "alpha", name: "Alpha", context_length: 131072, supported_parameters: ["tools", "reasoning_effort"], reasoning_efforts: ["low", "high"], architecture: { input_modalities: ["text", "image"] } },
  { id: "beta", name: "Beta", context_length: 8192, supported_parameters: ["tools"] },
  { id: "gamma", name: "Gamma", context_length: 32768, supported_parameters: ["tools"] },
];
test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const url = request.url || "";
    if (url === "/local/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "ling", owned_by: "llamacpp", meta: { n_ctx: 65536 } }] }));
      return;
    }
    if (url === "/local/props") {
      response.end(JSON.stringify({ build_info: "b1", modalities: { vision: false }, chat_template: "{% if enable_thinking %}<think>{% endif %}" }));
      return;
    }
    if (url === "/router/v1/models") {
      response.end(JSON.stringify({ data: ROUTER_MODELS }));
      return;
    }
    if (url.endsWith("/chat/completions")) {
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
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 420, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await expect(ui.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  local = (await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/local/v1", model: "ling", apiKey: "local-key", providerName: "Laptop" })).activeProviderId;
  await rpc("/api/providers", "POST", { name: "Router", baseUrl: origin + "/router/v1" });
  router = (await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/router/v1", model: "alpha", apiKey: "router-key" })).activeProviderId;
  await rpc("/api/providers", "PUT", { id: local });
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

test("the reasoning picker survives listing every provider", async () => {
  // Listing both catalogues used to leave only the last one known, so the active model looked unknown.
  await rpc("/api/models");
  expect((await rpc("/api/state")).modelInfo).toMatchObject({ id: "ling", reasoningFormat: "reasoning_effort" });
  const composer = ui.locator(".task-composer");
  await expect(composer.getByRole("combobox", { name: "Reasoning level" })).toBeVisible();

  await rpc("/api/run-options", "PUT", { providerId: router, model: "alpha" });
  await rpc("/api/models");
  expect((await rpc("/api/state")).modelInfo).toMatchObject({ id: "alpha", reasoningEfforts: ["low", "high"] });
  await composer.getByRole("combobox", { name: "Reasoning level" }).click();
  await expect(ui.getByRole("option")).toHaveText(["Low", "High"]);
  await ui.keyboard.press("Escape");
});

test("image mode switches the current model to text only and back", async () => {
  const toggle = ui.locator(".task-composer").getByRole("button", { name: "Image mode", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect((await rpc("/api/state")).modelInfo).toMatchObject({ supportsVision: false, endpointVision: true, override: { images: "off" } });
  await ui.screenshot({ path: "test-results/image-mode-off.png" });

  const textOnly = await ask("text only");
  expect(textOnly.tools.map((tool: any) => tool.function.name)).not.toContain("browser_screenshot");
  expect(textOnly.messages[0].content).toContain("This model cannot see images.");
  expect(textOnly.messages[0].content).not.toContain("browser_screenshot and coordinate tools");

  await ui.locator(".task-composer").getByRole("button", { name: "Image mode", exact: true }).click();
  await expect(ui.locator(".task-composer").getByRole("button", { name: "Image mode", exact: true })).toHaveAttribute("aria-pressed", "true");
  // Back to the endpoint's own answer: no override is left behind.
  expect((await rpc("/api/state")).modelInfo.override).toBeUndefined();
  const withImages = await ask("with images");
  expect(withImages.tools.map((tool: any) => tool.function.name)).toContain("browser_screenshot");
});

test("settings can inspect and adjust any listed model, not only the chat model", async () => {
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  const details = ui.locator(".model-details");
  await expect(details.getByText("131,072 tokens").first()).toBeVisible();
  await ui.getByRole("button", { name: "Model to inspect", exact: true }).click();
  const picker = ui.getByRole("dialog", { name: "Model picker" });
  await expect(picker.getByRole("option")).toHaveCount(3);
  await picker.getByRole("textbox", { name: "Search models" }).fill("bet");
  await picker.getByRole("option", { name: "Beta", exact: true }).click();
  await expect(details.getByText("8,192 tokens").first()).toBeVisible();
  await expect(ui.getByText("These apply to Beta and save at once. New tasks use them.")).toBeVisible();
  await ui.locator(".model-panel").screenshot({ path: "test-results/model-inspect.png" });

  await ui.getByRole("combobox", { name: "Images", exact: true }).click();
  await ui.getByRole("option", { name: "Never send images" }).click();
  await expect(details.getByText("Image input").locator("..")).toContainText("No");
  const beta = (await rpc("/api/models")).models.find((model: any) => model.id === "beta");
  expect(beta.override).toEqual({ images: "off" });
  // The chat model is untouched.
  expect((await rpc("/api/state")).modelInfo).toMatchObject({ id: "alpha" });
  expect((await rpc("/api/state")).modelInfo.override).toBeUndefined();

  await ui.getByRole("button", { name: "Show the chat model" }).click();
  await expect(details.getByText("131,072 tokens").first()).toBeVisible();
});
