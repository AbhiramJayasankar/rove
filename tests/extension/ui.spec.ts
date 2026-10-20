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

let context: BrowserContext;
let fixture: http.Server;
let ui: Page;
let origin: string;
let completionRequests = 0;
const authorizations: string[] = [];
const inputs: any[] = [];
const errors: string[] = [];
const secret = "ui-fixture-session-key";
const artifacts = "test-results/extension-ui";
// These steps exercise one configured chat and deliberately share its history.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fixture = http.createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [
            {
              id: "ui-fixture:free",
              name: "UI fixture model",
              context_length: 131072,
              supported_parameters: [
                "tools",
                "reasoning_effort",
                "max_completion_tokens",
              ],
              reasoning_efforts: ["none", "low", "high"],
              max_output_tokens: 8192,
              pricing: { prompt: "0", completion: "0" },
            },
            {
              id: "paid-ui-fixture",
              name: "Paid fixture",
              context_length: 32768,
              pricing: { prompt: "0.01", completion: "0.02" },
            },
          ],
        }),
      );
      return;
    }
    if (request.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      completionRequests++;
      inputs.push(input);
      authorizations.push(request.headers.authorization || "");
      const observed = input.messages.some(
        (message: any) => message.role === "tool",
      );
      const followup = String(
        input.messages.findLast(
          (message: any) =>
            message.role === "user" && typeof message.content === "string",
        )?.content || "",
      );
      const message = followup.includes("Follow-up fixture")
        ? {
            role: "assistant",
            content: followup.includes("after reload")
              ? "Continued after reload with the original heading."
              : "Follow-up kept the original heading.",
            reasoning_content:
              "The previous browser observation and assistant answer are available in this chat.",
          }
        : observed
          ? {
              role: "assistant",
              content:
                "The fixture page heading is UI browser fixture. Verified from the current page.",
              reasoning_content:
                "Confirmed the heading from the browser observation.",
            }
          : {
              role: "assistant",
              content: null,
              reasoning_content: "Read the current page before answering.",
              tool_calls: [
                {
                  id: "ui_read_page",
                  type: "function",
                  function: { name: "browser_snapshot", arguments: "{}" },
                },
              ],
            };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            { message, finish_reason: observed ? "stop" : "tool_calls" },
          ],
          usage: { prompt_tokens: 300, completion_tokens: 40 },
        }),
      );
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><title>UI browser fixture</title><main><h1>UI browser fixture</h1><p>A read-only page for the extension UI test.</p></main>",
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(fixture.address() as import("node:net").AddressInfo).port}`;
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
  const target = await context.newPage();
  await target.goto(`${origin}/page`);
  ui = await context.newPage();
  ui.on("pageerror", (error) => errors.push(error.message));
  await ui.goto(
    `chrome-extension://${new URL(worker.url()).host}/index.html?view=tab`,
  );
  await expect(
    ui.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await fs.mkdir(artifacts, { recursive: true });
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve) => fixture?.close(() => resolve()));
});

async function rpc(route: string, method = "GET", body?: any) {
  const result = await ui.evaluate(
    ({ route, method, body }) =>
      chrome.runtime.sendMessage({
        type: "relay-api",
        path: route,
        method,
        body,
      }),
    { route, method, body },
  );
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
const resultText =
  "The fixture page heading is UI browser fixture. Verified from the current page.";

test("connection settings use unsaved credentials for discovery and retain only the requested controls", async () => {
  await ui.setViewportSize({ width: 400, height: 850 });
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    ui
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button"),
  ).toHaveText(["Model", "Instructions", "Tools"]);
  await ui
    .getByRole("textbox", { name: "API base URL", exact: true })
    .fill(origin + "/v1");
  await ui.getByLabel("API key", { exact: true }).fill(secret);
  await ui.getByRole("button", { name: "Choose model", exact: true }).click();
  const picker = ui.getByRole("dialog", {
    name: "Model picker",
    exact: true,
  });
  await expect(
    picker.getByRole("option", { name: "UI fixture model", exact: true }),
  ).toContainText("UI fixture model");
  await expect(
    picker.getByRole("option", { name: "Paid fixture", exact: true }),
  ).toHaveCount(0);
  await picker
    .getByRole("option", { name: "UI fixture model", exact: true })
    .click();
  await expect(
    ui.getByRole("button", { name: "Choose model", exact: true }),
  ).toContainText("UI fixture model");
  expect((await rpc("/api/settings")).settings.baseUrl).not.toBe(
    origin + "/v1",
  );
  await ui.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    ui.getByText("Saved in this Chrome profile across sessions.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(ui.getByText("Saved", { exact: true }).first()).toBeVisible();
  const state = await rpc("/api/state");
  expect(state.hasApiKey).toBe(true);
  expect(JSON.stringify(state)).not.toContain(secret);
  expect(state.settings).toMatchObject({
    stream: true,
    vision: true,
    contextMode: "auto",
    reasoningFormat: "auto",
  });
  expect(state.settings).not.toHaveProperty("customTools");
  await ui.screenshot({
    path: artifacts + "/settings-light.png",
    fullPage: true,
  });
  await expect(ui.locator("select")).toHaveCount(0);
  await expect(
    ui.getByText(
      /Agent settings|Download backup|Import backup|Open full workbench|Workspace|Stream responses|Send screenshots to model/,
    ),
  ).toHaveCount(0);
  await expect(
    ui.getByRole("combobox", { name: "Approval mode", exact: true }),
  ).toHaveCount(0);
  await ui.getByRole("button", { name: "Instructions", exact: true }).click();
  await expect(
    ui.getByRole("textbox", { name: "System instructions", exact: true }),
  ).toBeVisible();
  await ui.getByRole("button", { name: "Tools", exact: true }).click();
  await ui
    .getByRole("searchbox", { name: "Search tools", exact: true })
    .fill("snapshot");
  await expect(
    ui.getByRole("switch", { name: "Enable browser_snapshot", exact: true }),
  ).toBeChecked();
  await expect(ui.getByText("Custom tools", { exact: true })).toHaveCount(0);
  await ui.getByRole("button", { name: "Back to chat", exact: true }).click();
});

test("composer exposes model names, custom reasoning controls, approvals, trace, themes and responsive layout", async () => {
  await expect(
    ui.getByRole("button", { name: "Choose model", exact: true }),
  ).toContainText("UI fixture model");
  const reasoning = ui.getByRole("combobox", {
    name: "Reasoning level",
    exact: true,
  });
  await expect(reasoning).toHaveText("High");
  await reasoning.click();
  const levels = ui.getByRole("listbox", {
    name: "Reasoning level",
    exact: true,
  });
  await expect(levels.getByRole("option")).toHaveText(["Off", "Low", "High"]);
  await levels.getByRole("option", { name: "Low", exact: true }).click();
  await expect(reasoning).toHaveText("Low");
  await expect(levels).not.toBeVisible();
  await reasoning.press("ArrowDown");
  await reasoning.press("End");
  await reasoning.press("Enter");
  await expect(reasoning).toHaveText("High");
  const auto = ui
    .locator(".task-composer")
    .getByRole("combobox", { name: "Approval mode", exact: true });
  await expect(auto).toHaveText("Auto");
  await auto.click();
  await ui.getByRole("option", { name: "Ask permission", exact: true }).click();
  await expect(auto).toHaveText("Ask");
  await auto.click();
  await ui.getByRole("option", { name: "Auto-approve", exact: true }).click();
  await expect(auto).toHaveText("Auto");
  await expect(
    ui
      .locator(".context-strip")
      .getByRole("combobox", { name: "Approval mode" }),
  ).toHaveCount(0);
  const target = ui.getByRole("combobox", { name: "Chrome tab", exact: true });
  await target.click();
  await ui
    .getByRole("listbox", { name: "Chrome tab", exact: true })
    .getByRole("option")
    .filter({ hasText: "UI browser fixture" })
    .click();
  await ui
    .getByRole("textbox", { name: "Task prompt", exact: true })
    .fill("Read the heading on the fixture page and tell me what it says.");
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(ui.getByText(resultText, { exact: true })).toBeVisible({
    timeout: 30000,
  });
  expect(completionRequests).toBe(2);
  expect(authorizations).toEqual(["Bearer " + secret, "Bearer " + secret]);
  expect(inputs[0]).toMatchObject({
    stream: true,
    max_completion_tokens: 8192,
    reasoning_effort: "high",
  });
  expect(
    inputs[1].messages.some(
      (message: any) =>
        Array.isArray(message.content) &&
        message.content.some((part: any) => part.type === "image_url"),
    ),
  ).toBe(true);
  const ring = ui.getByRole("button", { name: "Chat usage", exact: true });
  await ring.click();
  const usage = ui.getByRole("dialog", { name: "Chat usage", exact: true });
  await expect(usage.getByText("600", { exact: true })).toBeVisible();
  await expect(usage.getByText("80", { exact: true })).toBeVisible();
  await expect(usage.getByText("$0.00", { exact: true })).toBeVisible();
  const usageBox = await usage.boundingBox(),
    ringBox = await ring.boundingBox();
  expect(usageBox!.y + usageBox!.height).toBeLessThanOrEqual(ringBox!.y + 2);
  await ui.screenshot({
    path: artifacts + "/usage-popover.png",
    fullPage: true,
  });
  await ui.keyboard.press("Escape");
  await expect(usage).not.toBeVisible();
  await ui.getByRole("button", { name: "Trace", exact: true }).click();
  await ui.getByRole("button", { name: "Expand all", exact: true }).click();
  await expect(
    ui
      .locator(".trace-event[open]")
      .filter({
        has: ui.locator("summary > span", { hasText: /^model request$/ }),
      })
      .first(),
  ).toContainText('"messages"');
  await expect(
    ui
      .locator(".trace-event[open]")
      .filter({
        has: ui.locator("summary > span", { hasText: /^model response$/ }),
      })
      .first(),
  ).toContainText("reasoning_content");
  await ui.getByRole("button", { name: "Collapse all", exact: true }).click();
  await expect(ui.locator(".trace-event[open]")).toHaveCount(0);
  await ui.getByRole("button", { name: "Activity", exact: true }).click();
  await ui.getByRole("button", { name: "Use dark mode", exact: true }).click();
  await expect(ui.locator("html")).toHaveAttribute("data-theme", "dark");
  await ui.reload();
  await expect(ui.locator("html")).toHaveAttribute("data-theme", "dark");
  await ui.screenshot({ path: artifacts + "/chat-dark.png", fullPage: true });
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await ui.screenshot({
    path: artifacts + "/settings-dark.png",
    fullPage: true,
  });
  await ui.getByRole("button", { name: "Back to chat", exact: true }).click();
  await ui.getByRole("button", { name: "New task", exact: true }).click();
  await expect(
    ui.getByRole("heading", { name: "What’s the task?", exact: true }),
  ).toBeVisible();
  for (const width of [320, 360, 400, 1280]) {
    await ui.setViewportSize({ width, height: 850 });
    expect(
      await ui.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    for (const locator of [
      reasoning,
      auto,
      ui.getByRole("button", { name: "Choose model", exact: true }),
      ui.getByRole("button", { name: "Run task", exact: true }),
    ]) {
      const box = await locator.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y + box!.height).toBeLessThan(850);
    }
    const row = ui.locator(".composer-controls");
    const positions = await row
      .locator(":scope > button")
      .evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().y),
      );
    expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
  }
  await ui.setViewportSize({ width: 400, height: 850 });
  await ui.screenshot({
    path: artifacts + "/composer-dark.png",
    fullPage: true,
  });
  await ui.getByRole("button", { name: "Use light mode", exact: true }).click();
  await ui.screenshot({
    path: artifacts + "/composer-light.png",
    fullPage: true,
  });
  await ui.getByRole("button", { name: "Task history", exact: true }).click();
  const history = ui.getByRole("dialog", { name: "Task history", exact: true });
  await history
    .getByRole("textbox", { name: "Search tasks", exact: true })
    .fill("Read the heading");
  await expect(
    history.getByRole("button", {
      name: "Read the heading on the fixture page and tell me what it says.",
      exact: true,
    }),
  ).toBeVisible();
  await history.press("Escape");
  expect(errors).toEqual([]);
});

test("chat follow-ups survive settings, page reload and keep one history entry", async () => {
  await ui.getByRole("button", { name: "Task history", exact: true }).click();
  await ui
    .getByRole("dialog", { name: "Task history", exact: true })
    .getByRole("button", {
      name: "Read the heading on the fixture page and tell me what it says.",
      exact: true,
    })
    .click();
  const before = await rpc("/api/state");
  const id = before.runs[0].id;
  const prompt = ui.getByRole("textbox", { name: "Task prompt", exact: true });
  await prompt.fill("Follow-up fixture: which heading did you read?");
  await ui.getByRole("button", { name: "Settings", exact: true }).click();
  await ui.getByRole("button", { name: "Back to chat", exact: true }).click();
  await expect(prompt).toHaveValue(
    "Follow-up fixture: which heading did you read?",
  );
  await expect(ui.getByText(resultText, { exact: true })).toBeVisible();
  await prompt.press("Enter");
  await expect(
    ui.getByText("Follow-up kept the original heading.", { exact: true }),
  ).toBeVisible();
  let state = await rpc("/api/state");
  expect(state.runs).toHaveLength(1);
  expect(state.runs[0].id).toBe(id);
  expect(
    inputs
      .at(-1)
      .messages.some(
        (message: any) =>
          message.role === "assistant" && message.content === resultText,
      ),
  ).toBe(true);
  expect(
    inputs.at(-1).messages.some((message: any) => message.role === "tool"),
  ).toBe(true);
  expect(
    inputs
      .at(-1)
      .messages.some(
        (message: any) =>
          Array.isArray(message.content) &&
          message.content.some(
            (part: any) =>
              part.type === "image_url" &&
              part.image_url.url.startsWith("data:image/"),
          ),
      ),
  ).toBe(true);
  await ui.reload();
  await expect(
    ui.getByText("Follow-up kept the original heading.", { exact: true }),
  ).toBeVisible();
  await prompt.fill("Follow-up fixture after reload");
  await prompt.press("Enter");
  await expect(
    ui.getByText("Continued after reload with the original heading.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(ui.locator(".conversation-turn")).toHaveCount(3);
  state = await rpc("/api/state");
  expect(state.runs).toHaveLength(1);
  await ui.screenshot({
    path: artifacts + "/continued-chat.png",
    fullPage: true,
  });
  const picker = ui.getByRole("button", { name: "Choose model", exact: true });
  await picker.click();
  const menu = ui.getByRole("dialog", { name: "Model picker", exact: true });
  await expect(
    menu.getByRole("textbox", { name: "Custom model ID" }),
  ).toHaveCount(0);
  const search = menu.getByRole("textbox", {
    name: "Search models",
    exact: true,
  });
  await search.fill("UI fixture");
  await expect(menu.getByRole("option")).toHaveCount(1);
  const buttonBox = await picker.boundingBox(),
    menuBox = await menu.boundingBox();
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(buttonBox!.y + 2);
  await ui.screenshot({
    path: artifacts + "/model-dropdown.png",
    fullPage: true,
  });
  await ui.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
});

test("editing a previous message rewrites saved history and keeps the editor compact", async () => {
  await ui.setViewportSize({ width: 400, height: 850 });
  const before = await rpc("/api/state");
  const id = before.runs[0].id;
  const turns = ui.locator(".conversation-turn");
  await expect(turns).toHaveCount(3);
  await turns
    .nth(1)
    .getByRole("button", { name: "Edit message", exact: true })
    .click();
  const editor = ui.locator(".message-editor");
  const input = editor.getByRole("textbox", {
    name: "Edit message",
    exact: true,
  });
  await expect(input).toHaveValue(
    "Follow-up fixture: which heading did you read?",
  );
  await input.fill("Follow-up fixture: revised middle message");
  await expect(editor.getByText(/Replaces this message/)).toHaveCount(0);
  expect((await editor.boundingBox())!.height).toBeLessThan(100);
  await ui.screenshot({
    path: artifacts + "/message-editor.png",
    fullPage: true,
  });
  await editor
    .getByRole("button", { name: "Save and run", exact: true })
    .click();
  await expect(turns).toHaveCount(2);
  await expect(ui.locator(".message-editor")).toHaveCount(0);
  await expect(
    ui.getByText("Continued after reload with the original heading.", {
      exact: true,
    }),
  ).toHaveCount(0);
  const record = await rpc("/api/runs/" + id);
  expect(record.revision).toBe(1);
  expect(
    record.events
      .filter((event: any) => event.type === "user_message")
      .map((event: any) => event.data.message),
  ).toEqual(["Follow-up fixture: revised middle message"]);
  await expect
    .poll(async () => (await rpc("/api/runs/" + id)).status)
    .toBe("completed");
  expect(
    inputs
      .at(-1)
      .messages.some(
        (message: any) =>
          typeof message.content === "string" &&
          message.content.includes("Follow-up fixture after reload"),
      ),
  ).toBe(false);
  await ui.reload();
  await expect(turns).toHaveCount(2);
  await turns
    .first()
    .getByRole("button", { name: "Edit message", exact: true })
    .click();
  await input.fill("Follow-up fixture: replace the first message");
  await editor
    .getByRole("button", { name: "Save and run", exact: true })
    .click();
  await expect(turns).toHaveCount(1);
  await expect
    .poll(async () => (await rpc("/api/runs/" + id)).status)
    .toBe("completed");
  const first = await rpc("/api/runs/" + id);
  expect(first.prompt).toBe("Follow-up fixture: replace the first message");
  expect(first.revision).toBe(2);
  expect(first.events.some((event: any) => event.type === "user_message")).toBe(
    false,
  );
  expect(
    inputs
      .at(-1)
      .messages.filter(
        (message: any) =>
          message.role === "assistant" || message.role === "tool",
      ),
  ).toHaveLength(0);
  await ui.reload();
  await expect(turns).toHaveCount(1);
  await expect(ui.locator(".user-message")).toContainText(
    "Follow-up fixture: replace the first message",
  );
  expect(errors).toEqual([]);
});

test("persistent API key survives closing the whole browser and stays outside settings and traces", async () => {
  const profile = await fs.mkdtemp(
    path.resolve(artifacts, "credential-profile-"),
  );
  const extension = path.resolve("extension");
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [
        "--disable-extensions-except=" + extension,
        "--load-extension=" + extension,
      ],
    });
  let isolated = await launch();
  try {
    let worker =
      isolated.serviceWorkers()[0] ||
      (await isolated.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    let panel = await isolated.newPage();
    await panel.goto("chrome-extension://" + extensionId + "/index.html");
    await panel.evaluate(
      async ({ origin, secret }) => {
        const response = await chrome.runtime.sendMessage({
          type: "relay-api",
          path: "/api/settings",
          method: "GET",
        });
        await chrome.runtime.sendMessage({
          type: "relay-api",
          path: "/api/settings",
          method: "PUT",
          body: {
            ...response.data.settings,
            baseUrl: origin + "/v1",
            apiKey: secret,
          },
        });
      },
      { origin, secret },
    );
    await isolated.close();
    isolated = await launch();
    worker =
      isolated.serviceWorkers()[0] ||
      (await isolated.waitForEvent("serviceworker"));
    panel = await isolated.newPage();
    await panel.goto(
      "chrome-extension://" + new URL(worker.url()).host + "/index.html",
    );
    const state = await panel.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({
        type: "relay-api",
        path: "/api/state",
        method: "GET",
      });
      return {
        state: response.data,
        legacy: await chrome.storage.session.get("apiKey"),
      };
    });
    expect(state.state.hasApiKey).toBe(true);
    expect(JSON.stringify(state)).not.toContain(secret);
    expect(state.legacy).toEqual({});
    const result = await panel.evaluate(async () =>
      chrome.runtime.sendMessage({
        type: "relay-api",
        path: "/api/models",
        method: "GET",
      }),
    );
    expect(result.ok).toBe(true);
    const clear = await panel.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({
        type: "relay-api",
        path: "/api/settings",
        method: "GET",
      });
      return chrome.runtime.sendMessage({
        type: "relay-api",
        path: "/api/settings",
        method: "PUT",
        body: { ...response.data.settings, apiKey: "" },
      });
    });
    expect(clear.data.hasApiKey).toBe(false);
  } finally {
    await isolated.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
