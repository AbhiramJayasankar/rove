import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import type { RunRecord, Settings } from "../../shared/types";

const fixture = vi.hoisted(() => ({
  notify: (_type: string, _data: any) => {},
  flush: vi.fn(async () => {}),
  detachAll: vi.fn(async () => {}),
  releaseTab: vi.fn(async (_id: number) => true),
  prepare: vi.fn(async (id: number, claim: (id: number) => void) => { claim(id); return { tabId: id }; }),
}));
vi.mock("../../extension-src/browser.js", () => ({
  setNotifier: (notify: typeof fixture.notify) => { fixture.notify = notify; },
  listTabs: async () => [7, 8, 9].map(id => ({ id, url: "https://example.com", title: "Page" })),
  prepareRun: fixture.prepare,
  releaseTab: fixture.releaseTab,
  detachAll: fixture.detachAll,
  hasPendingDialogs: () => false,
  recoverSessions: async () => {},
  perform: async (_action: string, args: any, claim: (id: number) => void) => { claim(args.tabId); return { tabId: args.tabId }; },
}));
vi.mock("../../extension-src/store", () => ({
  ExtensionStore: class {
    settings: Settings = { ...structuredClone(DEFAULT_SETTINGS), model: "fixture", approvalMode: "never" };
    runs = new Map<string, RunRecord>();
    init = async () => {};
    flush = fixture.flush;
    hasRun(id: string) { return this.runs.has(id); }
    summaries() { return [...this.runs.values()].map(run => ({ ...run, events: [] })); }
    getRun = async (id: string) => structuredClone(this.runs.get(id));
    saveRun(run: RunRecord) {
      this.runs.set(run.id, structuredClone({ ...run, events: [...(this.runs.get(run.id)?.events ?? []), ...run.events] }));
    }
    saveSettings = async (settings: Settings) => { this.settings = structuredClone(settings); };
  },
}));
vi.mock("../catalogue", async importOriginal => ({
  ...await importOriginal<typeof import("../catalogue")>(),
  ModelCatalogue: class {
    init = async () => {};
    flush = async () => {};
    resolve = async () => null;
    peek = () => null;
  },
}));

let onMessage: (message: any, sender: any, reply: (data: any) => void) => void;
async function raw(path: string, method = "GET", body = {}): Promise<any> {
  return new Promise(resolve => onMessage({ type: "rove-api", path, method, body }, { id: "rove", url: "chrome-extension://rove/index.html" }, resolve));
}
async function rpc(path: string, method = "GET", body = {}): Promise<any> {
  const result = await raw(path, method, body);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function start(prompt: string, tabId: number | null) {
  const run = await rpc("/api/runs", "POST", { prompt, tabId });
  await vi.waitFor(async () => expect((await rpc(`/api/runs/${run.id}`)).status).toBe("awaiting_approval"));
  return run;
}
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.flush.mockImplementation(async () => {});
  fixture.prepare.mockImplementation(async (id, claim) => { claim(id); return { tabId: id }; });
  const storage: Record<string, any> = {};
  const area = {
    setAccessLevel: async () => {},
    get: async () => structuredClone(storage),
    set: async (data: any) => { Object.assign(storage, structuredClone(data)); },
    remove: async (key: string) => { delete storage[key]; },
  };
  vi.stubGlobal("chrome", {
    storage: { local: area, session: area },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: {
      id: "rove", getURL: (path: string) => "chrome-extension://rove/" + path,
      getPlatformInfo: vi.fn(async () => ({})),
      onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
      onConnect: { addListener: () => {} },
    },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
    role: "assistant", content: null,
    tool_calls: [{ id: "question", type: "function", function: { name: "ask_user", arguments: '{"question":"Wait?"}' } }],
  } }] }))));
  await import("../../extension-src/runtime");
  await rpc("/api/state");
});
afterEach(async () => {
  for (const id of (await rpc("/api/state")).activeRunIds) await rpc(`/api/runs/${id}/stop`, "POST");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("attachment route validation", () => {
  const text = { name: "notes.txt", kind: "text", mime: "text/plain", size: 5, text: "hello" };
  const image = { name: "pixel.png", kind: "image", mime: "image/png", size: 1, dataUrl: "data:image/png;base64,YQ==" };
  it.each([
    ["too many files", Array(6).fill(text), "At most 5 attachments"],
    ["oversize text", [{ ...text, text: "x".repeat(200_001) }], "200,000 characters"],
    ["oversize image", [{ ...image, dataUrl: "data:image/png;base64," + "A".repeat(6_000_000) }], "6,000,000 characters"],
    ["wrong image MIME", [{ ...image, mime: "image/svg+xml" }], "mime"],
    ["wrong kind", [{ ...text, kind: "audio" }], "kind"],
    ["empty name", [{ ...text, name: "   " }], "Attachment names cannot be empty"],
    ["negative size", [{ ...text, size: -1 }], "size"],
    ["fractional size", [{ ...text, size: 0.5 }], "size"],
    ["missing text", [{ name: "empty.txt", kind: "text", mime: "text/plain", size: 1 }], "text"],
    ["MIME mismatch", [{ ...image, dataUrl: "data:image/gif;base64,YQ==" }], "matching their MIME type"],
    ["non-base64 URL", [{ ...image, dataUrl: "https://example.com/image.png" }], "base64 data URLs"],
    ["invalid base64", [{ ...image, dataUrl: "data:image/png;base64,!!!=" }], "base64 data URLs"],
    ["empty base64", [{ ...image, dataUrl: "data:image/png;base64," }], "base64 data URLs"],
  ])("rejects %s on both message routes", async (_name, attachments, error) => {
    for (const [path, message] of [["/api/runs", { prompt: "Read" }], ["/api/runs/missing/messages", { message: "Read" }]] as const) {
      const result = await raw(path, "POST", { ...message, attachments, tabId: null });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(error);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("truncates display names and accepts the supported image formats", async () => {
    const attachments = [text, ...["png", "jpeg", "webp", "gif"].map(format => ({
      ...image, mime: `image/${format}`, dataUrl: `data:image/${format};base64,YQ==`, name: "n".repeat(130),
    }))];
    const run = await rpc("/api/runs", "POST", { prompt: "Read", tabId: null, attachments });
    const saved = (await rpc(`/api/runs/${run.id}`)).events.filter((event: any) => event.type === "attachment");
    expect(saved.map((event: any) => event.data.name)).toEqual(["notes.txt", ...Array(4).fill("n".repeat(120))]);
  });

  it("rejects attachments supplied with an edit target", async () => {
    const result = await raw("/api/runs/missing/messages", "POST", { message: "Edit", editMessageId: 0, attachments: [text], tabId: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Attachments cannot be supplied when editing");
  });
});

describe("concurrent runtime lifecycle", () => {
  it("does not count a model connection probe against the three task slots", async () => {
    await start("first", null);
    await start("second", null);
    const fetchTask = vi.mocked(fetch).getMockImplementation()!;
    let answer!: () => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const body = JSON.parse(String(init!.body));
      if (body.tools[0]?.function.name !== "rove_connection_check") return fetchTask(input, init);
      return new Promise(resolve => { answer = () => resolve(new Response(JSON.stringify({ choices: [{ message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "check", type: "function", function: { name: "rove_connection_check", arguments: '{"status":"ok"}' } }],
      } }] }))); });
    });
    const probe = raw("/api/model/test", "POST");
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    try {
      await start("third", null);
      expect((await rpc("/api/state")).activeRunIds).toHaveLength(3);
    } finally { answer(); }
    expect((await probe).ok).toBe(true);
    expect(fixture.detachAll).not.toHaveBeenCalled();
  });

  it("keeps one interval until the last run terminates, including New Tab mode", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const first = await start("first", null), second = await start("second", null);
    const keepAlive = intervals.mock.results[0].value;
    expect(intervals.mock.calls.filter(([, delay]) => delay === 20000)).toHaveLength(1);
    await rpc(`/api/runs/${first.id}/stop`, "POST");
    expect(clear).not.toHaveBeenCalledWith(keepAlive);
    expect((await rpc("/api/state")).activeRunIds).toEqual([second.id]);
    await rpc(`/api/runs/${second.id}/stop`, "POST");
    expect(clear).toHaveBeenCalledWith(keepAlive);
  });

  it("banner cancellation stops every active run even from a nonselected tab", async () => {
    const first = await start("first", 7), second = await start("second", 8);
    fixture.notify("browser_notice", { event: "detached", tabId: 99, reason: "canceled_by_user" });
    expect((await rpc("/api/state")).activeRunIds).toEqual([]);
    for (const run of [first, second]) expect((await rpc(`/api/runs/${run.id}`)).status).toBe("stopped");
  });

  it("tab loss affects only its lease owner; timeouts and unrelated tabs leave others active", async () => {
    const first = await start("first", 7), second = await start("second", 8);
    for (const [tabId, reason] of [[7, "command_timeout"], [99, "connection_lost"], [8, "other_reason"]])
      fixture.notify("browser_notice", { event: "detached", tabId, reason });
    expect((await rpc("/api/state")).activeRunIds).toEqual([first.id, second.id]);
    fixture.notify("browser_notice", { event: "detached", tabId: 7, reason: "connection_lost" });
    expect((await rpc("/api/state")).activeRunIds).toEqual([second.id]);
    await vi.waitFor(() => expect(fixture.releaseTab).toHaveBeenCalledWith(7));
    expect(fixture.releaseTab).not.toHaveBeenCalledWith(8);
    expect(fixture.detachAll).not.toHaveBeenCalled();
    fixture.notify("browser_notice", { event: "detached", tabId: 8, reason: "target_closed" });
    expect((await rpc("/api/state")).activeRunIds).toEqual([]);
  });

  it("counts pending admissions before starting model work", async () => {
    let prepare!: () => void;
    fixture.prepare.mockImplementationOnce(async (id, claim) => {
      claim(id);
      await new Promise<void>(resolve => { prepare = resolve; });
      return { tabId: id };
    });
    const pending = rpc("/api/runs", "POST", { prompt: "admitting", tabId: 7 });
    await vi.waitFor(() => expect(prepare).toBeTypeOf("function"));
    const second = rpc("/api/runs", "POST", { prompt: "second", tabId: null });
    const third = rpc("/api/runs", "POST", { prompt: "third", tabId: null });
    try {
      await vi.waitFor(async () => expect((await rpc("/api/state")).activeRunIds).toHaveLength(2));
      expect((await raw("/api/runs", "POST", { prompt: "fourth", tabId: null })).error).toBe("Up to 3 tasks can run at once.");
      expect((await raw("/api/settings", "PUT", DEFAULT_SETTINGS)).error).toBe("Stop the active tasks before changing settings.");
    } finally { prepare(); }
    await Promise.all([pending, second, third]);
    expect((await rpc("/api/state")).activeRunIds).toHaveLength(3);
  });
});
