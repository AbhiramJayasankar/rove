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
  const tab = { id: 7, url: "https://example.com", title: "Fixture", windowId: 1 };
  vi.stubGlobal("chrome", {
    runtime: { id: "rove" },
    tabGroups: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1 })),
      update: vi.fn(async () => ({})),
    },
    tabs: {
      create: vi.fn(async ({ url, active }: { url: string; active: boolean }) => ({ id: 9, url, active, windowId: 1 })),
      group: vi.fn(async ({ groupId }: { groupId?: number }) => groupId ?? 55),
      reload: vi.fn(async () => {}),
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
  it("checks a tab lease before debugger attachment or browser dispatch", async () => {
    const claim = vi.fn(() => { throw new Error("Tab 7 is owned by another task."); });
    await expect(browser.prepareRun(7, claim)).rejects.toThrow("owned by another task");
    await expect(browser.perform("browser_click", { tabId: 7, x: 1, y: 1 }, claim, true)).rejects.toThrow("owned by another task");
    expect(attach).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
  it("requires a tab on the agent path even after another task prepared one", async () => {
    await browser.prepareRun(7);
    send.mockClear();
    await expect(browser.perform("browser_snapshot", {}, () => {}, true)).rejects.toThrow("explicit tabId");
    await expect(browser.perform("browser_navigate", { url: "https://example.com" }, () => {}, true)).rejects.toThrow("explicit tabId");
    expect(send).not.toHaveBeenCalled();
  });
  it("releases one tab while preserving another tab and an open dialog", async () => {
    vi.mocked(chrome.tabs.get).mockImplementation(async id => ({ id, url: "https://example.com" }) as chrome.tabs.Tab);
    await browser.prepareRun(7);
    await browser.prepareRun(8);
    events({ tabId: 8 }, "Page.javascriptDialogOpening", { type: "alert", message: "Keep visible" });
    await expect(browser.releaseTab(7)).resolves.toBe(true);
    expect(detach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 });
    await expect(browser.releaseTab(8)).resolves.toBe(false);
    expect(detach).toHaveBeenCalledTimes(1);
    events({ tabId: 8 }, "Page.javascriptDialogClosed", {});
    await expect(browser.releaseTab(8)).resolves.toBe(true);
    expect(detach).toHaveBeenLastCalledWith({ tabId: 8 });
  });
  it("works in the background: no tab switch, and the page keeps rendering", async () => {
    await expect(browser.prepareRun(7)).resolves.toMatchObject({ tabId: 7 });
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    const methods = send.mock.calls.map((call) => call[1]);
    expect(methods.indexOf("Emulation.setFocusEmulationEnabled")).toBeGreaterThan(methods.indexOf("Page.enable"));
    expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Emulation.setFocusEmulationEnabled", { enabled: true });
  });
  it("switches to the task's tab only when background mode is off", async () => {
    browser.configureBrowser(() => ({ backgroundTabs: false, groupTabs: true }));
    await browser.prepareRun(7);
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(send.mock.calls.some((call) => call[1] === "Emulation.setFocusEmulationEnabled")).toBe(false);
  });
  it.each([
    [true, false],
    [false, true],
  ])("with background mode %s a new tab opens active: %s, and is reported as created", async (backgroundTabs, active) => {
    browser.configureBrowser(() => ({ backgroundTabs, groupTabs: true }));
    const claim = vi.fn();
    await browser.prepareRun(null, claim);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "about:blank", active });
    expect(claim).toHaveBeenCalledWith(9, { created: true });
    claim.mockClear();
    vi.mocked(chrome.tabs.get).mockImplementation((async () => ({ id: 9, url: "https://example.com/next", status: "complete", windowId: 1 })) as unknown as typeof chrome.tabs.get);
    // The snapshot after navigation has no page behind it here; only the tab's creation matters.
    await browser.perform("browser_navigate", { url: "https://example.com/next", newTab: true }, claim, true).catch(() => {});
    expect(chrome.tabs.create).toHaveBeenLastCalledWith({ url: "about:blank", active });
    expect(claim).toHaveBeenCalledWith(9, { created: true });
  });
  it.each([
    [true, "reloads it in place"],
    [false, "switches to it"],
  ])("restores a discarded tab before attaching: background mode %s %s", async (backgroundTabs) => {
    browser.configureBrowser(() => ({ backgroundTabs, groupTabs: true }));
    let restored = false;
    vi.mocked(chrome.tabs.get).mockImplementation((async () => ({ id: 7, url: "https://example.com", status: "complete", windowId: 1, discarded: !restored })) as unknown as typeof chrome.tabs.get);
    vi.mocked(chrome.tabs.reload).mockImplementation((async () => { restored = true; }) as unknown as typeof chrome.tabs.reload);
    vi.mocked(chrome.tabs.update).mockImplementation((async () => { restored = true; return {}; }) as unknown as typeof chrome.tabs.update);
    send.mockImplementation(async (_target, method) => {
      if (method === "Page.enable" && !restored) throw new Error("No renderer for a discarded tab");
      return {};
    });
    await expect(browser.prepareRun(7)).resolves.toMatchObject({ tabId: 7 });
    if (backgroundTabs) {
      expect(chrome.tabs.reload).toHaveBeenCalledWith(7);
      expect(chrome.tabs.update).not.toHaveBeenCalled();
    } else {
      expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    }
  });
  it("groups the tabs a task opens under one Rove group", async () => {
    await browser.groupTab("run-1", 9);
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [9], createProperties: { windowId: 1 } });
    expect(chrome.tabGroups.update).toHaveBeenCalledWith(55, { title: "Rove", color: "green", collapsed: false });
    await browser.groupTab("run-1", 10);
    expect(chrome.tabs.group).toHaveBeenLastCalledWith({ tabIds: [10], groupId: 55 });
    expect(chrome.tabGroups.update).toHaveBeenCalledTimes(1);
    browser.forgetGroup("run-1");
    await browser.groupTab("run-1", 11);
    expect(chrome.tabs.group).toHaveBeenLastCalledWith({ tabIds: [11], createProperties: { windowId: 1 } });
  });
  it("does not group when the setting is off, and never lets a grouping failure through", async () => {
    browser.configureBrowser(() => ({ backgroundTabs: true, groupTabs: false }));
    await browser.groupTab("run-2", 9);
    expect(chrome.tabs.group).not.toHaveBeenCalled();
    browser.configureBrowser(() => ({ backgroundTabs: true, groupTabs: true }));
    vi.mocked(chrome.tabs.group).mockRejectedValueOnce(new Error("Tabs cannot be edited right now."));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(browser.groupTab("run-2", 9)).resolves.toBeUndefined();
  });
  describe("screenshots of a tab nobody is looking at", () => {
    // 1x1 JPEG: enough for the dimension reader.
    const jpeg = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    function pageAnswers(capture: (params: any, state: { poked: boolean }) => unknown) {
      const state = { poked: false };
      vi.mocked(chrome.tabs.get).mockImplementation(async (id: number) => ({ id, url: "https://example.com", title: "Fixture", active: false, windowId: 1 }) as chrome.tabs.Tab);
      send.mockImplementation(async (_target, method, params) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "root", url: "https://example.com" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
        if (method === "Runtime.evaluate") return { result: { value: { width: 100, height: 80, devicePixelRatio: 1, scrollX: 0, scrollY: 0 } } };
        if (method === "Page.captureScreenshot") return capture(params, state);
        return {};
      });
    }
    it("wakes the tab's rendering instead of switching to it", async () => {
      pageAnswers((params, state) => {
        if (params.clip?.width === 4) { state.poked = true; return new Promise(() => {}); } // Chrome never answers the wake-up capture
        return state.poked ? { data: jpeg } : new Promise(() => {});
      });
      const result = await browser.perform("browser_screenshot", { tabId: 7 }, () => {}, true);
      expect(result.dataUrl).toBe("data:image/jpeg;base64," + jpeg);
      expect(chrome.tabs.update).not.toHaveBeenCalled();
      expect(detach).not.toHaveBeenCalled();
    });
    it("reports a tab that never renders, keeps the session attached and points at the setting", async () => {
      vi.useFakeTimers();
      pageAnswers(() => new Promise(() => {}));
      const run = browser.perform("browser_screenshot", { tabId: 7 }, () => {}, true);
      const rejected = expect(run).rejects.toThrow('Turn off "Work in the background"');
      await vi.advanceTimersByTimeAsync(30000);
      await rejected;
      expect(detach).not.toHaveBeenCalled();
      expect(chrome.tabs.update).not.toHaveBeenCalled();
    });
    it("switches to the tab for the capture when background mode is off", async () => {
      browser.configureBrowser(() => ({ backgroundTabs: false, groupTabs: true }));
      pageAnswers(() => ({ data: jpeg }));
      await browser.perform("browser_screenshot", { tabId: 7 }, () => {}, true);
      expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    });
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
  it("closing a tab through Rove is not reported as an unexpected disconnect", async () => {
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

describe("saving reports to Downloads", () => {
  it("saves a text report into the Rove folder and rejects paths and risky types", async () => {
    const download = vi.fn(async () => 42);
    (chrome as any).downloads = { download };
    await expect(browser.perform("browser_save_file", { filename: "report.md", content: "# Hi" })).resolves.toMatchObject({ saved: true, filename: "Rove/report.md", downloadId: 42 });
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ filename: "Rove/report.md", conflictAction: "uniquify", saveAs: false }));
    for (const bad of ["../evil.md", "dir/report.md", "run.exe", "noextension", ".hidden.md"])
      await expect(browser.perform("browser_save_file", { filename: bad, content: "x" })).rejects.toThrow("plain file name");
    expect(download).toHaveBeenCalledTimes(1);
  });
});
