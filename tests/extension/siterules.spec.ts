import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

// 127.0.0.1 and localhost are different hosts to site rules, so one server can play both sites.
let context: BrowserContext, ui: Page, server: http.Server, port: number;
const bodies: string[] = [];
const SECRET = "Account balance 1,234.56";
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const url = request.url ?? "/";
    if (url === "/out") {
      response.writeHead(302, { location: `http://localhost:${port}/secret` }).end();
      return;
    }
    if (url === "/secret") {
      response.setHeader("content-type", "text/html");
      response.end(`<title>Bank</title><p>${SECRET}</p>`);
      return;
    }
    response.setHeader("content-type", "application/json");
    if (url.endsWith("/models")) {
      response.end(JSON.stringify({ data: [{ id: "fixture", context_length: 32768, supported_parameters: ["tools"] }] }));
      return;
    }
    if (url.endsWith("/chat/completions")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      bodies.push(raw);
      const message = bodies.length === 1
        ? { role: "assistant", content: null, tool_calls: [{ id: "nav", type: "function", function: { name: "browser_navigate", arguments: JSON.stringify({ url: `http://127.0.0.1:${port}/out`, newTab: true }) } }] }
        : { role: "assistant", content: "Done." };
      response.end(JSON.stringify({ choices: [{ message, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }] }));
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
  await rpc("/api/settings", "PUT", {
    ...DEFAULT_SETTINGS,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "fixture",
    apiKey: "k",
    siteRules: [{ pattern: "localhost", action: "block" }],
  });
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

test("a redirect onto a blocked site does not reveal that page to the model", async () => {
  const run = await rpc("/api/runs", "POST", { prompt: "Follow the link.", tabId: null });
  await expect.poll(async () => (await rpc(`/api/runs/${run.id}`)).status, { timeout: 30000 }).toBe("completed");
  // The redirect really happened: the tab is on the blocked page.
  expect(context.pages().some((page) => page.url() === `http://localhost:${port}/secret`)).toBe(true);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).not.toContain(SECRET);
  expect(bodies[1]).not.toContain("data:image");
  const saved = await rpc(`/api/runs/${run.id}`);
  expect(JSON.stringify(saved)).not.toContain(SECRET);
  const result = saved.events.find((event: any) => event.type === "tool_result");
  expect(result.data.result).toMatchObject({ blocked: true, site: "localhost" });
});
