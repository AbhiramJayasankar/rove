import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

let context: BrowserContext, ui: Page, server: http.Server, origin: string;
let collisionTab: number;
const requests: any[] = [];
const call = (name: string, args: any) => ({ role: "assistant", content: null,
  tool_calls: [{ id: `call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function status(id: string, expected: string) {
  await expect.poll(async () => (await rpc(`/api/runs/${id}`)).status, { timeout: 30000 }).toBe(expected);
  return rpc(`/api/runs/${id}`);
}
async function newTab() {
  const tab = await ui.evaluate(url => chrome.tabs.create({ url }), origin + "/page");
  await expect.poll(async () => ui.evaluate(id => chrome.tabs.get(id), tab.id!)).toMatchObject({ status: "complete" });
  return tab.id!;
}
async function attached(tabId: number) {
  return ui.evaluate(async id => {
    // getTargets().attached also includes Playwright's browser client. This
    // command probes only the calling extension's own debugger connection.
    try { await chrome.debugger.sendCommand({ tabId: id }, "Target.getTargetInfo"); return true; }
    catch { return false; }
  }, tabId);
}
async function reply(id: string) { await rpc(`/api/runs/${id}/reply`, "POST", { message: "Continue" }); }

test.beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: ["fixture:free", "next:free"].map(id => ({ id, context_length: 131072, supported_parameters: ["tools", "reasoning_effort"] })) }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      requests.push(input);
      const user = String(input.messages.find((message: any) => message.role === "user")?.content);
      const tools = input.messages.filter((message: any) => message.role === "tool");
      let message: any;
      if (user.includes("collision")) {
        const script = [call("browser_snapshot", {}), call("browser_tabs", {}),
          call("browser_snapshot", { tabId: collisionTab }), call("ask_user", { question: "Resume collision task?" }), call("browser_snapshot", {})];
        message = script[tools.length];
      } else if (user.includes("navigate")) {
        message = [call("browser_navigate", { url: origin + "/page", newTab: true }), call("ask_user", { question: "Resume new tab?" })][tools.length];
      } else if (user.includes("hold")) {
        message = tools.length ? undefined : call("ask_user", { question: "Resume held task?" });
      } else if (user.includes("rove_connection_check")) {
        // /api/model/test validates a harmless echo tool without browser actions.
        const tool = input.tools[0].function;
        message = call(tool.name, { status: "ok" });
      } else {
        message = [call("browser_snapshot", {}), call("ask_user", { question: "Resume first task?" })][tools.length];
      }
      message ??= { role: "assistant", content: "Finished independently." };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Concurrent fixture</title><h1>Task page</h1><button>Action</button>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
});
test.beforeEach(async () => {
  await rpc("/api/settings", "PUT", { ...DEFAULT_SETTINGS, baseUrl: origin + "/v1", model: "fixture:free", approvalMode: "never", apiKey: "fixture-key" });
  await ui.evaluate(() => {
    const port = chrome.runtime.connect({ name: "rove-events" });
    (window as any).updates = [];
    (window as any).testPort = port;
    port.onMessage.addListener(message => (window as any).updates.push(message));
  });
});
test.afterEach(async () => {
  for (const id of (await rpc("/api/state")).activeRunIds) await rpc(`/api/runs/${id}/stop`, "POST");
  await expect.poll(async () => (await rpc("/api/state")).activeRunIds).toEqual([]);
  await ui.evaluate(() => (window as any).testPort.disconnect());
});
test.afterAll(async () => { await context?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });

test("two live tasks isolate collisions, manual access and terminal debugger release", async () => {
  const firstTab = await newTab(), secondTab = await newTab(), manualTab = await newTab();
  collisionTab = firstTab;
  const [first, second] = await Promise.all([
    rpc("/api/runs", "POST", { prompt: "first", tabId: firstTab }),
    rpc("/api/runs", "POST", { prompt: "collision", tabId: secondTab }),
  ]);
  await status(first.id, "awaiting_approval");
  const paused = await status(second.id, "awaiting_approval");
  expect(paused.events.find((event: any) => event.type === "tool_result" && event.data.error)?.data.error).toContain("owned by another task");
  expect(paused.events.find((event: any) => event.type === "tool_result" && event.data.name === "browser_tabs").data.result)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: firstTab, busyWithAnotherTask: true }), expect.objectContaining({ id: secondTab, busyWithAnotherTask: false })]));
  await expect(rpc("/api/browser", "POST", { action: "browser_snapshot", args: { tabId: firstTab } })).rejects.toThrow("owned by another task");
  await expect(rpc("/api/runs", "POST", { prompt: "hold collision admission", tabId: secondTab })).rejects.toThrow("owned by another task");
  expect(await attached(firstTab)).toBe(true);
  expect(await attached(secondTab)).toBe(true);
  expect((await rpc("/api/model/test", "POST", {})).ok).toBe(true);
  expect(await attached(firstTab)).toBe(true);
  expect(await attached(secondTab)).toBe(true);
  expect((await rpc("/api/browser", "POST", { action: "browser_snapshot", args: { tabId: manualTab } })).tabId).toBe(manualTab);
  await reply(first.id);
  await status(first.id, "completed");
  await expect.poll(() => attached(firstTab)).toBe(false);
  expect(await attached(secondTab)).toBe(true);
  expect((await rpc("/api/runs/" + second.id)).status).toBe("awaiting_approval");
  expect((await rpc("/api/state")).activeRunIds).toEqual([second.id]);
  expect((await rpc("/api/state")).activeRunId).toBe(second.id);
  await reply(second.id);
  const completed = await status(second.id, "completed");
  expect(completed.events.filter((event: any) => event.type === "tool_result" && event.data.name === "browser_snapshot").at(-1).data.result.tabId).toBe(secondTab);
  await expect.poll(() => attached(secondTab)).toBe(false);
  const updates = await ui.evaluate(() => (window as any).updates);
  const finish = updates.find((message: any) => message.type === "run_status" && message.data.id === first.id && message.data.status === "completed");
  expect(finish.data).toMatchObject({ activeRunIds: [second.id], activeRunId: second.id });
});

test("admission races respect the cap and settings/model changes use per-run snapshots", async () => {
  const first = await rpc("/api/runs", "POST", { prompt: "hold first", tabId: null });
  const second = await rpc("/api/runs", "POST", { prompt: "hold second", tabId: null });
  await status(first.id, "awaiting_approval");
  await status(second.id, "awaiting_approval");
  await expect(rpc(`/api/runs/${first.id}/messages`, "POST", { message: "again", editMessageId: 0, tabId: null })).rejects.toThrow("current response");
  for (const [route, method, body] of [
    ["/api/settings", "PUT", DEFAULT_SETTINGS], ["/api/providers", "POST", { name: "blocked", baseUrl: origin }],
    ["/api/providers", "PUT", { id: "bad" }], ["/api/providers", "DELETE", { id: "bad" }],
  ] as const) await expect(rpc(route, method, body)).rejects.toThrow("Stop the active tasks before changing settings.");
  const selected = await rpc("/api/run-options", "PUT", { model: "next:free", reasoningEffort: "high" });
  expect(selected.activeRunIds).toEqual([first.id, second.id]);
  const raced = await Promise.allSettled(["third", "fourth"].map(name => rpc("/api/runs", "POST", { prompt: "hold " + name, tabId: null })));
  expect(raced.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(String((raced.find(result => result.status === "rejected") as PromiseRejectedResult).reason)).toContain("Up to 3 tasks can run at once.");
  const third = (raced.find(result => result.status === "fulfilled") as PromiseFulfilledResult<any>).value;
  const thirdRecord = await status(third.id, "awaiting_approval");
  expect((await rpc(`/api/runs/${first.id}`)).events.find((event: any) => event.type === "run_configuration").data.settings.model).toBe("fixture:free");
  expect(thirdRecord.events.find((event: any) => event.type === "run_configuration").data.settings.model).toBe("next:free");
  await rpc("/api/approval-mode", "PUT", { mode: "always" });
  const changed = await rpc("/api/approval-mode", "PUT", { mode: "never", runId: first.id });
  expect(changed).toMatchObject({ runId: first.id, approvalMode: "never", settings: { approvalMode: "always" } });
  expect((await rpc(`/api/runs/${second.id}`)).events.some((event: any) => event.type === "approval_mode_changed")).toBe(false);
});

test("navigation leases new tabs and first explicit use leases an existing tab", async () => {
  const first = await rpc("/api/runs", "POST", { prompt: "navigate", tabId: null });
  const paused = await status(first.id, "awaiting_approval");
  const tabId = paused.events.find((event: any) => event.type === "tool_result" && event.data.name === "browser_navigate").data.result.tabId;
  await expect(rpc("/api/browser", "POST", { action: "browser_screenshot", args: { tabId } })).rejects.toThrow("owned by another task");
  await rpc(`/api/runs/${first.id}/stop`, "POST");
  await expect.poll(() => attached(tabId)).toBe(false);
  // Start in New Tab mode, then explicitly address an existing unleased tab.
  collisionTab = tabId;
  const second = await rpc("/api/runs", "POST", { prompt: "collision explicit", tabId: null });
  const owned = await status(second.id, "awaiting_approval");
  expect(owned.events.find((event: any) => event.type === "tool_result" && event.data.name === "browser_snapshot" && !event.data.error).data.result.tabId).toBe(tabId);
  await expect(rpc("/api/browser", "POST", { action: "browser_snapshot", args: { tabId } })).rejects.toThrow("owned by another task");
});

test("closing a leased tab stops only its task and restart recovers every remaining run", async () => {
  const firstTab = await newTab(), secondTab = await newTab();
  const first = await rpc("/api/runs", "POST", { prompt: "hold close", tabId: firstTab });
  const second = await rpc("/api/runs", "POST", { prompt: "hold survive", tabId: secondTab });
  await status(first.id, "awaiting_approval");
  await status(second.id, "awaiting_approval");
  await ui.evaluate(id => chrome.tabs.remove(id), firstTab);
  await status(first.id, "stopped");
  expect((await rpc("/api/state")).activeRunIds).toEqual([second.id]);
  expect(await attached(secondTab)).toBe(true);
  const third = await rpc("/api/runs", "POST", { prompt: "hold recover", tabId: null });
  await status(third.id, "awaiting_approval");
  const session = await context.newCDPSession(ui);
  await session.send("ServiceWorker.enable");
  await session.send("ServiceWorker.stopAllWorkers");
  await expect.poll(async () => (await rpc("/api/state")).activeRunIds).toEqual([]);
  await status(second.id, "failed");
  await status(third.id, "failed");
  await expect.poll(() => attached(secondTab)).toBe(false);
  expect((await rpc("/api/browser", "POST", { action: "browser_snapshot", args: { tabId: secondTab } })).tabId).toBe(secondTab);
  await session.detach();
});
