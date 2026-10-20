import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

// Regression: if the live event port drops or stalls, the panel used to stay on "Working…"
// with no steps until the extension was reloaded.
let context: BrowserContext, ui: Page, server: http.Server, origin: string;
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "relay-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: [{ id: "slow:free", name: "Slow model", context_length: 32768, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }] }));
      return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      for await (const _ of request) { /* consume */ }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "The research finished fine." }, finish_reason: "stop" }] }));
      return;
    }
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 420, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await expect(ui.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/v1", model: "slow:free", apiKey: "k" });
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

test("a stalled event stream still shows the steps and the final answer", async () => {
  // Replace the events port with one that never delivers anything.
  await ui.addInitScript(() => {
    const connect = chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect = ((info: any) =>
      info?.name === "relay-events"
        ? ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} } as any)
        : connect(info)) as typeof chrome.runtime.connect;
  });
  await ui.reload();
  await ui.getByRole("textbox", { name: "Task prompt" }).fill("Do the research");
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(ui.getByText("The research finished fine.")).toBeVisible({ timeout: 15000 });
  await expect(ui.getByRole("button", { name: "Stop generation" })).toHaveCount(0);
});
