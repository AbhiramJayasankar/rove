import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

let browser: typeof import("../../extension-src/browser.js");
let connected: boolean;
let events: (source: any, method: string, params: any) => void;
let detached: (source: any, reason: string) => void;
let send: ReturnType<typeof vi.fn>;
let attach: ReturnType<typeof vi.fn>;
let detach: ReturnType<typeof vi.fn>;
let notices: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  connected = false;
  attach = vi.fn(async () => {
    connected = true;
  });
  detach = vi.fn(async () => {
    connected = false;
  });
  send = vi.fn(async () => {
    if (!connected)
      throw new Error("Debugger is not attached to the tab with id: 7.");
    return {};
  });
  const tab = { id: 7, url: "https://example.com", title: "Fixture" };
  vi.stubGlobal("chrome", {
    runtime: { id: "relay" },
    tabs: {
      update: vi.fn(async () => tab),
      get: vi.fn(async () => tab),
      query: vi.fn(async () => [tab]),
      remove: vi.fn(async () => {
        connected = false;
        detached({ tabId: 7 }, "target_closed");
      }),
      onCreated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
    },
    debugger: {
      attach,
      detach,
      sendCommand: send,
      onEvent: {
        addListener: (callback: typeof events) => {
          events = callback;
        },
      },
      onDetach: {
        addListener: (callback: typeof detached) => {
          detached = callback;
        },
      },
    },
  });
  browser = await import("../../extension-src/browser.js");
  notices = vi.fn();
  browser.setNotifier(notices);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("debugger lifecycle", () => {
  it("wakes the selected tab before renderer initialization", async () => {
    let awake = false;
    vi.mocked(chrome.tabs.update).mockImplementation(async () => {
      awake = true;
      return {} as chrome.tabs.Tab;
    });
    send.mockImplementation(async (_target, method) => {
      if (method === "Page.enable" && !awake)
        throw new Error("Renderer is frozen");
      return {};
    });
    await expect(browser.prepareRun(7)).resolves.toMatchObject({ tabId: 7 });
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
  });
  it("preserves the Page.enable timeout instead of masking it with a later missing session", async () => {
    vi.useFakeTimers();
    send.mockImplementation(async (_target, method) =>
      method === "Page.enable" ? new Promise(() => {}) : {},
    );
    const run = browser.prepareRun(7);
    const rejected = expect(run).rejects.toThrow(
      "Chrome timed out during Page.enable",
    );
    await vi.advanceTimersByTimeAsync(16000);
    await rejected;
    expect(send.mock.calls.some((call) => call[1] === "Runtime.enable")).toBe(
      false,
    );
  });
  it("ignores a delayed detach event from the previous client during fresh initialization", async () => {
    send.mockImplementation(async (_target, method) => {
      if (method === "Page.enable") {
        // Chrome delivers the old client's detach after a new attach resolved.
        // The new client is still connected, so the notification is stale.
        queueMicrotask(() => detached({ tabId: 7 }, "canceled_by_user"));
      }
      return {};
    });
    await expect(browser.prepareRun(7)).resolves.toMatchObject({ tabId: 7 });
    expect(connected).toBe(true);
    expect(
      notices.mock.calls.some((call) => call[1]?.event === "detached"),
    ).toBe(false);
  });
  it("still reports a genuine idle disconnect without automatically reattaching", async () => {
    await browser.prepareRun(7);
    connected = false;
    detached({ tabId: 7 }, "canceled_by_user");
    await vi.waitFor(() =>
      expect(
        notices.mock.calls.filter((call) => call[1]?.event === "detached"),
      ).toHaveLength(1),
    );
    expect(attach).toHaveBeenCalledTimes(1);
    expect(connected).toBe(false);
  });
  it("repairs a stale attachment before a new task dispatches any action", async () => {
    await browser.prepareRun(7);
    connected = false; // Chrome can detach without delivering onDetach.
    await expect(browser.prepareRun(7)).resolves.toMatchObject({ tabId: 7 });
    expect(attach).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.every((call) => !String(call[1]).startsWith("Input.")),
    ).toBe(true);
  });
  it("resets only an existing client owned by this extension", async () => {
    connected = true;
    attach.mockRejectedValueOnce(
      new Error("Another debugger is already attached"),
    );
    await expect(browser.prepareRun(7)).resolves.toMatchObject({ tabId: 7 });
    await browser.detachAll();
    attach.mockRejectedValueOnce(
      new Error("Another debugger is already attached"),
    );
    await expect(browser.prepareRun(7)).rejects.toThrow("Close its DevTools");
  });
  it("a stale dialog cache cannot hide a disconnected debugger during preflight", async () => {
    await browser.prepareRun(7);
    events({ tabId: 7 }, "Page.javascriptDialogOpening", {
      type: "alert",
      message: "Old dialog",
    });
    connected = false;
    await expect(browser.prepareRun(7)).resolves.toMatchObject({ tabId: 7 });
    expect(attach).toHaveBeenCalledTimes(2);
    expect(browser.hasPendingDialogs()).toBe(false);
  });
  it("a vanished child frame leaves the root debugger connected", async () => {
    await browser.prepareRun(7);
    events({ tabId: 7 }, "Target.attachedToTarget", {
      sessionId: "child",
      targetInfo: { targetId: "frame" },
    });
    await vi.waitFor(() =>
      expect(
        send.mock.calls.some(
          (call) =>
            call[0].sessionId === "child" && call[1] === "Target.setAutoAttach",
        ),
      ).toBe(true),
    );
    send.mockImplementation(async (target) => {
      if (target.sessionId) throw new Error("No target with given id found");
      return {};
    });
    await expect(
      browser.perform("browser_cdp", {
        tabId: 7,
        sessionId: "child",
        method: "Runtime.evaluate",
        params: { expression: "1" },
      }),
    ).rejects.toThrow("frame changed");
    expect(detach).not.toHaveBeenCalled();
    expect(
      notices.mock.calls.some((call) => call[1]?.event === "detached"),
    ).toBe(false);
    await expect(browser.prepareRun(7)).resolves.toMatchObject({ tabId: 7 });
  });
  it("closing a tab through Relay is not reported as an unexpected disconnect", async () => {
    await browser.prepareRun(7);
    await browser.perform("browser_close_tab", { tabId: 7 });
    expect(
      notices.mock.calls.some((call) => call[1]?.event === "detached"),
    ).toBe(false);
  });
  it("cancelled session work cannot later detach a replacement session", async () => {
    await browser.prepareRun(7);
    vi.useFakeTimers();
    send.mockImplementation(async (_target, method) =>
      method === "Runtime.evaluate" ? new Promise(() => {}) : {},
    );
    const command = browser.perform("browser_cdp", {
      tabId: 7,
      method: "Runtime.evaluate",
      params: { expression: "1" },
    });
    const rejected = expect(command).rejects.toThrow("session ended");
    await vi.advanceTimersByTimeAsync(0);
    await browser.detachAll();
    await rejected;
    await browser.prepareRun(7);
    await vi.advanceTimersByTimeAsync(16000);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(connected).toBe(true);
  });
  it("reports a real disconnect once and never replays a dispatched command", async () => {
    await browser.prepareRun(7);
    send.mockImplementation(async (_target, method) => {
      if (method === "Input.insertText") {
        connected = false;
        throw new Error("Debugger is not attached to the tab with id: 7.");
      }
      return {};
    });
    await expect(
      browser.perform("browser_cdp", {
        tabId: 7,
        method: "Input.insertText",
        params: { text: "hello" },
      }),
    ).rejects.toThrow("not replayed");
    detached({ tabId: 7 }, "canceled_by_user");
    expect(
      send.mock.calls.filter((call) => call[1] === "Input.insertText"),
    ).toHaveLength(1);
    expect(
      notices.mock.calls.filter((call) => call[1]?.event === "detached"),
    ).toHaveLength(1);
  });
});
