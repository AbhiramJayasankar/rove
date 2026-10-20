import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

let context: BrowserContext, ui: Page, server: http.Server;
const bodies: any[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const text = "Fixture attachment contents.";
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: [{ id: "fixture", name: "Fixture", context_length: 32768, input_modalities: ["text", "image"], supported_parameters: ["tools"] }] }));
      return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      bodies.push(JSON.parse(raw));
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Both attachments received." }, finish_reason: "stop" }] }));
      return;
    }
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await expect(ui.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/v1", model: "fixture", apiKey: "fixture-key" });
  await ui.reload();
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
});

test("sends text and image attachments as ordered model parts and renders the answer", async () => {
  await ui.getByLabel("Attach files", { exact: true }).setInputFiles([
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(text) },
    { name: "pixel.png", mimeType: "image/png", buffer: png },
  ]);
  await ui.getByRole("textbox", { name: "Task prompt" }).fill("Read both files.");
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(ui.getByText("Both attachments received.", { exact: true })).toBeVisible({ timeout: 15000 });
  expect(bodies).toHaveLength(1);
  const parts = bodies[0].messages[1].content;
  expect(parts.map((part: any) => part.type)).toEqual(["text", "text", "text", "image_url"]);
  expect(parts[0].text).toContain("Read both files.\n\nBrowser context:");
  expect(parts[1].text).toContain('Attached file "notes.txt":\n');
  expect(parts[1].text).toContain("untrusted data");
  expect(parts[1].text).toContain(text);
  const state = await rpc("/api/state");
  const run = await rpc(`/api/runs/${state.runs[0].id}`);
  const attachments = run.events.filter((event: any) => event.type === "attachment");
  expect(attachments.map((event: any) => event.data.name)).toEqual(["notes.txt", "pixel.png"]);
  expect(parts[2].text).toBe(`[Rove attachment ${attachments[1].id}] Image attached by the user: pixel.png`);
  expect(parts[3].image_url.url).toBe(`data:image/png;base64,${png.toString("base64")}`);
});
