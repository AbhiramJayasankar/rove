import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

let context: BrowserContext, ui: Page, server: http.Server, origin: string;
const pending = new Map<string, { response: http.ServerResponse; body: any; key?: string }>();
const pages: Page[] = [];
const toolCall = (name: string, args: unknown) => ({
  role: "assistant", content: null,
  tool_calls: [{ id: "fixture-call", type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
function answer(prompt: string, message: unknown = { role: "assistant", content: "Done." }) {
  const request = pending.get(prompt);
  if (!request) throw new Error(`No pending fixture request for ${prompt}`);
  pending.delete(prompt);
  request.response.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
  return request;
}
async function waiting(prompt: string) {
  await expect.poll(() => [...pending.keys()]).toContain(prompt);
  return pending.get(prompt)!;
}
async function raw(route: string, method = "GET", body?: unknown) {
  return ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
}
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await raw(route, method, body);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function tab() {
  const page = await context.newPage();
  pages.push(page);
  await page.goto(origin + `/page/${pages.length}`);
  return ui.evaluate(url => new Promise<number>(resolve => chrome.tabs.query({}, tabs => resolve(tabs.find(tab => tab.url === url)!.id!))), page.url());
}
async function start(prompt: string, tabId: number | null) {
  const run = await rpc("/api/runs", "POST", { prompt, tabId });
  try { await waiting(prompt); }
  catch (error) { throw new Error(`${String(error)}\nRun: ${JSON.stringify(await rpc(`/api/runs/${run.id}`))}`); }
  return run;
}
async function status(id: string, expected: string) {
  await expect.poll(async () => (await rpc(`/api/runs/${id}`)).status).toBe(expected);
}
async function attached(tabId: number) {
  return ui.evaluate(async id => {
    try { await chrome.debugger.sendCommand({ tabId: id }, "Target.getTargetInfo"); return true; }
    catch { return false; }
  }, tabId);
}
async function tool(prompt: string, name: string, args = {}) {
  await waiting(prompt);
  answer(prompt, toolCall(name, args));
  const next = await waiting(prompt);
  return JSON.parse(next.body.messages.findLast((message: any) => message.role === "tool").content);
}

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/models")) {
      response.end(JSON.stringify({ data: ["fixture", "other"].map(id => ({ id, context_length: 32768, supported_parameters: ["tools"] })) }));
    } else if (request.url?.endsWith("/chat/completions")) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (body.tools[0]?.function.name === "rove_connection_check") {
        response.end(JSON.stringify({ choices: [{ message: toolCall("rove_connection_check", { status: "ok" }), finish_reason: "tool_calls" }] }));
        return;
      }
      const prompt = body.messages.find((message: any) => message.role === "user").content.split("\n")[0];
      pending.set(prompt, { response, body, key: request.headers.authorization });
    } else {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Concurrency fixture</title><h1>Task page</h1><button>Example</button>");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
});
test.beforeEach(async () => {
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/v1", model: "fixture", apiKey: "fixture-key", approvalMode: "never" });
});
test.afterEach(async () => {
  if (ui && !ui.isClosed()) {
    for (const id of (await rpc("/api/state")).activeRunIds) await rpc(`/api/runs/${id}/stop`, "POST");
  }
  for (const { response } of pending.values()) response.destroy();
  pending.clear();
  for (const page of pages.splice(0)) await page.close();
});
test.afterAll(async () => {
  await context?.close();
  server?.closeAllConnections();
  await new Promise<void>(resolve => server?.close(() => resolve()));
});

test("finishing and continuing one chat preserves the other chat's debugger and snapshot", async () => {
  await ui.evaluate(() => {
    const seen: any[] = [];
    (globalThis as any).concurrencyEvents = seen;
    const port = chrome.runtime.connect({ name: "rove-events" });
    port.onMessage.addListener(message => seen.push(message));
    (globalThis as any).concurrencyPort = port;
  });
  const firstTab = await tab(), secondTab = await tab();
  const first = await start("first", firstTab), second = await start("second", secondTab);
  const state = await rpc("/api/state");
  expect(state.activeRunIds).toEqual([first.id, second.id]);
  expect(state.activeRunId).toBe(second.id);
  await rpc("/api/run-options", "PUT", { model: "other", reasoningEffort: "low" });
  expect((await rpc("/api/model/test", "POST")).ok).toBe(true);
  expect(await attached(firstTab)).toBe(true);
  expect(await attached(secondTab)).toBe(true);
  answer("first");
  await status(first.id, "completed");
  await expect.poll(() => attached(firstTab)).toBe(false);
  expect(await attached(secondTab)).toBe(true);
  expect((await rpc("/api/state")).activeRunIds).toEqual([second.id]);
  expect(await tool("second", "browser_snapshot")).toMatchObject({ tabId: secondTab });
  expect(pending.get("second")!.body.model).toBe("fixture");
  expect(pending.get("second")!.key).toBe("Bearer fixture-key");

  await rpc(`/api/runs/${first.id}/messages`, "POST", { message: "follow up", tabId: firstTab });
  // The historical first user message identifies this same-chat fixture request.
  await waiting("first");
  expect(pending.get("first")!.body.model).toBe("other");
  expect((await rpc("/api/state")).activeRunIds).toEqual([second.id, first.id]);
  answer("first");
  await status(first.id, "completed");
  expect(await attached(secondTab)).toBe(true);
  answer("second");
  await status(second.id, "completed");
  await expect.poll(() => attached(secondTab)).toBe(false);
  const messages = await ui.evaluate(() => (globalThis as any).concurrencyEvents);
  const active = new Set<string>();
  for (const { type, data } of messages) if (type === "run_status") {
    if (["running", "awaiting_approval"].includes(data.status)) active.add(data.id);
    else active.delete(data.id);
    expect([...active]).toEqual(data.activeRunIds);
    expect(data.activeRunId).toBe(data.activeRunIds.at(-1) ?? null);
  }
  expect(active.size).toBe(0);
  expect(messages.findLast((message: any) => message.type === "settings").data).toMatchObject({ activeRunIds: [first.id, second.id], activeRunId: second.id });
});

test("reserves concurrent admissions at the cap and rejects active-chat continuation", async () => {
  const first = await start("cap-first", null), second = await start("cap-second", null);
  const results = await Promise.all([
    raw("/api/runs", "POST", { prompt: "cap-third", tabId: null }),
    raw("/api/runs", "POST", { prompt: "cap-fourth", tabId: null }),
  ]);
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.find(result => !result.ok).error).toBe("Up to 3 tasks can run at once.");
  expect((await rpc("/api/state")).activeRunIds).toHaveLength(3);
  const duplicate = await raw(`/api/runs/${first.id}/messages`, "POST", { message: "again", tabId: null });
  expect(duplicate.error).toBe("Stop the current response before continuing this chat.");
  await rpc(`/api/runs/${second.id}/stop`, "POST");
  await start("replacement", null);
  expect((await rpc("/api/state")).activeRunIds).toHaveLength(3);
});

test("leases reject collisions as tool errors and allow manual work only on free tabs", async () => {
  const firstTab = await tab(), secondTab = await tab(), freeTab = await tab();
  await start("lease-owner", firstTab);
  await start("lease-other", secondTab);
  const listed = await tool("lease-other", "browser_tabs");
  expect(listed.find((tab: any) => tab.id === firstTab).busyWithAnotherTask).toBe(true);
  expect(listed.find((tab: any) => tab.id === secondTab).busyWithAnotherTask).toBe(false);
  expect((await rpc("/api/tabs")).find((tab: any) => tab.id === secondTab).busyWithAnotherTask).toBe(true);
  expect((await tool("lease-other", "browser_snapshot", { tabId: firstTab } as any)).error).toBe(`Tab ${firstTab} is owned by another task. Choose an unleased tab or navigate with newTab:true.`);
  expect((await raw("/api/browser", "POST", { action: "browser_snapshot", args: { tabId: firstTab } })).error).toContain("owned by another task");
  expect(await rpc("/api/browser", "POST", { action: "browser_snapshot", args: { tabId: freeTab } })).toMatchObject({ tabId: freeTab });
  expect(await tool("lease-other", "browser_snapshot", { tabId: freeTab } as any)).toMatchObject({ tabId: freeTab });
  expect((await tool("lease-owner", "browser_snapshot", { tabId: freeTab } as any)).error).toContain("owned by another task");
  const settings = (await rpc("/api/state")).settings;
  for (const [route, method, body] of [
    ["/api/settings", "PUT", { ...settings, apiKey: "changed" }],
    ["/api/providers", "POST", { name: "test", baseUrl: origin + "/v1" }],
    ["/api/providers", "PUT", { id: (await rpc("/api/state")).activeProviderId }],
    ["/api/providers", "DELETE", { id: (await rpc("/api/state")).activeProviderId }],
  ] as const) expect((await raw(route, method, body)).error).toBe("Stop the active tasks before changing settings.");
});

test("browser_wait leaves the browser queue free for another task", async () => {
  const first = await start("waiting-task", await tab());
  await start("working-task", await tab());
  answer("waiting-task", toolCall("browser_wait", { milliseconds: 8000 }));
  await expect.poll(async () => (await rpc(`/api/runs/${first.id}`)).events.some((event: any) => event.type === "tool_call")).toBe(true);
  expect(await tool("working-task", "browser_snapshot")).toHaveProperty("tabId");
  expect((await rpc(`/api/runs/${first.id}`)).events.some((event: any) => event.type === "tool_result")).toBe(false);
});

test("closing a leased tab stops only its owner", async () => {
  const first = await start("closed-owner", await tab());
  const secondTab = await tab(), second = await start("survivor", secondTab);
  await pages[0].close();
  await status(first.id, "stopped");
  expect((await rpc("/api/state")).activeRunIds).toEqual([second.id]);
  expect(await attached(secondTab)).toBe(true);
  expect(await tool("survivor", "browser_snapshot")).toMatchObject({ tabId: secondTab });
  answer("survivor");
  await status(second.id, "completed");
});

test("worker restart fails all interrupted tasks and clears their leases", async () => {
  const firstTab = await tab(), secondTab = await tab();
  const first = await start("restart-first", firstTab), second = await start("restart-second", secondTab);
  const session = await context.newCDPSession(ui);
  await session.send("ServiceWorker.enable");
  await session.send("ServiceWorker.stopAllWorkers");
  await expect.poll(async () => (await rpc("/api/state")).activeRunIds).toEqual([]);
  await status(first.id, "failed");
  await status(second.id, "failed");
  const tabs = await rpc("/api/tabs");
  expect(tabs.filter((tab: any) => tab.busyWithAnotherTask)).toEqual([]);
  expect(await rpc("/api/browser", "POST", { action: "browser_snapshot", args: { tabId: firstTab } })).toMatchObject({ tabId: firstTab });
});
