import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

let context: BrowserContext, ui: Page, server: http.Server, origin: string;
const bodies: any[] = [];
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: [{ id: "fixture:free", name: "Fixture model", context_length: 32768, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }] }));
      return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      bodies.push(JSON.parse(raw));
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "The fixture answer." }, finish_reason: "stop" }] }));
      return;
    }
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 420, height: 850 }, acceptDownloads: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await expect(ui.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/v1", model: "fixture:free", apiKey: "k" });
  await ui.reload();
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

test("standing instructions, saved prompts and site rules save and take effect", async () => {
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await ui.getByRole("button", { name: "Instructions", exact: true }).click();
  await ui.getByRole("textbox", { name: "Standing instructions" }).fill("Always answer in British English.");
  await ui.getByRole("button", { name: "Add saved prompt" }).click();
  await ui.getByRole("textbox", { name: "Name", exact: true }).fill("daily-news");
  await ui.getByRole("textbox", { name: "Prompt", exact: true }).fill("Summarize the top five stories.");
  await ui.getByRole("textbox", { name: "Start page (optional)", exact: true }).fill("https://news.ycombinator.com");
  await ui.getByRole("button", { name: "Keep prompt" }).click();
  await expect(ui.getByText("/daily-news")).toBeVisible();
  await ui.getByRole("button", { name: "Tools", exact: true }).click();
  await ui.getByLabel("Site to add").fill("https://www.Example.com/page");
  await ui.getByRole("button", { name: "Block www.example.com" }).click();
  await expect(ui.getByRole("radio", { name: "Block", checked: true })).toBeVisible();
  await ui.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect.poll(async () => (await rpc("/api/state")).settings.memory).toBe("Always answer in British English.");
  expect((await rpc("/api/state")).settings.siteRules).toEqual([{ pattern: "www.example.com", action: "block" }]);
  await ui.getByRole("button", { name: "Back to chat", exact: true }).click();

  const prompt = ui.getByRole("textbox", { name: "Task prompt" });
  await prompt.fill("/daily");
  await expect(ui.getByRole("option", { name: /daily-news/ })).toBeVisible();
  await prompt.press("Enter");
  await expect(prompt).toHaveValue("Start at https://news.ycombinator.com. Summarize the top five stories.");
  await prompt.fill("Say hello");
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(ui.getByText("The fixture answer.")).toBeVisible({ timeout: 15000 });
  expect(bodies.at(-1).messages[0].content).toContain("Always answer in British English.");
});

test("exports the chat as Markdown", async () => {
  await ui.getByRole("button", { name: "Trace", exact: true }).click();
  const download = ui.waitForEvent("download");
  await ui.getByRole("button", { name: "Export chat as Markdown" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^rove-chat-.*\.md$/);
  const text = fs.readFileSync((await file.path())!, "utf8");
  expect(text).toContain("## You");
  expect(text).toContain("Say hello");
  expect(text).toContain("The fixture answer.");
  expect(text).not.toContain("model_request");
});
