import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEngine } from "../agent";
import { executeTool, getTools } from "../tools";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import type {
  BrowserTransport,
  RunEvent,
  RunRecord,
  Settings,
} from "../../shared/types";

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
function setup(
  overrides: Partial<Settings> = {},
  apiKey = "",
  extra: Partial<ConstructorParameters<typeof AgentEngine>[0]> = {},
) {
  const settings: Settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    model: "test",
    contextWindow: 1048576,
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
    resolveModel: async () => ({
      id: "test",
      name: "Test model",
      contextWindow: 1048576,
      free: true,
      metadata: {},
      source: "fixture",
      fetchedAt: new Date().toISOString(),
    }),
    ...extra,
  });
  return { engine, events, execute, settings, transport, saves };
}

describe("agent execution loop", () => {
  it("asks again when the model returns an empty final reply, then reports the answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(""))
      .mockResolvedValueOnce(response("Here is the answer."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup();
    const run = ctx.engine.start("Research this.");
    await until(() => !ctx.engine.activeRunId);
    expect(run.status).toBe("completed");
    expect(run.events.some((event) => event.type === "empty_answer")).toBe(true);
    expect(run.events.findLast((event) => event.type === "assistant")?.data.content).toBe("Here is the answer.");
  });
  it("fails visibly when the model never produces an answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response("")));
    const ctx = setup();
    const run = ctx.engine.start("Research this.");
    await until(() => !ctx.engine.activeRunId);
    expect(run.status).toBe("failed");
    expect(run.events.find((event) => event.type === "error")?.data.message).toContain("without giving an answer");
  });
  it("adds the user's standing instructions to every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("Done."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup({ memory: "Always answer in British English." });
    ctx.engine.start("Hello.");
    await until(() => !ctx.engine.activeRunId);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.messages[0].content).toContain("Standing notes from the user");
    expect(sent.messages[0].content).toContain("Always answer in British English.");
  });
  describe("site rules", () => {
    const navigate = (url: string) => response(null, [call("nav", "browser_navigate", { url })]);
    it("blocks a site without touching the browser and tells the model", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(navigate("https://login.bank.com/")).mockResolvedValueOnce(response("Skipped it."));
      vi.stubGlobal("fetch", fetchMock);
      const ctx = setup({ siteRules: [{ pattern: "bank.com", action: "block" }] });
      const run = ctx.engine.start("Open my bank.");
      await until(() => !ctx.engine.activeRunId);
      expect(ctx.execute).not.toHaveBeenCalledWith("browser_navigate", expect.anything(), expect.anything());
      const result = run.events.find((event) => event.type === "tool_result");
      expect(result?.data.result).toMatchObject({ blocked: true, site: "login.bank.com" });
      expect(run.status).toBe("completed");
    });
    it("asks even in auto-approve mode, and switching to auto cannot answer it", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(navigate("https://news.example.org/")).mockResolvedValueOnce(response("Read it.")));
      const ctx = setup({ approvalMode: "never", siteRules: [{ pattern: "example.org", action: "ask" }] });
      const run = ctx.engine.start("Open the news.");
      await until(() => run.status === "awaiting_approval");
      ctx.engine.setApprovalMode("never", run.id);
      expect(run.status).toBe("awaiting_approval");
      const required = run.events.findLast((event) => event.type === "approval_required")!;
      expect(required.data).toMatchObject({ site: "news.example.org", reason: "site rule" });
      ctx.engine.approve(run.id, required.data.id, true);
      await until(() => !ctx.engine.activeRunId);
      expect(ctx.execute).toHaveBeenCalledWith("browser_navigate", expect.anything(), expect.anything());
    });
    it("lets an allowed site skip approval in ask-first mode but still asks elsewhere", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(navigate("https://docs.ok.com/")).mockResolvedValueOnce(navigate("https://other.com/")));
      const ctx = setup({ approvalMode: "risky", siteRules: [{ pattern: "ok.com", action: "allow" }] });
      const run = ctx.engine.start("Browse.");
      await until(() => run.status === "awaiting_approval");
      expect(ctx.execute).toHaveBeenCalledWith("browser_navigate", expect.objectContaining({ url: "https://docs.ok.com/" }), expect.anything());
      expect(run.events.findLast((event) => event.type === "approval_required")?.data.args.url).toBe("https://other.com/");
      ctx.engine.stop(run.id);
    });
  });
  it("saves only the newest event per save call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("Done.")));
    const ctx = setup();
    ctx.engine.start("Hello.");
    await until(() => !ctx.engine.activeRunId);
    expect(ctx.saves.every((saved) => saved.events.length === 1)).toBe(true);
    expect(ctx.saves.at(-1)?.status).toBe("completed");
  });
  it("applies a corrected server context limit and adjusts output automatically", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "context_length_exceeded",
              max_context_length: 65536,
              message: "Context window exceeded",
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(response("Recovered."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup({}, "", {
      resolveModel: async () => ({
        id: "test",
        name: "Test",
        contextWindow: 1048576,
        maxOutputTokens: 128000,
        free: true,
        metadata: {},
        source: "fixture",
        fetchedAt: new Date().toISOString(),
      }),
    });
    const run = ctx.engine.start("Inspect the page", 7);
    await until(() => !ctx.engine.activeRunId);
    expect(run.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const usage = ctx.events
      .filter((event) => event.type === "context_usage")
      .at(-1)!.data;
    expect(usage.contextWindow).toBe(65536);
    expect(usage.advertisedContextWindow).toBe(1048576);
    expect(
      usage.reservedOutputTokens + usage.estimatedTokens + 2048,
    ).toBeLessThanOrEqual(65536);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_tokens).toBe(
      usage.reservedOutputTokens,
    );
    expect(ctx.execute).not.toHaveBeenCalled();
  });
  it("recovers from an endpoint context rejection without replaying browser tools", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(null, [call("first", "browser_snapshot", {})]),
      )
      .mockResolvedValueOnce(
        response(null, [call("click", "browser_click", { ref: "r1" })]),
      )
      .mockResolvedValueOnce(
        response(null, [call("last", "browser_snapshot", {})]),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "context_length_exceeded",
              message: "This request is longer than the model context window.",
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(response("Recovered and verified."));
    vi.stubGlobal("fetch", fetchMock);
    const learn = vi.fn();
    const ctx = setup({}, "", { learnContextBudget: learn });
    ctx.execute.mockResolvedValue({
      text: "Page data. ".repeat(1800),
      elements: [{ ref: "r1", name: "Button" }],
      url: "https://example.test",
      title: "Example",
    });
    const run = ctx.engine.start("Inspect, click, then verify.", 7);
    await until(() => !ctx.engine.activeRunId);
    expect(run.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(
      ctx.execute.mock.calls
        .filter((c) => c[0] !== "browser_screenshot")
        .map((c) => c[0]),
    ).toEqual(["browser_snapshot", "browser_click", "browser_snapshot"]);
    expect(
      ctx.events.filter((e) => e.type === "context_recovery"),
    ).toHaveLength(1);
    expect(
      ctx.events.some(
        (e) => e.type === "context_usage" && e.data.droppedMessages > 0,
      ),
    ).toBe(true);
    expect(learn).toHaveBeenCalled();
    const retry = JSON.parse(fetchMock.mock.calls[4][1].body);
    expect(retry.messages[1].content).toContain("Inspect, click, then verify.");
    expect(
      retry.messages.some((m: any) =>
        m.content?.startsWith?.("[Rove context checkpoint]"),
      ),
    ).toBe(true);
  });
  it("reduces old screenshots first without discarding text or lowering advertised context", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(null, [call("one", "browser_snapshot", {})]),
      )
      .mockResolvedValueOnce(
        response(null, [call("two", "browser_snapshot", {})]),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "context_length_exceeded",
              message: "Context length exceeded",
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(response("Recovered."));
    vi.stubGlobal("fetch", fetchMock);
    const learn = vi.fn(),
      ctx = setup({ vision: true }, "", { learnContextBudget: learn });
    ctx.execute.mockImplementation(async (name) =>
      name === "browser_screenshot"
        ? { tabId: 7, dataUrl: "data:image/png;base64," + "A".repeat(100000) }
        : { text: "Page data", elements: [{ ref: "button", name: "Button" }] },
    );
    const run = ctx.engine.start("Inspect two pages.", 7);
    await until(() => !ctx.engine.activeRunId);
    expect(run.status).toBe("completed");
    const retry = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(retry.messages.filter((m: any) => m.role === "tool")).toHaveLength(
      2,
    );
    expect(
      retry.messages
        .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
        .filter((p: any) => p.type === "image_url"),
    ).toHaveLength(1);
    expect(
      ctx.events.find((e) => e.type === "context_recovery")?.data.strategy,
    ).toBe("retain_latest_image");
    expect(
      ctx.events.filter((e) => e.type === "context_usage").at(-1)?.data
        .contextWindow,
    ).toBe(1048576);
    expect(learn).toHaveBeenCalledWith(expect.anything(), "", undefined, 1);
  });
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
    ctx.engine.setApprovalMode("never", run.id);
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
    ctx.engine.setApprovalMode("never", run.id);
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

  it("preserves arrays from tab inventories and page scripts, including nested arrays", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(null, [
          call("tabs", "browser_tabs", {}),
          call("headings", "browser_evaluate", {
            code: "return document.title",
          }),
        ]),
      )
      .mockResolvedValueOnce(response("Read."));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup({ disabledTools: [] });
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

  it("records effective run configuration without the model key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response("Done")));
    const ctx = setup({}, "private-model-key");
    ctx.engine.start("Record configuration", 7);
    await until(() => !ctx.engine.activeRunId);
    const configuration = ctx.events.find(
      (event) => event.type === "run_configuration",
    )!.data;
    expect(configuration.selectedTabId).toBe(7);
    expect(configuration.apiKeyConfigured).toBe(true);
    expect(configuration.settings.contextWindow).toBe(1048576);
    expect(configuration.settings.stream).toBe(true);
    expect(JSON.stringify(configuration)).not.toContain("private-model-key");
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
    await until(() => !ctx.engine.activeRunId);
    expect(ctx.execute).not.toHaveBeenCalled();
    expect(
      ctx.events.filter((e) => e.type === "tool_result")[0].data.error,
    ).toContain("HTTP(S)");
    expect(run.status).toBe("failed");
    expect(ctx.events.at(-1)?.data.message).toBe("Step limit reached.");
  });
});

describe("concurrent chats", () => {
  it("reports a tab lease collision as a tool error and lets both runs continue", async () => {
    const leases = new Map([[7, "owner"]]);
    const dispatch = vi.fn();
    const fetchMock = vi.fn((_url, init) => {
      const sent = JSON.parse(init.body);
      const isOwner = sent.messages[1].content.startsWith("owner");
      return Promise.resolve(isOwner
        ? response(null, [call("question", "ask_user", { question: "Wait here?" })])
        : sent.messages.some((message: any) => message.role === "tool")
          ? response("I will use another tab.")
          : response(null, [call("snapshot", "browser_snapshot", { tabId: 7 })]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup({}, "", {
      transportForRun: runId => ({
        status: () => ({ connected: true, tabs: [] }),
        execute: async (action, args) => {
          if (leases.has(args.tabId) && leases.get(args.tabId) !== runId)
            throw new Error(`Tab ${args.tabId} is owned by another task. Choose an unleased tab or navigate with newTab:true.`);
          dispatch(action, args);
          return {};
        },
      }),
    });
    const owner = ctx.engine.start("owner", 7, "owner");
    const other = ctx.engine.start("other", 8);
    await until(() => !ctx.engine.isActive(other.id));
    expect(other.status).toBe("completed");
    expect(other.events.find(event => event.type === "tool_result")?.data.error).toContain("owned by another task");
    expect(dispatch).not.toHaveBeenCalled();
    const retry = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))
      .find(body => body.messages.some((message: any) => message.role === "tool"));
    expect(JSON.parse(retry.messages.find((message: any) => message.role === "tool").content).error).toContain("owned by another task");
    expect(ctx.engine.isActive(owner.id)).toBe(true);
    ctx.engine.stop(owner.id);
  });

  it("does not emit old configuration after a stopped run's metadata resolves", async () => {
    let resolve!: (value: null) => void;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = setup({}, "", { resolveModel: () => new Promise(done => { resolve = done; }) });
    const run = ctx.engine.start("first", 7);
    await until(() => !!resolve);
    ctx.engine.stop(run.id);
    const count = run.events.length;
    resolve(null);
    await new Promise(done => setTimeout(done, 0));
    expect(run.events).toHaveLength(count);
    expect(run.events.at(-1)?.data.status).toBe("stopped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finishes runs independently and exposes the newest active run", async () => {
    const replies = new Map<string, (value: Response) => void>();
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise<Response>((resolve) => {
      const prompt = JSON.parse(init.body).messages.at(-1).content.split("\n")[0];
      replies.set(prompt, resolve);
    })));
    const ctx = setup();
    const first = ctx.engine.start("first", 7);
    const second = ctx.engine.start("second", 8);
    expect(ctx.engine.activeRunIds).toEqual([first.id, second.id]);
    expect(ctx.engine.activeRunId).toBe(second.id);
    expect(ctx.engine.selectedTabId).toBe(8);
    expect(ctx.engine.selectedTabFor(first.id)).toBe(7);
    await until(() => replies.size === 2);
    replies.get("second")!(response("Second done"));
    await until(() => !ctx.engine.isActive(second.id));
    expect(second.status).toBe("completed");
    expect(first.status).toBe("running");
    expect(ctx.engine.activeRunIds).toEqual([first.id]);
    expect(ctx.engine.activeRunId).toBe(first.id);
    expect(ctx.engine.selectedTabId).toBe(7);
    replies.get("first")!(response("First done"));
    await until(() => !ctx.engine.activeRunIds.length);
    expect(first.status).toBe("completed");
    expect(ctx.engine.activeRunId).toBeNull();
  });

  it("rejects a fourth run and rejects the same chat without disturbing other runs", async () => {
    const ctx = setup();
    const first = ctx.engine.start("first");
    const second = ctx.engine.start("second");
    expect(() => ctx.engine.continue(first, "again")).toThrow("current response");
    // Even a stale terminal record must not bypass the identity check in begin().
    expect(() => ctx.engine.restart({ ...first, status: "completed" }, "edit")).toThrow("current response");
    const third = ctx.engine.start("third");
    expect(() => ctx.engine.start("fourth")).toThrow("Up to 3 tasks can run at once.");
    for (const run of [first, second, third]) ctx.engine.stop(run.id);
    expect(ctx.engine.activeRunIds).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it("changes one run's approval mode and changes defaults only for new runs", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      const sent = JSON.parse(init.body);
      return Promise.resolve(sent.messages.some((m: any) => m.role === "tool")
        ? response("Done") : response(null, [call("click", "browser_click", { x: 10, y: 10 })]));
    }));
    const ctx = setup({ approvalMode: "always" });
    const first = ctx.engine.start("first", 7);
    const second = ctx.engine.start("second", 8);
    await until(() => [first, second].every(run => run.status === "awaiting_approval"));
    expect(first.events.find(event => event.type === "approval_required")?.data.args).toEqual({ tabId: 7, x: 10, y: 10 });
    expect(second.events.find(event => event.type === "approval_required")?.data.args).toEqual({ tabId: 8, x: 10, y: 10 });
    ctx.engine.setApprovalMode("never");
    expect(first.status).toBe("awaiting_approval");
    expect(second.status).toBe("awaiting_approval");
    const third = ctx.engine.start("third", 9);
    await until(() => !ctx.engine.isActive(third.id));
    expect(third.events.some(event => event.type === "approval_required")).toBe(false);
    ctx.engine.setApprovalMode("never", first.id);
    await until(() => !ctx.engine.isActive(first.id));
    expect(second.status).toBe("awaiting_approval");
    expect(second.events.some(event => event.type === "approval_decision")).toBe(false);
    const pending = second.events.findLast(event => event.type === "approval_required")!;
    expect(() => ctx.engine.approve(second.id, first.events.find(event => event.type === "approval_required")!.data.id, true)).toThrow();
    ctx.engine.approve(second.id, pending.data.id, false);
    await until(() => !ctx.engine.activeRunIds.length);
  });

  it("rejects stale approval IDs after stopping and continuing the same chat", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response(null, [call("click", "browser_click", { x: 10, y: 10 })])));
    const ctx = setup({ approvalMode: "always" });
    const first = ctx.engine.start("first", 7);
    await until(() => first.status === "awaiting_approval");
    const stale = first.events.findLast(event => event.type === "approval_required")!.data.id;
    ctx.engine.stop(first.id);
    expect(() => ctx.engine.approve(first.id, stale, true)).toThrow("not active");
    const next = ctx.engine.continue(first, "continue", 7);
    await until(() => next.status === "awaiting_approval");
    expect(() => ctx.engine.approve(next.id, stale, true)).toThrow();
    expect(next.status).toBe("awaiting_approval");
    expect(ctx.execute).not.toHaveBeenCalled();
    ctx.engine.stop(next.id);
  });

  it("snapshots settings synchronously in begin, separately for each run", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response("Done"));
    vi.stubGlobal("fetch", fetchMock);
    const metadata: Settings[] = [];
    let key = "first-secret";
    const ctx = setup({ memory: "original note", reasoningEffort: "low" }, "", {
      getApiKey: () => key,
      resolveModel: async settings => { metadata.push(structuredClone(settings)); return null; },
    });
    const first = ctx.engine.start("first");
    Object.assign(ctx.settings, { model: "second-model", memory: "new note", reasoningEffort: "high", baseUrl: "https://second.example/v1" });
    key = "second-secret";
    const second = ctx.engine.start("second");
    key = "later-secret";
    ctx.settings.memory = "later edit";
    await until(() => !ctx.engine.activeRunIds.length);
    expect(metadata.map(settings => [settings.model, settings.memory, settings.reasoningEffort])).toEqual([
      ["test", "original note", "low"], ["second-model", "new note", "high"],
    ]);
    expect(first.events.find(event => event.type === "run_configuration")!.data.settings.memory).toBe("original note");
    expect(second.events.find(event => event.type === "run_configuration")!.data.settings.memory).toBe("new note");
    const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(requests.map(request => request.model)).toEqual(["test", "second-model"]);
    expect(requests[0].messages[0].content).toContain("original note");
    expect(requests[1].messages[0].content).toContain("new note");
    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual(["Bearer first-secret", "Bearer second-secret"]);
    for (const run of [first, second]) expect(JSON.stringify(run.events)).not.toMatch(/first-secret|second-secret|later-secret/);
  });
});

describe("tool registry", () => {
  it("validates builtin arguments and enforces disabled tools before dispatch", async () => {
    const ctx = setup();
    const signal = new AbortController().signal;
    await expect(
      executeTool(
        "browser_navigate",
        { url: 2 },
        ctx.settings,
        ctx.transport,
        signal,
      ),
    ).rejects.toThrow("Invalid arguments");
    await executeTool(
      "browser_navigate",
      { url: "https://example.com" },
      ctx.settings,
      ctx.transport,
      signal,
    );
    expect(ctx.execute).toHaveBeenCalledWith(
      "browser_navigate",
      { url: "https://example.com" },
      signal,
    );
    ctx.settings.disabledTools.push("browser_navigate");
    expect(
      getTools(ctx.settings).some((tool) => tool.name === "browser_navigate"),
    ).toBe(false);
    await expect(
      executeTool(
        "browser_navigate",
        { url: "https://example.com" },
        ctx.settings,
        ctx.transport,
        signal,
      ),
    ).rejects.toThrow("disabled");
    await expect(
      executeTool(
        "removed_custom_tool",
        {},
        ctx.settings,
        ctx.transport,
        signal,
      ),
    ).rejects.toThrow("unavailable");
  });
});
