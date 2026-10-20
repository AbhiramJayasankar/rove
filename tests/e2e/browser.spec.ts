import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import WebSocket from "ws";

let context: BrowserContext;
let fixture: http.Server;
let fixtureUrl = "";
let completeRequests = 0;

test.beforeAll(async () => {
  fixture = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/v1/chat/completions")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      completeRequests++;
      const results = input.messages.filter((m: any) => m.role === "tool");
      const call = (name: string, args: any) => ({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${completeRequests}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      let message: any;
      if (
        input.tools?.some(
          (t: any) => t.function.name === "relay_connection_check",
        )
      )
        message = call("relay_connection_check", { status: "ok" });
      else if (
        String(
          input.messages.find((m: any) => m.role === "user")?.content,
        ).includes("Auto approval fixture")
      )
        message =
          results.length === 0
            ? call("browser_snapshot", {})
            : results.length === 1
              ? call("browser_snapshot", {})
              : { role: "assistant", content: "Automatic approval verified." };
      else if (
        String(
          input.messages.find((m: any) => m.role === "user")?.content,
        ).includes("Ask user fixture")
      )
        message =
          results.length === 0
            ? call("ask_user", { question: "Which greeting should I use?" })
            : {
                role: "assistant",
                content:
                  "Your answer was received and the question flow is verified.",
              };
      else if (results.length === 0) message = call("browser_snapshot", {});
      else if (results.length === 1) {
        const snapshot = JSON.parse(results[0].content);
        const elements = snapshot.elements || snapshot.result?.elements || [];
        const input = elements.find((e: any) => e.name === "Your name");
        message = call("browser_type", {
          ref: input?.ref || "missing",
          text: "Relay verified",
          clear: true,
        });
      } else if (results.length === 2) message = call("browser_snapshot", {});
      else if (results.length === 3) {
        const snapshot = JSON.parse(results[2].content);
        const button = (
          snapshot.elements ||
          snapshot.result?.elements ||
          []
        ).find((e: any) => e.name === "Save greeting");
        message = call("browser_click", { ref: button?.ref || "missing" });
      } else if (results.length === 4) message = call("browser_snapshot", {});
      else
        message = {
          role: "assistant",
          content: "Verified: the page saved the greeting for Relay verified.",
        };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message,
              finish_reason: message.tool_calls ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 40 },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    if (req.url === "/long") {
      res.end(
        "<!doctype html><title>Long page</title><p>" +
          "Long article text. ".repeat(3000) +
          "</p>" +
          Array.from(
            { length: 180 },
            (_, i) =>
              `<button onclick="document.body.dataset.clicked='${i}'">Action ${i}</button>`,
          ).join(""),
      );
      return;
    }
    if (req.url === "/advanced") {
      const port = (fixture.address() as any).port;
      res.end(
        `<!doctype html><title>Advanced browser controls</title><style>body{font:18px system-ui;padding:30px}button{padding:15px;margin:10px}#drag{display:inline-block;width:100px;height:60px;background:lightblue}#drop{display:inline-block;width:100px;height:60px;margin-left:100px;background:lightgreen}</style><button aria-label="Reveal hover" onmouseenter="document.querySelector('#hover-state').textContent='Hovered'">Reveal hover</button><p id="hover-state">Waiting</p><div role="button" aria-label="Drag source" id="drag" onmousedown="window.dragging=true">Drag source</div><div role="button" aria-label="Drop target" id="drop" onmouseup="if(window.dragging)document.querySelector('#drag-state').textContent='Dropped'">Drop target</div><p id="drag-state">Waiting</p><button onclick="document.querySelector('#dialog-state').textContent=confirm('Confirm test action?')?'Accepted':'Dismissed'">Open confirmation</button><p id="dialog-state">Waiting</p><iframe title="Cross origin frame" src="http://localhost:${port}/frame" style="display:block;margin:24px 0;height:140px"></iframe>`,
      );
      return;
    }
    if (req.url === "/frame") {
      res.end(
        '<!doctype html><label>Frame field <input aria-label="Frame field"></label><button onclick="document.body.dataset.clicked=\'yes\'">Frame button</button>',
      );
      return;
    }
    res.end(
      `<!doctype html><html><head><title>Relay test workspace</title></head><body style="font:18px system-ui;padding:40px;background:#eef3fa"><h1>Browser connection verified</h1><p>A real page controlled by the Relay extension.</p><label>Your name <input aria-label="Your name"></label><button onclick="document.querySelector('#result').textContent='Hello, '+document.querySelector('input').value">Save greeting</button><p id="result" role="status">Waiting for a greeting</p><select aria-label="Priority"><option value="normal">Normal</option><option value="high">High</option></select><iframe src="/frame" title="Child frame" style="display:block;margin-top:24px"></iframe><a href="/next">Next page</a></body></html>`,
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as any).port}`;
  const extension = path.resolve("extension");
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 960 },
    args: [
      "--site-per-process",
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
});
test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve) => fixture?.close(() => resolve()));
});
test.afterEach(async ({ request }) => {
  const state = await (await request.get("/api/state")).json();
  if (state.activeRunId)
    await request.post(`/api/runs/${state.activeRunId}/stop`, { data: {} });
  await request.put("/api/settings", {
    data: { ...DEFAULT_SETTINGS, apiKey: "" },
  });
});

test("real extension controls DOM, frames, screenshot, approvals and the full model loop", async ({
  request,
}) => {
  const pairing = await (await request.get("/api/pairing")).json();
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator("#server").fill("http://127.0.0.1:4799");
  await popup.locator("#token").fill(pairing.token);
  await popup.locator("#connect").click();
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/state")).json()).bridge.connected,
    )
    .toBe(true);
  const target = await context.newPage();
  await target.goto(fixtureUrl);
  await expect
    .poll(async () =>
      (await (await request.get("/api/state")).json()).bridge.tabs.some(
        (t: any) => t.url === fixtureUrl + "/",
      ),
    )
    .toBe(true);
  const tabs = (await (await request.get("/api/state")).json()).bridge.tabs;
  const tabId = tabs.find((t: any) => t.url === fixtureUrl + "/").id;
  const action = async (name: string, args: any = {}) => {
    const response = await request.post("/api/browser", {
      data: { action: name, args: { tabId, ...args } },
    });
    const result = await response.json();
    expect(response.ok(), JSON.stringify(result)).toBe(true);
    return result;
  };
  const snapshot = await action("browser_snapshot");
  expect(snapshot.text).toContain("Browser connection verified");
  expect(snapshot.elements.some((e: any) => e.name === "Your name")).toBe(true);
  const frameId = snapshot.frames.find((f: any) => f.url.endsWith("/frame")).id;
  const frameSnapshot = await action("browser_snapshot", { frameId });
  const frameField = frameSnapshot.elements.find(
    (e: any) => e.name === "Frame field",
  );
  await action("browser_type", {
    frameId,
    ref: frameField.ref,
    text: "inside frame",
  });
  await expect(
    target.frameLocator("iframe").getByLabel("Frame field"),
  ).toHaveValue("inside frame");
  const selected = await action("browser_snapshot");
  await action("browser_select", {
    ref: selected.elements.find((e: any) => e.name === "Priority").ref,
    values: ["high"],
  });
  await expect(target.getByLabel("Priority")).toHaveValue("high");
  const screenshot = await action("browser_screenshot");
  expect(screenshot.dataUrl).toMatch(/^data:image/);
  const long = await action("browser_navigate", { url: `${fixtureUrl}/long` });
  expect(long.hasMoreText).toBe(true);
  expect(long.totalElements).toBe(180);
  const nextSlice = await action("browser_snapshot", {
    textOffset: 6000,
    textLimit: 100,
    elementOffset: 60,
    elementLimit: 5,
  });
  expect(nextSlice.text).toHaveLength(100);
  expect(nextSlice.elements).toHaveLength(5);
  expect(nextSlice.elements[0].name).toBe("Action 60");
  await action("browser_click", { ref: nextSlice.elements[0].ref });
  await expect(target.locator("body")).toHaveAttribute("data-clicked", "60");
  // Extra native browser operations and a cross-site out-of-process frame.
  await action("browser_navigate", { url: `${fixtureUrl}/advanced` });
  let advanced = await action("browser_snapshot");
  await action("browser_hover", {
    ref: advanced.elements.find((e: any) => e.name === "Reveal hover").ref,
  });
  await expect(target.locator("#hover-state")).toHaveText("Hovered");
  await action("browser_drag", {
    fromRef: advanced.elements.find((e: any) => e.name === "Drag source").ref,
    toRef: advanced.elements.find((e: any) => e.name === "Drop target").ref,
  });
  await expect(target.locator("#drag-state")).toHaveText("Dropped");
  const crossFrame = advanced.frames.find((f: any) =>
    f.url.includes("localhost:"),
  );
  expect(crossFrame).toBeTruthy();
  const crossSnapshot = await action("browser_snapshot", {
    frameId: crossFrame.id,
  });
  await action("browser_click", {
    frameId: crossFrame.id,
    ref: crossSnapshot.elements.find((e: any) => e.name === "Frame button").ref,
  });
  await expect(target.frameLocator("iframe").locator("body")).toHaveAttribute(
    "data-clicked",
    "yes",
  );
  advanced = await action("browser_snapshot");
  // Do not let Playwright auto-dismiss the dialog while testing Relay's handler.
  target.on("dialog", () => {});
  const dialogCall = await request.post("/api/browser", {
    data: {
      action: "browser_click",
      args: {
        tabId,
        ref: advanced.elements.find((e: any) => e.name === "Open confirmation")
          .ref,
      },
    },
  });
  if (!dialogCall.ok())
    expect((await dialogCall.json()).error).toContain("dialog");
  await action("browser_dialog", { accept: true });
  await expect(target.locator("#dialog-state")).toHaveText("Accepted");
  const downloads = await request.post("/api/browser", {
    data: { action: "browser_downloads", args: { action: "list" } },
  });
  expect(downloads.ok(), await downloads.text()).toBe(true);
  expect(Array.isArray(await downloads.json())).toBe(true);
  await action("browser_navigate", { url: fixtureUrl });
  const settings = {
    ...DEFAULT_SETTINGS,
    baseUrl: `${fixtureUrl}/v1`,
    model: "deterministic-integration-fixture",
    approvalMode: "always",
  };
  expect((await request.put("/api/settings", { data: settings })).ok()).toBe(
    true,
  );
  const connectionTest = await request.post("/api/model/test", { data: {} });
  expect(connectionTest.ok(), await connectionTest.text()).toBe(true);
  const run = await (
    await request.post("/api/runs", {
      data: {
        prompt:
          "Fill my name as Relay verified, save the greeting, and verify it.",
        tabId,
      },
    })
  ).json();
  expect(run.id).toBeTruthy();
  for (let i = 0; i < 300; i++) {
    const record = await (await request.get(`/api/runs/${run.id}`)).json();
    if (record.status === "awaiting_approval") {
      const approval = record.events
        .filter((e: any) => e.type === "approval_required")
        .at(-1);
      await request.post(`/api/runs/${run.id}/approval`, {
        data: { approvalId: approval.data.id, approved: true },
      });
    }
    if (["completed", "failed", "stopped"].includes(record.status)) {
      expect(
        record.status,
        JSON.stringify(
          record.events.filter((e: any) => e.type === "error" || e.data?.error),
        ),
      ).toBe("completed");
      expect(record.events.some((e: any) => e.type === "model_request")).toBe(
        true,
      );
      expect(record.events.some((e: any) => e.type === "tool_result")).toBe(
        true,
      );
      expect(
        record.events.some((e: any) => e.type === "approval_required"),
      ).toBe(true);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await expect(target.locator("#result")).toHaveText("Hello, Relay verified");
  expect(completeRequests).toBeGreaterThanOrEqual(6);
  const ui = await context.newPage();
  await ui.goto("http://127.0.0.1:4799");
  await expect(
    ui.getByRole("button", { name: "New task", exact: true }),
  ).toBeVisible();
  await expect(ui.locator(".browser-viewport img")).toBeVisible();
  await ui.screenshot({
    path: "test-results/relay-desktop.png",
    fullPage: true,
  });
  await ui
    .getByLabel("Task prompt")
    .fill("Ask user fixture: ask me which greeting to use.");
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(
    ui.getByText("Relay needs your input", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await request.post("/api/browser", {
        data: { action: "browser_snapshot", args: { tabId } },
      })
    ).status(),
  ).toBe(409);
  await expect(
    ui.getByRole("button", { name: "Inspect page", exact: true }),
  ).toBeDisabled();
  await ui.getByLabel("Reply to Relay").fill("Use a friendly greeting.");
  await ui.getByRole("button", { name: "Send answer", exact: true }).click();
  await expect(
    ui.getByText(
      "Your answer was received and the question flow is verified.",
      { exact: true },
    ),
  ).toBeVisible();
  await ui
    .getByLabel("Task prompt")
    .fill("Auto approval fixture: inspect the page twice.");
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  const decision = ui.getByRole("region", { name: "Approval required" });
  await expect(decision).toBeVisible();
  await expect(ui.locator(".browser-viewport img")).toBeVisible();
  const decisionBefore = await decision.boundingBox();
  await ui.locator(".activity-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect((await decision.boundingBox())?.y).toBe(decisionBefore?.y);
  await ui.screenshot({
    path: "test-results/relay-approval.png",
    fullPage: true,
  });
  await ui
    .getByRole("button", { name: "Auto-approve and continue", exact: true })
    .click();
  await expect(
    ui.getByRole("switch", { name: "Auto-approve", exact: true }),
  ).toBeChecked();
  await expect(
    ui.getByText("Automatic approval verified.", { exact: true }),
  ).toBeVisible();
  const liveState = await (await request.get("/api/state")).json();
  expect(liveState.settings.approvalMode).toBe("never");
  expect(
    liveState.runs[0].events.filter((e: any) => e.type === "approval_required"),
  ).toHaveLength(1);
  await ui.getByRole("button", { name: "Trace", exact: true }).click();
  await expect(ui.locator(".trace-event").first()).toBeVisible();
  await ui.getByRole("button", { name: "Activity", exact: true }).click();
  await ui.reload();
  await expect(
    ui.getByRole("switch", { name: "Auto-approve", exact: true }),
  ).toBeChecked();
  await ui.setViewportSize({ width: 390, height: 844 });
  await ui.screenshot({
    path: "test-results/relay-mobile.png",
    fullPage: true,
  });
  expect(
    await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
  await ui.getByRole("button", { name: "Browser", exact: true }).click();
  await expect(ui.getByRole("region", { name: "Browser view" })).toBeVisible();
  await ui.screenshot({
    path: "test-results/relay-mobile-browser.png",
    fullPage: true,
  });
  // Leave the user's workspace unconfigured rather than pointing at a stopped test provider.
  await request.put("/api/settings", { data: DEFAULT_SETTINGS });
});

test("local server rejects cross-origin writes and unpaired sockets", async ({
  request,
}) => {
  const response = await request.post("/api/runs", {
    headers: { Origin: "https://untrusted.example" },
    data: { prompt: "not authorized" },
  });
  expect(response.status()).toBe(403);
  const plain = await request.post("/api/runs", {
    headers: { "Content-Type": "text/plain" },
    data: "{}",
  });
  expect(plain.status()).toBe(415);
  const settings = await request.put("/api/settings", {
    data: { ...DEFAULT_SETTINGS, apiKey: "relay-secret-memory-test" },
  });
  expect(settings.ok()).toBe(true);
  const safeState = await request.get("/api/state");
  expect(await safeState.text()).not.toContain("relay-secret-memory-test");
  await request.put("/api/settings", {
    data: { ...DEFAULT_SETTINGS, apiKey: "" },
  });
  const denied = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:4799/bridge?token=incorrect", {
      origin: "chrome-extension://" + "a".repeat(32),
    });
    socket.on("unexpected-response", (_req, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode || 0);
    });
    socket.on("error", () => {});
    setTimeout(
      () =>
        reject(new Error("Unauthorized socket did not receive a rejection")),
      3000,
    ).unref();
  });
  expect(denied).toBe(401);
});
