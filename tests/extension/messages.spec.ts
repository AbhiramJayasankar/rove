import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

// Messages carry a time, the answer shows its output speed, and copy/edit sit outside the bubble.
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
      response.end(JSON.stringify({ data: [{ id: "fast:free", name: "Fast model", context_length: 32768, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] }] }));
      return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      for await (const _ of request);
      await new Promise((resolve) => setTimeout(resolve, 800));
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "A short answer." }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
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
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/v1", model: "fast:free", apiKey: "k" });
  await ui.reload();
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

test("messages show time and output speed, with copy and edit outside the bubble", async () => {
  await ui.getByRole("textbox", { name: "Task prompt" }).fill("Say something");
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(ui.getByText("A short answer.")).toBeVisible({ timeout: 15000 });

  const user = ui.locator(".message-row.user");
  await expect(user.locator("time")).toHaveCount(1);
  const bubble = await user.locator(".user-message").boundingBox();
  await user.hover();
  const edit = user.getByRole("button", { name: "Edit message" });
  const copy = user.getByRole("button", { name: "Copy message" });
  for (const button of [edit, copy]) {
    const box = (await button.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(bubble!.y + bubble!.height - 1);
    await expect(button).toBeVisible();
  }
  await copy.click();
  await expect(user.getByRole("button", { name: "Copied" })).toBeVisible();

  const answer = ui.locator(".assistant-block");
  await expect(answer.locator("time")).toHaveCount(1);
  const speed = await answer.locator(".message-speed").innerText();
  expect(speed).toMatch(/^\d+(\.\d)? tok\/s$/);
  await answer.hover();
  await answer.getByRole("button", { name: "Copy message" }).click();
  await expect(answer.getByRole("button", { name: "Copied" })).toBeVisible();
});
