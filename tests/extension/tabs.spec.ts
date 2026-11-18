import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

// Which tab a task works in: New Tab mode started beside an empty tab uses that tab, and a tab a page
// opens from a click belongs to the task straight away.
let context: BrowserContext, ui: Page, server: http.Server, origin: string;
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
const finished = async (id: string) => expect.poll(async () => (await rpc(`/api/runs/${id}`)).status, { timeout: 20000 }).toBe("completed");
const allTabs = () => ui.evaluate(async () => (await chrome.tabs.query({})).map((tab) => ({ id: tab.id!, url: tab.url || tab.pendingUrl || "", groupId: tab.groupId, active: tab.active })));
const call = (name: string, args: unknown) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `${name}-${Math.random().toString(36).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });
const toolResults = (messages: any[]) => messages.filter((message) => message.role === "tool").map((message) => String(message.content));

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.url === "/links") {
      response.setHeader("content-type", "text/html");
      response.end(`<title>Links</title><a href="/opened" target="_blank" style="position:fixed;left:0;top:0;width:400px;height:300px;display:block;background:#cde">Open in a new tab</a>`);
      return;
    }
    if (request.url?.startsWith("/page") || request.url === "/opened") {
      response.setHeader("content-type", "text/html");
      response.end(`<title>Page ${request.url}</title><h1>${request.url}</h1>`);
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
      const results = toolResults(body.messages);
      if (text.includes("Open the page") && results.length === 0) {
        response.end(JSON.stringify(call("browser_navigate", { url: origin + "/page-new", newTab: true })));
        return;
      }
      if (text.includes("Click the link")) {
        if (results.length === 0) { response.end(JSON.stringify(call("browser_navigate", { url: origin + "/links", newTab: true }))); return; }
        if (results.length === 1) {
          const tabId = Number(/"tabId":(\d+)/.exec(results[0])?.[1]);
          response.end(JSON.stringify(call("browser_click", { tabId, x: 50, y: 50 })));
          return;
        }
        if (results.length === 2) {
          // Hold the task open so the test can see the new tab bound while the task is still running.
          await new Promise((resolve) => setTimeout(resolve, 2500));
          response.end(JSON.stringify(call("browser_wait", { milliseconds: 10 })));
          return;
        }
      }
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `Done after ${results.length} tool results: ${results.join(" | ").slice(0, 3000)}` }, finish_reason: "stop" }] }));
      return;
    }
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 900, height: 800 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/v1", model: "fixture", apiKey: "fixture-secret-7f3q" });
});
test.afterAll(async () => { await context?.close(); await new Promise<void>((resolve) => server?.close(() => resolve())); });

for (const start of ["about:blank", "chrome://newtab/"]) {
  test(`New Tab mode beside an empty tab (${start}) works in that tab instead of opening another`, async () => {
    const empty = await context.newPage();
    await empty.goto(start).catch(() => {});
    const before = await allTabs();
    const blank = before.find((tab) => !tab.url.startsWith("chrome-extension:") && !tab.url.startsWith("http"))!;
    expect(blank).toBeTruthy();
    const run = await rpc("/api/runs", "POST", { prompt: "Open the page", tabId: null, reuseTabId: blank.id });
    await finished(run.id);
    const after = await allTabs();
    expect(after).toHaveLength(before.length);
    expect(after.find((tab) => tab.id === blank.id)).toMatchObject({ url: origin + "/page-new", groupId: -1 });
    expect((await rpc("/api/state")).tabChats[String(blank.id)]).toBe(run.id);
    await empty.close();
  });
}

test("New Tab mode beside an ordinary page leaves that page alone and opens a new tab", async () => {
  const site = await context.newPage();
  await site.goto(origin + "/page-mine");
  const before = await allTabs();
  const mine = before.find((tab) => tab.url === origin + "/page-mine")!;
  const run = await rpc("/api/runs", "POST", { prompt: "Open the page", tabId: null, reuseTabId: mine.id });
  await finished(run.id);
  const after = await allTabs();
  expect(after).toHaveLength(before.length + 1);
  expect(after.find((tab) => tab.id === mine.id)!.url).toBe(origin + "/page-mine");
  expect(after.some((tab) => tab.url === origin + "/page-new" && tab.groupId !== -1)).toBe(true);
  await site.close();
});

test("a tab a click opens belongs to the task at once, joins its group and is reported to the model", async () => {
  const run = await rpc("/api/runs", "POST", { prompt: "Click the link", tabId: null });
  let opened: { id: number; groupId: number } | undefined;
  await expect.poll(async () => {
    opened = (await allTabs()).find((tab) => tab.url === origin + "/opened");
    return opened ? (await rpc("/api/state")).tabChats[String(opened.id)] : undefined;
  }, { timeout: 15000 }).toBe(run.id);
  // Bound while the task is still running, not only after it finishes.
  expect((await rpc(`/api/runs/${run.id}`)).status).toBe("running");
  const links = (await allTabs()).find((tab) => tab.url === origin + "/links")!;
  expect(opened!.groupId).toBe(links.groupId);
  await finished(run.id);
  const record = await rpc(`/api/runs/${run.id}`);
  const clicked = record.events.find((event: any) => event.type === "tool_result" && event.data?.name === "browser_click");
  expect(JSON.stringify(clicked?.data)).toContain(`"openedTabs":[${opened!.id}]`);
});
