import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

let context: BrowserContext, fixture: http.Server, ui: Page, target: Page;
let origin: string,
  requests = 0,
  cancelled = false;
const errors: string[] = [];
async function api<T = any>(
  route: string,
  method = "GET",
  body?: any,
): Promise<T> {
  const response = await ui.evaluate(
    async ({ route, method, body }) =>
      chrome.runtime.sendMessage({
        type: "rove-api",
        path: route,
        method,
        body,
      }),
    { route, method, body },
  );
  if (!response?.ok) throw new Error(response?.error || "No response");
  return response.data;
}
async function configure(overrides: any = {}) {
  return api("/api/settings", "PUT", {
    ...DEFAULT_SETTINGS,
    baseUrl: origin + "/v1",
    model: "fixture:free",
    apiKey: "local-test-secret",
    ...overrides,
  });
}
async function targetId() {
  return (await api("/api/tabs")).find((t: any) => t.url === origin + "/page")
    .id;
}
async function finished(id: string) {
  await expect
    .poll(async () => (await api("/api/runs/" + id)).status, { timeout: 30000 })
    .toBe("completed");
  return api("/api/runs/" + id);
}
test.beforeAll(async () => {
  fixture = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            {
              id: "fixture:free",
              name: "Native fixture",
              context_length: 1048576,
              supported_parameters: [
                "tools",
                "reasoning_effort",
                "max_completion_tokens",
              ],
              max_output_tokens: 8192,
              architecture: { input_modalities: ["text", "image"] },
            },
            { id: "paid-fixture", context_length: 32768 },
          ],
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      requests++;
      const user = String(
        input.messages.find((m: any) => m.role === "user")?.content,
      );
      if (user.includes("Rejected fixture")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Fixture provider rejected the request.",
              code: "content_policy",
            },
          }),
        );
        return;
      }
      if (user.includes("Slow model")) {
        // Exceeds Chrome's normal fetch/idle deadline while all extension UI is closed.
        const timer = setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "Slow response completed.",
                  },
                  finish_reason: "stop",
                },
              ],
            }),
          );
        }, 35000);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      if (user.includes("Stop stream")) {
        cancelled = false;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    reasoning_content: "Inspecting the page carefully.",
                  },
                },
              ],
            }) +
            "\n\n",
        );
        const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 60000);
        res.on("close", () => {
          cancelled = true;
          clearTimeout(timer);
        });
        return;
      }
      const results = input.messages.filter((m: any) => m.role === "tool");
      const call = (name: string, args: any) => ({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_" + requests,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      let message: any;
      if (user.includes("Ask fixture"))
        message = results.length
          ? { role: "assistant", content: "Question answered." }
          : call("ask_user", { question: "Which value?" });
      else if (user.includes("Approval fixture"))
        message = results.length
          ? { role: "assistant", content: "Approved." }
          : call("browser_snapshot", {});
      else if (!results.length) message = call("browser_snapshot", {});
      else if (results.length === 1) {
        const s = JSON.parse(results[0].content);
        message = call("browser_type", {
          ref: s.elements.find((e: any) => e.name === "Your name").ref,
          text: "Native Rove",
          clear: true,
        });
      } else if (results.length === 2) message = call("browser_snapshot", {});
      else if (results.length === 3) {
        const s = JSON.parse(results[2].content);
        message = call("browser_click", {
          ref: s.elements.find((e: any) => e.name === "Save greeting").ref,
        });
      } else if (results.length === 4) message = call("browser_snapshot", {});
      else
        message = {
          role: "assistant",
          content: "Verified the greeting for Native Rove.",
        };
      message.reasoning_content = "Read live elements and verify the outcome.";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message,
              finish_reason: message.tool_calls ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 500, completion_tokens: 50 },
        }),
      );
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      "<!doctype html><title>Native extension fixture</title><style>body{font:20px system-ui;padding:40px}input,button{font:inherit;padding:12px}</style><h1>Native extension fixture</h1><label>Your name <input aria-label=\"Your name\"></label><button onclick=\"document.querySelector('#result').textContent='Hello, '+document.querySelector('input').value\">Save greeting</button><p id=\"result\">Waiting</p>",
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (fixture.address() as any).port;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 960 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  target = await context.newPage();
  await target.goto(origin + "/page");
  ui = await context.newPage();
  ui.on("pageerror", (error) => errors.push(error.message));
  await ui.goto(`chrome-extension://${extensionId}/index.html?view=tab`);
  await expect(
    ui.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
});
test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve) => fixture?.close(() => resolve()));
});
test.afterEach(async () => {
  const s = await api("/api/state");
  if (s.activeRunId) await api("/api/runs/" + s.activeRunId + "/stop", "POST");
});

test("standalone model loop controls Chrome, saves trace and fits a narrow panel", async () => {
  await configure({ vision: true });
  const catalogue = await api("/api/models");
  expect(catalogue.modelInfo.contextWindow).toBe(1048576);
  expect(catalogue.modelInfo.maxOutputTokens).toBe(8192);
  const run = await api("/api/runs", "POST", {
    prompt: "Save my greeting",
    tabId: await targetId(),
  });
  const result = await finished(run.id);
  await expect(target.locator("#result")).toHaveText("Hello, Native Rove");
  expect(result.events.some((e: any) => e.type === "screenshot")).toBe(true);
  expect(
    result.events.find((e: any) => e.type === "model_response").data.message
      .reasoning_content,
  ).toContain("Read live elements");
  expect(JSON.stringify(result)).not.toContain("local-test-secret");
  await ui.reload();
  await expect(
    ui.getByText("Verified the greeting for Native Rove.", { exact: true }),
  ).toBeVisible();
  await fs.mkdir("test-results/native", { recursive: true });
  await ui.screenshot({
    path: "test-results/native/desktop.png",
    fullPage: true,
  });
  await ui.setViewportSize({ width: 400, height: 850 });
  await expect
    .poll(() =>
      ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await ui.screenshot({
    path: "test-results/native/panel.png",
    fullPage: true,
  });
  await ui.setViewportSize({ width: 1440, height: 960 });
  expect(errors).toEqual([]);
});
test("stop aborts streaming and prevents future tools", async () => {
  await configure();
  const run = await api("/api/runs", "POST", {
    prompt: "Stop stream",
    tabId: await targetId(),
  });
  await expect
    .poll(async () => JSON.stringify((await api("/api/runs/" + run.id)).events))
    .toContain("Inspecting th");
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await ui.getByRole("button", { name: "Back to chat", exact: true }).click();
  await ui.getByRole("button", { name: "Stop generation", exact: true }).click();
  await expect.poll(() => cancelled).toBe(true);
  const stopped = await api("/api/runs/" + run.id);
  expect(stopped.status).toBe("stopped");
  expect(
    stopped.events.filter((e: any) => e.type === "tool_call"),
  ).toHaveLength(0);
  expect(target.isClosed()).toBe(false);
});
test("approvals and questions work inside the extension", async () => {
  await configure({ approvalMode: "always" });
  let run = await api("/api/runs", "POST", {
    prompt: "Approval fixture",
    tabId: await targetId(),
  });
  await expect
    .poll(async () => (await api("/api/runs/" + run.id)).status)
    .toBe("awaiting_approval");
  await api("/api/approval-mode", "PUT", { mode: "never", runId: run.id });
  await finished(run.id);
  run = await api("/api/runs", "POST", {
    prompt: "Ask fixture",
    tabId: await targetId(),
  });
  await expect
    .poll(async () =>
      (await api("/api/runs/" + run.id)).events.some(
        (e: any) => e.type === "user_question",
      ),
    )
    .toBe(true);
  const inlineQuestion = ui
    .locator(".execution-step")
    .getByRole("region", { name: "Reply required" });
  await expect(inlineQuestion).toBeVisible();
  await expect(inlineQuestion).toContainText("Which value?");
  await ui.setViewportSize({ width: 400, height: 850 });
  await ui.screenshot({
    path: "test-results/question-inline.png",
    fullPage: true,
  });
  await inlineQuestion
    .getByRole("textbox", { name: "Reply to Rove" })
    .fill("Use hello");
  await inlineQuestion.getByRole("button", { name: "Send answer" }).click();
  await finished(run.id);
  await expect(ui.locator(".question-answer")).toHaveText("Use hello");
  await ui.screenshot({
    path: "test-results/question-answered.png",
    fullPage: true,
  });
  await expect(
    ui.locator(".user-message").filter({ hasText: "Use hello" }),
  ).toHaveCount(0);
  await ui.reload();
  await ui.locator(".execution-summary").click();
  await expect(ui.locator(".question-answer")).toHaveText("Use hello");
});
test("worker restart preserves history and persistent key without replaying a task", async () => {
  await configure({ approvalMode: "always" });
  const run = await api("/api/runs", "POST", {
    prompt: "Approval fixture restart",
    tabId: await targetId(),
  });
  await expect
    .poll(async () => (await api("/api/runs/" + run.id)).status)
    .toBe("awaiting_approval");
  const before = requests;
  const session = await context.newCDPSession(ui);
  await session.send("ServiceWorker.enable");
  await session.send("ServiceWorker.stopAllWorkers");
  await expect
    .poll(async () => (await api("/api/state")).activeRunId, { timeout: 15000 })
    .toBeNull();
  expect((await api("/api/state")).hasApiKey).toBe(true);
  const recovered = await api("/api/runs/" + run.id);
  expect(recovered.status).toBe("failed");
  expect(recovered.events.at(-1).data.message).toContain("Chrome interrupted");
  expect(requests).toBe(before);
});
test("lost debugger sessions stop the task and a new task reconnects without replay", async () => {
  await configure({ approvalMode: "always" });
  const id = await targetId();
  const run = await api("/api/runs", "POST", {
    prompt: "Approval fixture disconnect",
    tabId: id,
  });
  await expect
    .poll(async () => (await api("/api/runs/" + run.id)).status)
    .toBe("awaiting_approval");
  // API detach does not guarantee an onDetach event. Exercise a stale worker cache.
  await ui.evaluate((tabId) => chrome.debugger.detach({ tabId }), id);
  const capture = await ui.evaluate(
    (tabId) =>
      chrome.runtime.sendMessage({
        type: "rove-api",
        path: "/api/browser",
        method: "POST",
        body: { action: "browser_screenshot", args: { tabId } },
      }),
    id,
  );
  if (!capture.ok) {
    expect(capture.error).toContain("owned by another task");
  }
  // Manual access cannot probe an active lease. Let its owning run discover the
  // stale client at the approved dispatch instead; no action may be replayed.
  if ((await api("/api/runs/" + run.id)).status === "awaiting_approval")
    await api("/api/approval-mode", "PUT", { mode: "never", runId: run.id });
  await expect
    .poll(async () => (await api("/api/runs/" + run.id)).status)
    .toBe("stopped");
  const stopped = await api("/api/runs/" + run.id);
  expect(stopped.events.at(-1).data.message).toContain(
    "No browser action was replayed",
  );
  expect(
    stopped.events.some((event: any) => event.type === "tool_result"),
  ).toBe(false);
  await api("/api/approval-mode", "PUT", { mode: "never" });
  const next = await api("/api/runs", "POST", {
    prompt: "Approval fixture reconnect",
    tabId: id,
  });
  await finished(next.id);
  expect(
    (
      await api("/api/browser", "POST", {
        action: "browser_screenshot",
        args: { tabId: id },
      })
    ).dataUrl,
  ).toMatch(/^data:image\/jpeg/);
});
test("an extension-owned client without worker state is reset before a new task", async () => {
  await configure({ approvalMode: "never" });
  const id = await targetId();
  await ui.evaluate(async (tabId) => {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
  }, id);
  const run = await api("/api/runs", "POST", {
    prompt: "Approval fixture orphaned client",
    tabId: id,
  });
  await finished(run.id);
  expect((await api("/api/state")).activeRunId).toBeNull();
});

test("editing immediately after provider failure safely reconnects and replaces failed history", async () => {
  await configure({ approvalMode: "never" });
  const tabId = await targetId();
  const original = await api("/api/runs", "POST", {
    prompt: "Rejected fixture",
    tabId,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect
      .poll(async () => (await api("/api/runs/" + original.id)).status)
      .toBe("failed");
    const edited = await api("/api/runs/" + original.id + "/messages", "POST", {
      message: "Approval fixture edit after rejection",
      editMessageId: 0,
      tabId,
    });
    expect(edited.id).toBe(original.id);
    const completed = await finished(original.id);
    expect(completed.events.some((event: any) => event.type === "error")).toBe(
      false,
    );
    if (attempt < 2)
      await api("/api/runs/" + original.id + "/messages", "POST", {
        message: "Rejected fixture",
        editMessageId: 0,
        tabId,
      });
  }
  const record = await api("/api/runs/" + original.id);
  expect(record.revision).toBe(5);
  expect(record.prompt).toBe("Approval fixture edit after rejection");
});

test("a discarded background tab is restored in place before edit-and-run initializes its debugger", async () => {
  await configure({ approvalMode: "never" });
  const tabId = await targetId();
  const original = await api("/api/runs", "POST", {
    prompt: "Approval fixture before discard",
    tabId,
  });
  await finished(original.id);
  // Simulate Chrome Memory Saver after the earlier response released its client.
  await expect
    .poll(async () =>
      ui.evaluate(async (id) => {
        try {
          await chrome.debugger.sendCommand(
            { tabId: id },
            "Target.getTargetInfo",
          );
          return true;
        } catch {
          return false;
        }
      }, tabId),
    )
    .toBe(false);
  await ui.bringToFront();
  const restoredId = await ui.evaluate(async (id) => {
    const discarded = await chrome.tabs.discard(id);
    return discarded!.id!;
  }, tabId);
  const edited = await api("/api/runs/" + original.id + "/messages", "POST", {
    message: "Approval fixture after discard",
    editMessageId: 0,
    tabId: restoredId,
  });
  await finished(edited.id);
  const tab = await ui.evaluate(async (id) => chrome.tabs.get(id), restoredId);
  expect(tab.discarded).toBe(false);
  // Background mode restores the tab in place; it does not take the user's view away from Rove's page.
  expect(tab.active).toBe(false);
});

test("a completed chat continues from its journal after a worker restart", async () => {
  await configure();
  const run = await api("/api/runs", "POST", {
    prompt: "Approval fixture conversation",
    tabId: await targetId(),
  });
  const original = await finished(run.id);
  const oldCalls = original.events.filter(
    (event: any) => event.type === "tool_call",
  ).length;
  const session = await context.newCDPSession(ui);
  await session.send("ServiceWorker.enable");
  await session.send("ServiceWorker.stopAllWorkers");
  await expect
    .poll(async () => (await api("/api/state")).activeRunId)
    .toBeNull();
  const resumed = await api("/api/runs/" + run.id + "/messages", "POST", {
    message: "What did the previous page show?",
    tabId: await targetId(),
  });
  expect(resumed.id).toBe(run.id);
  const complete = await finished(run.id);
  expect(
    complete.events.filter((event: any) => event.type === "tool_call"),
  ).toHaveLength(oldCalls);
  const request = complete.events
    .filter((event: any) => event.type === "model_request")
    .at(-1);
  expect(
    request.data.messages.some(
      (message: any) =>
        message.role === "assistant" && message.content === "Approved.",
    ),
  ).toBe(true);
  expect(request.data.messages.at(-1).content).toContain(
    "What did the previous page show?",
  );
  expect(request.data.step).toBeGreaterThan(
    original.events
      .filter((event: any) => event.type === "model_request")
      .at(-1).data.step,
  );
});

test("active task survives a slow model with every workbench page closed", async () => {
  await configure();
  const run = await api("/api/runs", "POST", {
    prompt: "Slow model",
    tabId: await targetId(),
  });
  const workbenchUrl = ui.url();
  await ui.close();
  await new Promise((resolve) => setTimeout(resolve, 36500));
  ui = await context.newPage();
  await ui.goto(workbenchUrl);
  const saved = await api("/api/runs/" + run.id);
  expect(saved.status).toBe("completed");
  expect(
    saved.events.some(
      (event: any) =>
        event.type === "assistant" &&
        event.data.content === "Slow response completed.",
    ),
  ).toBe(true);
});
