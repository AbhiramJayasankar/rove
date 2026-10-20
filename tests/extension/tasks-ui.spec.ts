import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

// Two chats running at once from the panel: the strip lists both, finishing one leaves the other alone.
let context: BrowserContext, ui: Page, server: http.Server, origin: string;
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
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
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const text = JSON.stringify(JSON.parse(raw).messages);
      const slow = text.includes("alpha");
      await new Promise((resolve) => setTimeout(resolve, slow ? 4500 : 1200));
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: slow ? "Answer alpha." : "Answer beta." }, finish_reason: "stop" }] }));
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
  await ui.reload();
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

test("a second task can start while the first runs, and each finishes on its own", async () => {
  const prompt = ui.getByRole("textbox", { name: "Task prompt" });
  await prompt.fill("alpha task");
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(ui.getByRole("button", { name: "Stop generation" })).toBeVisible();

  // The first chat is still running; a new chat can be started right away.
  await ui.getByRole("button", { name: "New task", exact: true }).click();
  await prompt.fill("beta task");
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  const strip = ui.getByRole("navigation", { name: "Running tasks" });
  await expect(strip.getByRole("button")).toHaveCount(2);
  expect((await rpc("/api/state")).activeRunIds).toHaveLength(2);
  await ui.screenshot({ path: "test-results/tasks-strip.png" });

  await expect(ui.getByText("Answer beta.")).toBeVisible({ timeout: 15000 });
  // beta is done; alpha is still running and still listed.
  expect((await rpc("/api/state")).activeRunIds).toHaveLength(1);
  await strip.getByRole("button", { name: /alpha task/ }).click();
  await expect(ui.getByText("Answer alpha.")).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await rpc("/api/state")).activeRunIds).toEqual([]);
});
