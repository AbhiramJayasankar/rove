import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

// Which chat a Rove page shows when it opens, and the preview of a tab a task is working in.
// (The side panel's per-tab chats need Chrome's real side panel, which headless Chrome does not create;
// the binding they read is covered in extension-core/tests/runtime.test.ts.)
let context: BrowserContext, ui: Page, server: http.Server, origin: string, app: string;
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
const finished = async (id: string) => expect.poll(async () => (await rpc(`/api/runs/${id}`)).status, { timeout: 20000 }).toBe("completed");
test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.url === "/page") {
      response.setHeader("content-type", "text/html");
      response.end("<title>Fixture page</title><h1>Fixture page</h1>");
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: [{ id: "fixture", context_length: 32768, supported_parameters: ["tools"] }] }));
      return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      const body = JSON.parse(raw);
      const text = JSON.stringify(body.messages);
      const toolTurns = body.messages.filter((message: any) => message.role === "tool").length;
      const tab = Number(/selected tab ID (\d+)/.exec(text)?.[1]);
      if (text.includes("Work slowly") && toolTurns === 0) {
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "shot", type: "function", function: { name: "browser_screenshot", arguments: JSON.stringify({ tabId: tab }) } }] }, finish_reason: "tool_calls" }] }));
        return;
      }
      if (text.includes("Work slowly")) await new Promise((resolve) => setTimeout(resolve, 4000));
      const prompt = /"content":"([^"\\]*)/.exec(text.slice(text.indexOf('"role":"user"')))?.[1] ?? "";
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `Done: ${prompt.slice(0, 30)}` }, finish_reason: "stop" }] }));
      return;
    }
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 420, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  app = `chrome-extension://${new URL(worker.url()).host}/index.html`;
  ui = await context.newPage();
  await ui.goto(app);
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/v1", model: "fixture", apiKey: "k" });
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

test("a newly opened Rove tab starts fresh, and reloading that tab keeps its own chat", async () => {
  const old = await rpc("/api/runs", "POST", { prompt: "An older chat", tabId: null });
  await finished(old.id);

  const page = await context.newPage();
  await page.goto(app);
  await expect(page.getByRole("heading", { name: "What’s the task?" })).toBeVisible();
  await expect(page.locator(".main-shell").getByText("An older chat")).toHaveCount(0);

  await page.getByRole("textbox", { name: "Task prompt" }).fill("This tab's chat");
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(page.getByText("Done: This tab's chat")).toBeVisible({ timeout: 15000 });
  await page.reload();
  await expect(page.getByText("Done: This tab's chat")).toBeVisible();

  // Another new Rove tab is fresh again; the history still has both chats.
  const another = await context.newPage();
  await another.goto(app);
  await expect(another.getByRole("heading", { name: "What’s the task?" })).toBeVisible();
  await another.getByRole("button", { name: "Task history" }).click();
  await expect(another.getByRole("dialog").getByText("An older chat")).toBeVisible();
  await expect(another.getByRole("dialog").getByText("This tab's chat")).toBeVisible();
  await page.close();
  await another.close();
});

test("the preview of a tab a task is working in shows the task's screenshot instead of an error", async () => {
  const site = await context.newPage();
  await site.goto(origin + "/page");
  const tabId = (await rpc("/api/tabs")).find((tab: any) => tab.url === origin + "/page").id;
  const run = await rpc("/api/runs", "POST", { prompt: "Work slowly", tabId });
  await ui.bringToFront();
  await ui.reload();
  await expect.poll(async () => (await rpc(`/api/runs/${run.id}`)).events.some((event: any) => event.type === "screenshot"), { timeout: 15000 }).toBe(true);
  await ui.getByRole("button", { name: "Browser preview" }).click();
  await expect(ui.getByRole("status").filter({ hasText: "Rove is working in this tab." })).toBeVisible();
  await expect(ui.getByRole("img", { name: /Chrome view/ })).toBeVisible();
  await expect(ui.getByRole("alert")).toHaveCount(0);
  await expect(ui.getByRole("button", { name: "Take browser screenshot" })).toBeDisabled();
  await finished(run.id);
  await expect(ui.getByRole("status").filter({ hasText: "Rove is working in this tab." })).toHaveCount(0);
  await expect(ui.getByRole("button", { name: "Take browser screenshot" })).toBeEnabled();
});

test("leaving Settings with unsaved changes asks to save, discard or keep editing", async () => {
  const page = await context.newPage();
  await page.goto(app);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const back = page.getByRole("button", { name: "Back to chat", exact: true });
  const dialog = page.getByRole("dialog", { name: "Unsaved changes" });
  // Looking around without changing anything leaves straight away.
  await settings.click();
  await page.getByRole("button", { name: "Instructions", exact: true }).click();
  await back.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Task prompt" })).toBeVisible();

  await settings.click();
  await page.getByRole("button", { name: "Instructions", exact: true }).click();
  await page.getByRole("button", { name: "Add saved prompt" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("cart");
  await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Go to the shop.");
  await page.getByRole("button", { name: "Keep prompt" }).click();
  await back.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByText("/cart")).toBeVisible();
  await back.click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Task prompt" })).toBeVisible();
  expect((await page.evaluate(() => chrome.storage.local.get("shortcuts"))).shortcuts.map((item: any) => item.name)).toEqual(["cart"]);

  await settings.click();
  await page.getByRole("button", { name: "Instructions", exact: true }).click();
  await page.getByRole("textbox", { name: "Standing instructions" }).fill("Always be brief.");
  await back.click();
  await dialog.getByRole("button", { name: "Discard" }).click();
  await settings.click();
  await page.getByRole("button", { name: "Instructions", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Standing instructions" })).toHaveValue("");
  expect((await rpc("/api/state")).settings.memory).toBe("");
  await page.close();
});
