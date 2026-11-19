import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import type { RunRecord, Settings } from "../../shared/types";

const fixture = vi.hoisted(() => ({
  notify: (_type: string, _data: any) => {},
  flush: vi.fn(async () => {}),
  detachAll: vi.fn(async () => {}),
  releaseTab: vi.fn(async (_id: number) => true),
  prepare: vi.fn(async (id: number, claim: (id: number) => void) => { claim(id); return { tabId: id }; }),
  perform: vi.fn(async (_action: string, args: any, claim: (id: number) => void) => { claim(args.tabId); return { tabId: args.tabId }; }),
  tabs: [] as { id: number; url: string; title: string; windowId: number }[],
}));
vi.mock("../../extension-src/browser.js", () => ({
  setNotifier: (notify: typeof fixture.notify) => { fixture.notify = notify; },
  listTabs: async () => structuredClone(fixture.tabs),
  isBlankPage: (url: string) => ["about:blank", "chrome://newtab/"].includes(url),
  prepareRun: fixture.prepare,
  configureBrowser: () => {},
  groupTab: async () => {},
  forgetGroup: () => {},
  releaseTab: fixture.releaseTab,
  detachAll: fixture.detachAll,
  hasPendingDialogs: () => false,
  recoverSessions: async () => {},
  perform: (...args: [string, any, (id: number) => void]) => fixture.perform(...args),
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
    reload = async () => {};
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
let tabRemoved: (tabId: number) => void = () => {};
let tabCreated: (tab: Partial<chrome.tabs.Tab>) => void = () => {};
let openTabs: number[] = [];
let storage: Record<string, any> = {};
let actionClicked: (tab: { id?: number }) => void = () => {};
const sidePanel = { setPanelBehavior: vi.fn(async (_: any) => {}), setOptions: vi.fn(async (_: any) => {}), open: vi.fn(async (_: any) => {}) };
const reload = vi.fn();
beforeEach(async () => {
  openTabs = [7, 8, 9];
  fixture.tabs = [7, 8, 9].map(id => ({ id, url: "https://example.com", title: "Page", windowId: 1 }));
  vi.resetModules();
  vi.clearAllMocks();
  fixture.perform.mockImplementation(async (_action, args, claim) => { claim(args.tabId); return { tabId: args.tabId }; });
  fixture.flush.mockImplementation(async () => {});
  fixture.prepare.mockImplementation(async (id, claim) => { claim(id); return { tabId: id }; });
  storage = {};
  const area = {
    setAccessLevel: async () => {},
    get: async (keys?: string | string[]) => {
      if (keys === undefined) return structuredClone(storage);
      const wanted = typeof keys === "string" ? [keys] : keys;
      return structuredClone(Object.fromEntries(Object.entries(storage).filter(([key]) => wanted.includes(key))));
    },
    set: async (data: any) => { Object.assign(storage, structuredClone(data)); },
    remove: async (key: string) => { delete storage[key]; },
  };
  vi.stubGlobal("chrome", {
    storage: { local: area, session: area },
    sidePanel,
    action: { onClicked: { addListener: (listener: typeof actionClicked) => { actionClicked = listener; } } },
    tabs: {
      onRemoved: { addListener: (listener: (tabId: number) => void) => { tabRemoved = listener; } },
      onCreated: { addListener: (listener: typeof tabCreated) => { tabCreated = listener; } },
      query: async () => openTabs.map((id) => ({ id })),
      get: async (id: number) => { if (!openTabs.includes(id)) throw new Error(`No tab with id: ${id}.`); return { id }; },
    },
    runtime: {
      id: "rove", getURL: (path: string) => "chrome-extension://rove/" + path,
      getPlatformInfo: vi.fn(async () => ({})),
      getManifest: () => ({ version: "9.9.9" }),
      reload,
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

  it("closing Chrome's debugging bar leaves every active run going by default", async () => {
    const first = await start("first", 7), second = await start("second", 8);
    fixture.notify("browser_notice", { event: "detached", tabId: 99, reason: "canceled_by_user" });
    expect((await rpc("/api/state")).activeRunIds).toEqual([first.id, second.id]);
    for (const run of [first, second]) expect((await rpc(`/api/runs/${run.id}`)).status).toBe("awaiting_approval");
  });

  it("banner cancellation stops every active run, even from a nonselected tab, when keeping going is off", async () => {
    const settings = (await rpc("/api/state")).settings;
    await rpc("/api/settings", "PUT", { ...settings, keepGoingOnBarClose: false });
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

describe("chat shown per tab", () => {
  it("binds the tab a task works in, accepts explicit choices, and forgets closed tabs", async () => {
    const run = await start("on tab seven", 7);
    expect((await rpc("/api/state")).tabChats).toEqual({ "7": run.id });
    await rpc("/api/tab-chat", "PUT", { tabId: 8, runId: run.id });
    await rpc("/api/tab-chat", "PUT", { tabId: 9, runId: "" });
    expect((await rpc("/api/state")).tabChats).toEqual({ "7": run.id, "8": run.id, "9": "" });
    tabRemoved(7);
    expect((await rpc("/api/state")).tabChats).toEqual({ "8": run.id, "9": "" });
    expect((await raw("/api/tab-chat", "PUT", { tabId: 8, runId: "missing" })).error).toBe("Chat not found.");
    expect((await raw("/api/tab-chat", "PUT", { tabId: 70, runId: "" })).ok).toBe(false);
    expect((await raw("/api/tab-chat", "PUT", { tabId: 8, runId: "", extra: 1 })).ok).toBe(false);
  });
  it("explains a busy tab in plain words when another chat starts on it", async () => {
    fixture.prepare.mockImplementation(async (id, claim) => { claim(id); return { tabId: id }; });
    await start("first", 7);
    const second = await raw("/api/runs", "POST", { prompt: "second", tabId: 7 });
    expect(second.ok).toBe(false);
    expect(second.error).toBe("Another Rove task is working in this tab. Wait for it to finish or stop it, or choose New Tab in the tab picker.");
  });
});

describe("which tab a task works in", () => {
  const reply = (calls: { name: string; args: unknown }[]) => new Response(JSON.stringify({ choices: [{ message: {
    role: "assistant", content: null,
    tool_calls: calls.map((call, index) => ({ id: `call-${index}-${Math.random()}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
  } }] }));
  /** The model makes these tool calls in its first turn, then waits on a question. */
  function script(calls: { name: string; args: unknown }[]) {
    let turn = 0;
    vi.stubGlobal("fetch", vi.fn(async () => turn++ === 0 ? reply(calls) : reply([{ name: "ask_user", args: { question: "Wait?" } }])));
  }
  const navigations = () => fixture.perform.mock.calls.filter(([action]) => action === "browser_navigate").map(([, args]) => args);

  it("New Tab mode beside an empty tab hands that tab to the first new-tab navigation only", async () => {
    fixture.tabs.push({ id: 10, url: "chrome://newtab/", title: "New Tab", windowId: 1 });
    fixture.perform.mockImplementation(async (action, args, claim) => {
      const tabId = args.reuseTabId ?? (args.newTab ? 20 : args.tabId);
      claim(tabId);
      return { tabId };
    });
    script([{ name: "browser_navigate", args: { url: "https://example.com/a", newTab: true } }, { name: "browser_navigate", args: { url: "https://example.com/b", newTab: true } }]);
    const run = await rpc("/api/runs", "POST", { prompt: "go", tabId: null, reuseTabId: 10 });
    await vi.waitFor(async () => expect((await rpc(`/api/runs/${run.id}`)).status).toBe("awaiting_approval"));
    expect(navigations()).toEqual([
      { url: "https://example.com/a", newTab: true, reuseTabId: 10 },
      { url: "https://example.com/b", newTab: true },
    ]);
    expect((await rpc("/api/state")).tabChats["10"]).toBe(run.id);
  });
  it.each([
    ["an ordinary page", 7],
    ["a tab that is not open", 99],
  ])("New Tab mode beside %s opens a new tab as before", async (_label, reuseTabId) => {
    script([{ name: "browser_navigate", args: { url: "https://example.com/a", newTab: true } }]);
    const run = await rpc("/api/runs", "POST", { prompt: "go", tabId: null, reuseTabId });
    await vi.waitFor(async () => expect((await rpc(`/api/runs/${run.id}`)).status).toBe("awaiting_approval"));
    expect(navigations()).toEqual([{ url: "https://example.com/a", newTab: true }]);
  });
  it("a chosen tab ignores the empty-tab hint", async () => {
    fixture.tabs.push({ id: 10, url: "chrome://newtab/", title: "New Tab", windowId: 1 });
    script([{ name: "browser_navigate", args: { url: "https://example.com/a", newTab: true } }]);
    const run = await rpc("/api/runs", "POST", { prompt: "go", tabId: 7, reuseTabId: 10 });
    await vi.waitFor(async () => expect((await rpc(`/api/runs/${run.id}`)).status).toBe("awaiting_approval"));
    expect(navigations()).toEqual([{ url: "https://example.com/a", newTab: true }]);
  });
  it("a tab a click opens belongs to the task at once and the click reports it; the user's own new tab does not", async () => {
    fixture.perform.mockImplementation(async (action, args, claim) => {
      claim(args.tabId);
      if (action === "browser_click") {
        tabCreated({ id: 11, windowId: 1, pendingUrl: "https://example.com/opened", groupId: -1 });
        tabCreated({ id: 12, windowId: 1, pendingUrl: "chrome://newtab/", groupId: -1 });
        tabCreated({ id: 13, windowId: 2, pendingUrl: "https://example.com/elsewhere", groupId: -1 });
      }
      return { clicked: true, tabId: args.tabId };
    });
    script([{ name: "browser_click", args: { tabId: 7, x: 5, y: 5 } }]);
    const run = await rpc("/api/runs", "POST", { prompt: "click", tabId: 7 });
    await vi.waitFor(async () => expect((await rpc(`/api/runs/${run.id}`)).status).toBe("awaiting_approval"));
    const chats = (await rpc("/api/state")).tabChats;
    expect(chats["11"]).toBe(run.id);
    expect(chats["12"]).toBeUndefined();
    expect(chats["13"]).toBeUndefined();
    const result = (await rpc(`/api/runs/${run.id}`)).events.find((event: any) => event.type === "tool_result" && event.data.name === "browser_click");
    expect(result.data.result).toMatchObject({ clicked: true, tabId: 7, openedTabs: [11] });
  });
  it("tabs opened while no task acts, or by reads, stay the user's", async () => {
    fixture.perform.mockImplementation(async (action, args, claim) => {
      claim(args.tabId);
      if (action === "browser_snapshot") tabCreated({ id: 11, windowId: 1, pendingUrl: "https://example.com/opened", groupId: -1 });
      return { tabId: args.tabId };
    });
    script([{ name: "browser_snapshot", args: { tabId: 7 } }]);
    const run = await rpc("/api/runs", "POST", { prompt: "read", tabId: 7 });
    await vi.waitFor(async () => expect((await rpc(`/api/runs/${run.id}`)).status).toBe("awaiting_approval"));
    tabCreated({ id: 14, windowId: 1, pendingUrl: "https://example.com/later", groupId: -1 });
    const chats = (await rpc("/api/state")).tabChats;
    expect(chats["11"]).toBeUndefined();
    expect(chats["14"]).toBeUndefined();
  });
});

describe("side panel per tab", () => {
  it("is off by default and opens only on the tab whose toolbar button was clicked", async () => {
    expect(sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
    expect(sidePanel.setOptions).toHaveBeenCalledWith({ enabled: false });
    sidePanel.setOptions.mockClear();
    actionClicked({ id: 8 });
    expect(sidePanel.setOptions).toHaveBeenCalledWith({ tabId: 8, path: "index.html", enabled: true });
    expect(sidePanel.open).toHaveBeenCalledWith({ tabId: 8 });
    // Enabled before it opens, and both inside the click (no await in between).
    expect(sidePanel.setOptions.mock.invocationCallOrder[0]).toBeLessThan(sidePanel.open.mock.invocationCallOrder[0]);
  });
});

describe("web search", () => {
  const settingsWith = async (patch: Record<string, unknown>) => ({ ...(await rpc("/api/settings")).settings, ...patch });
  it("needs a saved key before a search API can be chosen, then searches with it and drops blocked sites", async () => {
    const refused = await raw("/api/settings", "PUT", await settingsWith({ webSearch: "exa" }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("Add an API key for Exa");
    const keyed = await rpc("/api/search-key", "PUT", { provider: "exa", apiKey: " exa-secret-123 " });
    expect(keyed.searchKeys).toEqual({ exa: true, tavily: false, parallel: false });
    expect(storage.searchApiKeys).toEqual({ exa: "exa-secret-123" });
    await rpc("/api/settings", "PUT", await settingsWith({ webSearch: "exa", siteRules: [{ pattern: "blocked.example", action: "block" }] }));
    expect((await rpc("/api/state")).searchKeys.exa).toBe(true);
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ results: [
      { title: "Kept", url: "https://kept.example/a", highlights: ["first", "second"], publishedDate: "2026-11-01T00:00:00Z" },
      { title: "Blocked", url: "https://www.blocked.example/b", text: "hidden" },
    ] })));
    const found = await rpc("/api/browser", "POST", { action: "web_search", args: { query: "rove", maxResults: 3 } });
    const [url, init] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(url).toBe("https://api.exa.ai/search");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("exa-secret-123");
    expect(JSON.parse(String(init!.body))).toMatchObject({ query: "rove", numResults: 3 });
    expect(found).toEqual({
      provider: "Exa", query: "rove", blockedResults: 1,
      results: [{ title: "Kept", url: "https://kept.example/a", published: "2026-11-01", excerpt: "first … second" }],
    });
  });
  it("a restored search API without its key here is turned off", async () => {
    const backup = await rpc("/api/backup");
    backup.storage.settings = { ...backup.storage.settings, webSearch: "parallel" };
    await rpc("/api/backup", "POST", backup);
    expect((await rpc("/api/state")).settings.webSearch).toBe("off");
  });
  it("clearing a key removes it, and the tool reports search as off when no API is chosen", async () => {
    await rpc("/api/search-key", "PUT", { provider: "tavily", apiKey: "tvly-1" });
    await rpc("/api/search-key", "PUT", { provider: "tavily", apiKey: "" });
    expect(storage.searchApiKeys).toEqual({});
    const off = await raw("/api/browser", "POST", { action: "web_search", args: { query: "rove" } });
    expect(off.ok).toBe(false);
    expect(off.error).toContain("Web search is off");
  });
});

describe("settings backup", () => {
  it("leaves the keys out unless asked, restores a backup in place, and rejects other files", async () => {
    await rpc("/api/settings", "PUT", { ...(await rpc("/api/settings")).settings, apiKey: "model-key" });
    await rpc("/api/search-key", "PUT", { provider: "exa", apiKey: "exa-key" });
    storage.shortcuts = [{ id: "a", name: "Daily", prompt: "Check news" }];
    const plain = await rpc("/api/backup");
    expect(plain).toMatchObject({ format: "rove-settings-backup", version: 1, app: "9.9.9", includesKeys: false });
    expect(plain.storage.shortcuts).toEqual(storage.shortcuts);
    expect(plain.storage).not.toHaveProperty("modelApiKey");
    expect(plain.storage).not.toHaveProperty("searchApiKeys");
    const full = await rpc("/api/backup?keys=1");
    expect(full.storage).toMatchObject({ modelApiKey: "model-key", searchApiKeys: { exa: "exa-key" } });

    expect((await raw("/api/backup", "POST", { format: "something-else", version: 1, storage: {} })).ok).toBe(false);
    const broken = await raw("/api/backup", "POST", { ...full, storage: { ...full.storage, settings: { baseUrl: "not a url" } } });
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain("not valid");

    const restored = { ...plain, storage: { ...plain.storage, settings: { ...plain.storage.settings, systemPrompt: "Restored prompt", webSearch: "exa" }, unknownKey: 1 } };
    const answer = await rpc("/api/backup", "POST", restored);
    expect(answer.ok).toBe(true);
    // The worker takes the restored settings at once, without restarting the extension.
    expect(answer.settings).toMatchObject({ systemPrompt: "Restored prompt", webSearch: "exa" });
    expect((await rpc("/api/state")).settings.systemPrompt).toBe("Restored prompt");
    expect(storage).not.toHaveProperty("unknownKey");
    // A backup without keys keeps the ones already saved.
    expect(storage.modelApiKey).toBe("model-key");
    expect((await rpc("/api/state")).searchKeys.exa).toBe(true);
    expect(reload).not.toHaveBeenCalled();

    // The same backup with the provider moved to another address: the key saved here stays behind.
    const moved = structuredClone(plain);
    moved.storage.modelProviders = moved.storage.modelProviders.map((profile: any) => ({ ...profile, baseUrl: "https://elsewhere.example/v1" }));
    moved.storage.settings = { ...moved.storage.settings, baseUrl: "https://elsewhere.example/v1" };
    await rpc("/api/backup", "POST", moved);
    expect(storage.modelApiKey).toBe("");
    expect(Object.values(storage.modelProviderKeys)).not.toContain("model-key");
    expect((await rpc("/api/state")).hasApiKey).toBe(false);
  });
});
