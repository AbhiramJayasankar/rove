import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEngine } from "../server/agent";
import { executeTool, getTools, validateCustomTools } from "../server/tools";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type {
  BrowserTransport,
  CustomTool,
  RunEvent,
  RunRecord,
  Settings,
} from "../shared/types";

afterEach(() => vi.unstubAllGlobals());
const call = (id: string, name: string, args: any) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const response = (content: string | null, tool_calls?: any[]) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content,
            ...(tool_calls ? { tool_calls } : {}),
          },
        },
      ],
    }),
  );
async function until(predicate: () => boolean) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out waiting for agent state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function setup(overrides: Partial<Settings> = {}, apiKey = "") {
  const settings: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    model: "test",
    approvalMode: "never",
    ...overrides,
  };
  const execute = vi.fn().mockResolvedValue({ text: "Example page" });
  const transport: BrowserTransport = {
    execute,
    status: () => ({ connected: true, tabs: [] }),
  };
  const events: RunEvent[] = [];
  const saves: RunRecord[] = [];
  const engine = new AgentEngine({
    transport,
    getSettings: () => settings,
    getApiKey: () => apiKey,
    emit: (_, event) => events.push(event),
    save: (run) => saves.push(run),
  });
  return { engine, events, execute, settings, transport, saves };
}

describe("agent execution loop", () => {
  it("preserves long provider reasoning in the trace and subsequent requests", async () => {
    const reasoning = "Reasoning detail. ".repeat(3000);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  reasoning_content: reasoning,
                  tool_calls: [call("one", "browser_tabs", {})],
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(response("Done."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup();
    ctx.engine.start("Inspect tabs.");
    await until(() => !ctx.engine.activeRunId);
    expect(
      ctx.events.find((e) => e.type === "model_response")?.data.message
        .reasoning_content,
    ).toBe(reasoning);
    expect(
      JSON.parse(fetchMock.mock.calls[1][1].body).messages.find(
        (m: any) => m.role === "assistant",
      ).reasoning_content,
    ).toBe(reasoning);
  });
  it("enables auto-approval on a paused run and executes later tools without more approval pauses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(null, [
            call("one", "browser_click", { ref: "e1" }),
            call("two", "browser_type", { text: "test" }),
          ]),
        )
        .mockResolvedValueOnce(response("Done.")),
    );
    const ctx = setup({ approvalMode: "always" });
    const run = ctx.engine.start("Fill the form.", 7);
    await until(() => ctx.events.some((e) => e.type === "approval_required"));
    expect(ctx.execute).not.toHaveBeenCalled();
    ctx.engine.setApprovalMode("never");
    await until(() => !ctx.engine.activeRunId);
    expect(run.status).toBe("completed");
    expect(ctx.execute.mock.calls.map((c) => c[0])).toEqual([
      "browser_click",
      "browser_screenshot",
      "browser_type",
      "browser_screenshot",
    ]);
    expect(
      ctx.events.filter((e) => e.type === "approval_required"),
    ).toHaveLength(1);
    expect(
      ctx.events.find((e) => e.type === "approval_decision")?.data.source,
    ).toBe("automatic");
  });
  it("keeps a user question paused when auto-approval is enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(null, [
            call("question", "ask_user", { question: "Which option?" }),
          ]),
        )
        .mockResolvedValueOnce(response("Done.")),
    );
    const ctx = setup({ approvalMode: "always" });
    const run = ctx.engine.start("Choose an option.");
    await until(() => ctx.events.some((e) => e.type === "user_question"));
    ctx.engine.setApprovalMode("never");
    expect(run.status).toBe("awaiting_approval");
    expect(
      ctx.events.filter((e) => e.type === "approval_decision"),
    ).toHaveLength(0);
    ctx.engine.reply(run.id, "First option");
    await until(() => !ctx.engine.activeRunId);
    expect(run.status).toBe("completed");
  });
  it("keeps long page snapshots valid and preserves refs, frame IDs and pagination before text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(null, [call("snapshot", "browser_snapshot", {})]),
      )
      .mockResolvedValueOnce(response("Inspected."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup();
    const elements = Array.from({ length: 200 }, (_, index) => ({
      ref: `ref-${index}`,
      role: "combobox",
      name: `Field ${index}`,
      tag: "select",
      options: Array.from({ length: 100 }, (_, option) => ({
        value: `value-${option}`,
        label: "An option label ".repeat(20),
        selected: option === 0,
      })),
    }));
    ctx.execute.mockResolvedValueOnce({
      tabId: 7,
      title: "Long form",
      url: "https://example.com/form",
      text: "Long page prose ".repeat(1500),
      textOffset: 100,
      textLength: 40000,
      hasMoreText: true,
      elements,
      elementOffset: 20,
      totalElements: 500,
      hasMoreElements: true,
      frameId: "main-frame",
      frames: [
        { id: "main-frame" },
        {
          id: "child-frame",
          parentId: "main-frame",
          url: "https://example.com/embed",
        },
      ],
    });
    ctx.engine.start("Inspect the form", 7);
    await until(() => !ctx.engine.activeRunId);
    const content = JSON.parse(fetchMock.mock.calls[1][1].body).messages.find(
      (message: any) => message.role === "tool",
    ).content;
    const snapshot = JSON.parse(content);
    expect(content.length).toBeLessThanOrEqual(64000);
    expect(snapshot.frameId).toBe("main-frame");
    expect(snapshot.frames[1].id).toBe("child-frame");
    expect(snapshot.elements.at(-1).ref).toBe("ref-199");
    expect(snapshot.text.length).toBeLessThanOrEqual(8000);
    expect(snapshot.hasMoreText).toBe(true);
    expect(snapshot.nextTextOffset).toBe(100 + snapshot.text.length);
    expect(snapshot.elementOffset).toBe(20);
    expect(snapshot.totalElements).toBe(500);
    expect(snapshot.nextElementOffset).toBe(20 + snapshot.elements.length);
  });

  it("preserves arrays from tab inventories and custom tools, including nested arrays", async () => {
    const custom: CustomTool = {
      name: "read_headings",
      description: "Read headings",
      parameters: { type: "object", properties: {} },
      enabled: true,
      approval: false,
      handler: { type: "javascript", code: "return ['Heading'];" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(null, [
          call("tabs", "browser_tabs", {}),
          call("headings", "read_headings", {}),
        ]),
      )
      .mockResolvedValueOnce(response("Read."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup({ customTools: [custom] });
    ctx.execute
      .mockResolvedValueOnce([
        { id: 7, title: "Example", url: "https://example.com" },
      ])
      .mockResolvedValueOnce([
        "Heading",
        { children: ["Nested", { image: "data:image/png;base64,YQ==" }] },
      ]);
    ctx.engine.start("Read headings", 7);
    await until(() => !ctx.engine.activeRunId);
    const results = JSON.parse(fetchMock.mock.calls[1][1].body)
      .messages.filter((message: any) => message.role === "tool")
      .map((message: any) => JSON.parse(message.content));
    expect(Array.isArray(results[0])).toBe(true);
    expect(results[0][0].id).toBe(7);
    expect(results[1]).toEqual([
      "Heading",
      {
        children: [
          "Nested",
          { image: "[Image available in screenshot event]" },
        ],
      },
    ]);
  });

  it("records the run configuration with custom code and masked HTTP headers without the model key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("Done")));
    const javascript: CustomTool = {
      name: "read_title",
      description: "Read title",
      parameters: { type: "object" },
      enabled: true,
      approval: false,
      handler: { type: "javascript", code: "return document.title;" },
    };
    const http: CustomTool = {
      ...javascript,
      name: "send_result",
      handler: {
        type: "http",
        method: "POST",
        url: "https://example.com/action",
        headers: {
          Authorization: "Bearer private-http-secret",
          "X-Project": "private-project",
        },
      },
    };
    const ctx = setup({ customTools: [javascript, http] }, "private-model-key");
    ctx.engine.start("Record configuration", 7);
    await until(() => !ctx.engine.activeRunId);
    const configuration = ctx.events.find(
      (event) => event.type === "run_configuration",
    )!.data;
    expect(configuration.settings.customTools[0].handler.code).toBe(
      "return document.title;",
    );
    expect(configuration.settings.customTools[1].handler.headers).toEqual({
      Authorization: "[redacted]",
      "X-Project": "[redacted]",
    });
    expect(configuration.selectedTabId).toBe(7);
    expect(configuration.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(configuration)).not.toContain("private-model-key");
    expect(JSON.stringify(configuration)).not.toContain("private-http-secret");
    expect(
      (ctx.settings.customTools[1].handler as any).headers.Authorization,
    ).toBe("Bearer private-http-secret");
  });
  it("executes multi-step tool calls sequentially, supplies selected tab context, and saves a verified final response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response("I will inspect the page.", [
          call("one", "browser_snapshot", {}),
        ]),
      )
      .mockResolvedValueOnce(
        response(null, [
          call("two", "browser_navigate", { url: "https://example.com" }),
          call("three", "browser_snapshot", {}),
        ]),
      )
      .mockResolvedValueOnce(response("Verified the result."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup();
    ctx.execute.mockImplementation(async (action) =>
      action === "browser_navigate"
        ? { tabId: 12, text: "After" }
        : { text: "Page verified" },
    );
    const run = ctx.engine.start("Open example.com and verify it.", 7);
    await until(() => !ctx.engine.activeRunId);
    expect(run.status).toBe("completed");
    expect(ctx.execute.mock.calls.map((c) => [c[0], c[1].tabId])).toEqual([
      ["browser_snapshot", 7],
      ["browser_screenshot", 7],
      ["browser_navigate", 7],
      ["browser_screenshot", 12],
      ["browser_snapshot", 12],
      ["browser_screenshot", 12],
    ]);
    const lastRequest = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(
      lastRequest.messages
        .filter((m: any) => m.role === "tool")
        .map((m: any) => m.tool_call_id),
    ).toEqual(["one", "two", "three"]);
    expect(ctx.events.filter((e) => e.type === "model_request")).toHaveLength(
      3,
    );
    expect(ctx.saves.at(-1)?.status).toBe("completed");
    expect(ctx.saves[0].events).toHaveLength(1);
  });

  it("waits for approval and sends a denied action back without executing it", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(null, [call("one", "browser_click", { ref: "e1" })]),
        )
        .mockResolvedValueOnce(response("Action cancelled.")),
    );
    const ctx = setup({ approvalMode: "risky" });
    const run = ctx.engine.start("Click the button.", 7);
    await until(() => ctx.events.some((e) => e.type === "approval_required"));
    const approval = ctx.events.find((e) => e.type === "approval_required")!;
    expect(run.status).toBe("awaiting_approval");
    expect(ctx.execute).not.toHaveBeenCalled();
    ctx.engine.approve(run.id, approval.data.id, false);
    await until(() => !ctx.engine.activeRunId);
    expect(ctx.execute).not.toHaveBeenCalled();
    expect(
      ctx.events.find((e) => e.type === "tool_result")?.data.result.denied,
    ).toBe(true);
    expect(run.status).toBe("completed");
  });

  it("cancels pending approvals and never runs queued actions", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response(null, [
            call("one", "browser_click", { ref: "e1" }),
            call("two", "browser_type", { text: "secret" }),
          ]),
        ),
    );
    const ctx = setup({ approvalMode: "always" });
    const run = ctx.engine.start("Fill a form.", 7);
    await until(() => ctx.events.some((e) => e.type === "approval_required"));
    const approval = ctx.events.find((e) => e.type === "approval_required")!;
    ctx.engine.stop(run.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run.status).toBe("stopped");
    expect(ctx.engine.activeRunId).toBeNull();
    expect(ctx.execute).not.toHaveBeenCalled();
    expect(() => ctx.engine.approve(run.id, approval.data.id, true)).toThrow(
      "not active",
    );
    expect(ctx.events.at(-1)?.data.status).toBe("stopped");
  });

  it("pauses for user input and resumes the same conversation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(null, [
          call("one", "ask_user", { question: "Please sign in, then reply." }),
        ]),
      )
      .mockResolvedValueOnce(response("Signed in and ready."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup();
    const run = ctx.engine.start("Check my account.");
    await until(() => ctx.events.some((e) => e.type === "user_question"));
    ctx.engine.reply(run.id, "Done");
    await until(() => !ctx.engine.activeRunId);
    expect(
      JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content,
    ).toContain("Done");
    expect(run.status).toBe("completed");
  });

  it("keeps vision messages after complete tool batches and request traces compact", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(null, [
          call("one", "browser_screenshot", {}),
          call("two", "browser_snapshot", {}),
        ]),
      )
      .mockResolvedValueOnce(response("I see it."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup({ vision: true });
    ctx.execute
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,YQ==",
        tabId: 7,
      })
      .mockResolvedValueOnce({ text: "Page text" });
    ctx.engine.start("Inspect this page.", 7);
    await until(() => !ctx.engine.activeRunId);
    const messages = JSON.parse(fetchMock.mock.calls[1][1].body).messages;
    expect(messages.slice(-3).map((m: any) => m.role)).toEqual([
      "tool",
      "tool",
      "user",
    ]);
    expect(messages.at(-1).content[1].image_url.url).toContain("data:image");
    expect(
      JSON.stringify(ctx.events.filter((e) => e.type === "model_request")),
    ).not.toContain("data:image/png");
    expect(
      ctx.events.find((e) => e.type === "screenshot")?.data.dataUrl,
    ).toContain("data:image");
  });

  it("captures the browser view automatically even when a text-only model never requests a screenshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(null, [call("one", "browser_snapshot", {})]),
        )
        .mockResolvedValueOnce(response("Observed.")),
    );
    const ctx = setup();
    ctx.execute
      .mockResolvedValueOnce({ text: "Page content" })
      .mockResolvedValueOnce({
        dataUrl: "data:image/png;base64,YQ==",
        tabId: 7,
        title: "Example",
        url: "https://example.com",
      });
    const run = ctx.engine.start("Inspect this page.", 7);
    await until(() => !ctx.engine.activeRunId);
    const screenshot = ctx.events.find((e) => e.type === "screenshot");
    expect(screenshot?.data).toMatchObject({
      source: "automatic",
      tabId: 7,
      title: "Example",
      url: "https://example.com",
    });
    expect(
      ctx.events.find((e) => e.type === "browser_observation")?.data.action,
    ).toBe("browser_screenshot");
    expect(run.status).toBe("completed");
  });

  it("continues when automatic capture is unavailable and redacts secrets across all text traces", async () => {
    const key = "secret-backend-key";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(`Echo ${key}`, [call("one", "browser_type", { text: key })]),
        )
        .mockResolvedValueOnce(response("Done")),
    );
    const ctx = setup({}, key);
    ctx.execute
      .mockResolvedValueOnce({ text: `Echo ${key}` })
      .mockRejectedValueOnce(new Error(`No capture ${key}`));
    const run = ctx.engine.start(`Task echoes ${key}`, 7);
    await until(() => !ctx.engine.activeRunId);
    expect(JSON.stringify(ctx.events)).not.toContain(key);
    expect(
      ctx.events.find((e) => e.type === "browser_observation")?.data.error,
    ).toBe("No capture [REDACTED]");
    expect(run.status).toBe("completed");
  });

  it("feeds argument validation errors back to the model and fails at the bounded step limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          response(null, [
            call("one", "browser_navigate", { url: "javascript:alert(1)" }),
          ]),
        ),
    );
    const ctx = setup({ maxSteps: 2 });
    const run = ctx.engine.start("Navigate.");
    expect(() => ctx.engine.start("Another task")).toThrow("already active");
    await until(() => !ctx.engine.activeRunId);
    expect(ctx.execute).not.toHaveBeenCalled();
    expect(
      ctx.events.filter((e) => e.type === "tool_result")[0].data.error,
    ).toContain("HTTP(S)");
    expect(run.status).toBe("failed");
    expect(ctx.events.at(-1)?.data.message).toBe("Step limit reached.");
  });
});

describe("tool registry", () => {
  const custom: CustomTool = {
    name: "read_title",
    description: "Read page title",
    parameters: {
      type: "object",
      properties: { prefix: { type: "string" } },
      required: ["prefix"],
      additionalProperties: false,
    },
    enabled: true,
    approval: true,
    handler: {
      type: "javascript",
      code: "return args.prefix + document.title;",
    },
  };
  it("validates JSON Schema, names and collisions before configuration is accepted", () => {
    expect(() => validateCustomTools([custom])).not.toThrow();
    expect(() =>
      validateCustomTools([{ ...custom, name: "browser_click" }]),
    ).toThrow("duplicate");
    expect(() => validateCustomTools([custom, custom])).toThrow("duplicate");
    expect(() =>
      validateCustomTools([{ ...custom, parameters: { type: "array" } }]),
    ).toThrow("object");
    expect(() =>
      validateCustomTools([
        {
          ...custom,
          parameters: {
            type: "object",
            properties: { a: { type: "unknown-type" } },
          },
        },
      ]),
    ).toThrow("JSON Schema");
  });

  it("enforces enabled tools and schema arguments, then dispatches custom JavaScript with args", async () => {
    const ctx = setup({ customTools: [custom] });
    const signal = new AbortController().signal;
    await expect(
      executeTool(
        custom.name,
        { prefix: 2 },
        ctx.settings,
        ctx.transport,
        signal,
      ),
    ).rejects.toThrow("Invalid arguments");
    await executeTool(
      custom.name,
      { prefix: "Title: " },
      ctx.settings,
      ctx.transport,
      signal,
    );
    expect(ctx.execute).toHaveBeenCalledWith(
      "browser_evaluate",
      {
        code: custom.handler.type === "javascript" ? custom.handler.code : "",
        args: { prefix: "Title: " },
      },
      signal,
    );
    ctx.settings.disabledTools.push(custom.name);
    expect(getTools(ctx.settings).some((t) => t.name === custom.name)).toBe(
      false,
    );
    await expect(
      executeTool(
        custom.name,
        { prefix: "" },
        ctx.settings,
        ctx.transport,
        signal,
      ),
    ).rejects.toThrow("disabled");
  });

  it("supports bounded HTTP custom tools and rejects arbitrary protocols", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"title":"Example"}'));
    vi.stubGlobal("fetch", fetchMock);
    const http: CustomTool = {
      ...custom,
      handler: {
        type: "http",
        url: "http://localhost:8000/title",
        method: "POST",
      },
    };
    const ctx = setup({ customTools: [http] });
    const result = await executeTool(
      http.name,
      { prefix: "Hi" },
      ctx.settings,
      ctx.transport,
      new AbortController().signal,
    );
    expect(result.title).toBe("Example");
    expect(fetchMock.mock.calls[0][1].body).toBe('{"prefix":"Hi"}');
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
    expect(() =>
      validateCustomTools([
        {
          ...http,
          handler: { type: "http", url: "file:///secret", method: "GET" },
        },
      ]),
    ).toThrow("HTTP");
  });
});
