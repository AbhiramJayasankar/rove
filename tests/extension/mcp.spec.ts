import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import path from "node:path";

// Connected apps: an MCP client starts mcp/rove-mcp.mjs over stdio, and the extension connects to it.
// This drives the real server script and the real extension, the way Claude Code does.
let context: BrowserContext, ui: Page, server: http.Server, origin: string;
const servers: ChildProcessWithoutNullStreams[] = [];
async function rpc(route: string, method = "GET", body?: unknown): Promise<any> {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
/** A line-delimited JSON-RPC client over the server's stdio. */
function mcpClient(token: string, name: string) {
  const child = spawn(process.execPath, [path.resolve("extension/mcp/rove-mcp.mjs")], { env: { ...process.env, ROVE_TOKEN: token } });
  servers.push(child);
  let buffer = "";
  let next = 1;
  const waiting = new Map<number, (value: any) => void>();
  const notifications: any[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let line: number;
    while ((line = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, line));
      buffer = buffer.slice(line + 1);
      if (message.id !== undefined && waiting.has(message.id)) {
        waiting.get(message.id)!(message);
        waiting.delete(message.id);
      } else notifications.push(message);
    }
  });
  const request = (method: string, params?: unknown): Promise<any> => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return {
    child,
    notifications,
    request,
    async start() {
      const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return init.result;
    },
    async call(tool: string, args: Record<string, unknown> = {}) {
      return (await request("tools/call", { name: tool, arguments: args })).result;
    },
    async tools(): Promise<string[]> {
      return (await request("tools/list")).result.tools.map((tool: any) => tool.name);
    },
  };
}
const textOf = (result: any) => result.content.find((part: any) => part.type === "text")?.text ?? "";

test.beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    if (request.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      const user = String(input.messages.find((message: any) => message.role === "user")?.content);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: user.includes("Summarize something") ? "Rove did the task." : "Wrong prompt." }, finish_reason: "stop" }] }));
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>MCP ${request.url}</title><h1>Hello from ${request.url}</h1><button onclick="document.querySelector('h1').textContent='Clicked'">Press me</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: { width: 420, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  ui = await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  const { settings } = await rpc("/api/state");
  await rpc("/api/settings", "PUT", { ...settings, baseUrl: origin + "/v1", model: "fixture", apiKey: "fixture-key", approvalMode: "never", mcpEnabled: true });
});
test.afterAll(async () => {
  for (const child of servers) child.kill();
  await context?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test("Claude Code-style client: tools appear once Rove connects, and browser tools act in a grouped tab", async () => {
  const { token } = await rpc("/api/mcp");
  expect(token).toMatch(/^[0-9a-f]{36}$/);
  const client = mcpClient(token, "claude-code");
  const init = await client.start();
  expect(init.serverInfo.name).toBe("rove");
  expect(init.capabilities.tools.listChanged).toBe(true);
  await expect.poll(() => client.tools(), { timeout: 30000 }).toContain("browser_navigate");
  const names = await client.tools();
  expect(names).toEqual(expect.arrayContaining(["rove_run_task", "rove_task_status", "browser_snapshot", "browser_click"]));
  expect(names).not.toContain("ask_user");
  await expect.poll(async () => (await rpc("/api/state")).mcp).toMatchObject({ connected: true, clients: ["claude-code"] });

  // Without a tab, the app is told how to get one.
  expect(textOf(await client.call("browser_snapshot"))).toMatch(/No tab yet/);
  const opened = JSON.parse(textOf(await client.call("browser_navigate", { url: origin + "/one", newTab: true })));
  expect(opened.tabId).toBeGreaterThan(0);
  const group = await ui.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    return tab.groupId >= 0 ? (await chrome.tabGroups.get(tab.groupId)).title : null;
  }, opened.tabId);
  expect(group).toBe("Rove");
  // Later calls default to that tab.
  const snapshot = textOf(await client.call("browser_snapshot"));
  expect(snapshot).toContain("Hello from /one");
  const shot = await client.call("browser_screenshot");
  expect(shot.content.some((part: any) => part.type === "image" && part.mimeType.startsWith("image/") && part.data.length > 100)).toBe(true);
  await expect.poll(async () => (await rpc("/api/state")).mcp.activity.map((entry: any) => entry.tool)).toContain("browser_screenshot");
});

test("site rules apply: a blocked site is refused, an Ask site asks the user first", async () => {
  const { settings } = await rpc("/api/state");
  await rpc("/api/settings", "PUT", { ...settings, siteRules: [{ pattern: "127.0.0.1", action: "block" }] });
  const client = mcpClient((await rpc("/api/mcp")).token, "rules-check");
  await client.start();
  await expect.poll(() => client.tools(), { timeout: 30000 }).toContain("browser_navigate");
  const blocked = await client.call("browser_navigate", { url: origin + "/two", newTab: true });
  expect(blocked.isError).toBe(true);
  expect(textOf(blocked)).toMatch(/block 127\.0\.0\.1/);
  await rpc("/api/settings", "PUT", { ...settings, siteRules: [{ pattern: "127.0.0.1", action: "ask" }] });
  expect(textOf(await client.call("browser_navigate", { url: origin + "/two", newTab: true }))).toMatch(/ask before acting/);
  await rpc("/api/settings", "PUT", { ...settings, siteRules: [] });
});

test("rove_run_task hands a task to Rove's model and returns its answer; a wrong token never connects", async () => {
  const client = mcpClient((await rpc("/api/mcp")).token, "task-runner");
  await client.start();
  await expect.poll(() => client.tools(), { timeout: 30000 }).toContain("rove_run_task");
  const report = JSON.parse(textOf(await client.call("rove_run_task", { prompt: "Summarize something", waitSeconds: 30 })));
  expect(report).toMatchObject({ status: "completed", answer: "Rove did the task." });
  expect((await rpc("/api/state")).runs.map((run: any) => run.id)).toContain(report.runId);

  // Turning task handoff off removes the tools from the list.
  const { settings } = await rpc("/api/state");
  await rpc("/api/settings", "PUT", { ...settings, mcpRunTasks: false });
  await expect.poll(() => client.tools()).not.toContain("rove_run_task");
  await rpc("/api/settings", "PUT", { ...settings, mcpRunTasks: true });

  // A server started with the wrong token is ignored by Rove. Stop the others so it owns the port.
  for (const child of servers) child.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stranger = mcpClient("not-the-token", "stranger");
  await stranger.start();
  const status = await stranger.call("rove_status");
  expect(status.isError).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 12000));
  expect(await stranger.tools()).toEqual(["rove_status"]);
});

test("a scheduled task starts on its Chrome alarm, runs in a new tab and records how it went", async () => {
  const saved = await rpc("/api/schedules", "PUT", { name: "Alarm check", prompt: "Summarize something on a schedule", repeat: { kind: "once", at: Date.now() + 4000 } });
  expect(saved.nextAt).toBeGreaterThan(Date.now());
  await expect.poll(async () => (await rpc("/api/state")).schedules.find((item: any) => item.id === saved.id)?.lastRun?.outcome, { timeout: 60000 }).toBe("completed");
  const after = (await rpc("/api/state")).schedules.find((item: any) => item.id === saved.id);
  // A one-off turns itself off once it has run, and its chat is in the history.
  expect(after).toMatchObject({ enabled: false, lastRun: { outcome: "completed", note: "Rove did the task." } });
  expect((await rpc("/api/state")).runs.map((run: any) => run.id)).toContain(after.lastRun.runId);
  await rpc("/api/schedules", "DELETE", { id: saved.id });
});
