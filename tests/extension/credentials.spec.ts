import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

// One server answers as two origins: 127.0.0.1 (the saved provider) and localhost (an address being typed).
let context: BrowserContext, ui: Page, server: http.Server, port: number;
const seen: { host: string; path: string; auth: string }[] = [];
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
const authTo = (host: string) => seen.filter((request) => request.host.startsWith(host)).map((request) => request.auth);
test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    seen.push({ host: request.headers.host ?? "", path: request.url ?? "", auth: request.headers.authorization ?? "" });
    for await (const _ of request);
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: [{ id: "fixture", context_length: 32768, supported_parameters: ["tools"] }] }));
      return;
    }
    if (request.url?.endsWith("/chat/completions")) {
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
      return;
    }
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: `http://127.0.0.1:${port}/v1`, model: "fixture", apiKey: "saved-key" });
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

test("a saved key is only sent to its own provider's origin while another address is typed", async () => {
  seen.length = 0;
  await rpc("/api/models", "POST", { baseUrl: `http://127.0.0.1:${port}/v1`, refresh: true });
  expect(authTo("127.0.0.1")).toContain("Bearer saved-key");

  seen.length = 0;
  await rpc("/api/models", "POST", { baseUrl: `http://localhost:${port}/v1`, refresh: true });
  expect(authTo("localhost").length).toBeGreaterThan(0);
  expect(authTo("localhost")).not.toContain("Bearer saved-key");

  seen.length = 0;
  // The fixture makes no tool call, so the test itself reports a failure; only the headers matter here.
  await rpc("/api/model/test", "POST", { baseUrl: `http://localhost:${port}/v1`, model: "fixture" }).catch(() => {});
  expect(authTo("localhost").length).toBeGreaterThan(0);
  expect(authTo("localhost")).not.toContain("Bearer saved-key");

  // A key typed for the new address is used for it.
  seen.length = 0;
  await rpc("/api/models", "POST", { baseUrl: `http://localhost:${port}/v1`, apiKey: "typed-key", refresh: true });
  expect(authTo("localhost")).toContain("Bearer typed-key");
});
