import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelCatalogue } from "../catalogue";
import { executeTool, readBounded } from "../tools";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import type { BrowserTransport } from "../../shared/types";
import { AgentEngine } from "../agent";

afterEach(() => vi.unstubAllGlobals());
const settings = {
  ...structuredClone(DEFAULT_SETTINGS),
  model: "example",
  stream: false,
  approvalMode: "never" as const,
};
const transport: BrowserTransport = {
  execute: vi.fn().mockResolvedValue({ ok: true }),
  status: () => ({ connected: true, tabs: [] }),
};
async function until(predicate: () => boolean) {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
describe("browser runtime primitives", () => {
  it("validates schemas and arguments with dynamic evaluation disabled", async () => {
    const previous = globalThis.Function;
    (globalThis as any).Function = function () {
      throw new Error("MV3 CSP forbids dynamic evaluation");
    };
    try {
      await expect(
        executeTool(
          "browser_navigate",
          { url: 2 },
          settings,
          transport,
          new AbortController().signal,
        ),
      ).rejects.toThrow("Invalid arguments");
      await expect(
        executeTool(
          "browser_navigate",
          { url: "https://example.com" },
          settings,
          transport,
          new AbortController().signal,
        ),
      ).resolves.toEqual({ ok: true });
    } finally {
      (globalThis as any).Function = previous;
    }
  });
  it("decodes streamed Unicode using Web APIs and enforces byte limits", async () => {
    const encoded = new TextEncoder().encode("Hello 👋 नमस्ते");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 8));
        controller.enqueue(encoded.slice(8));
        controller.close();
      },
    });
    expect(await readBounded(new Response(stream))).toBe("Hello 👋 नमस्ते");
    await expect(readBounded(new Response("oversize"), 2)).rejects.toThrow(
      "exceeds",
    );
  });
  it("isolates catalogue caches and learned Chrome storage profiles by credential hash", async () => {
    const data: Record<string, any> = {};
    const storage = {
      get: vi.fn(async (keys: string | string[]) =>
        Object.fromEntries([keys].flat().map((key) => [key, structuredClone(data[key])])),
      ),
      set: vi.fn(async (values: Record<string, unknown>) => {
        Object.assign(data, structuredClone(values));
      }),
    };
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "example", context_length: 131072, tool_call: true }],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const catalogue = new ModelCatalogue(storage);
    await catalogue.init();
    expect(catalogue.peek(settings, "credential-a")).toBeNull();
    await catalogue.list(settings, "credential-a");
    expect(catalogue.peek(settings, "credential-a")?.contextWindow).toBe(
      131072,
    );
    expect(catalogue.peek(settings, "credential-b")).toBeNull();
    catalogue.learn(settings, "credential-a", 30000, 2);
    await catalogue.flush();
    expect(catalogue.peek(settings, "credential-a")?.workingInputBudget).toBe(
      30000,
    );
    expect(JSON.stringify(data)).not.toContain("credential-a");
    expect(Object.keys(data["relay.modelProfiles.v1"])[0]).toMatch(
      /^[a-f0-9]{64}:example$/,
    );
    const restored = new ModelCatalogue(storage);
    await restored.list(settings, "credential-a");
    expect(restored.peek(settings, "credential-a")?.workingMaxImages).toBe(2);
    await restored.list(settings, "credential-b");
    expect(
      restored.peek(settings, "credential-b")?.workingInputBudget,
    ).toBeUndefined();
    restored.reset(settings, "credential-a");
    await restored.flush();
    await restored.list(settings, "credential-a");
    expect(
      restored.peek(settings, "credential-a")?.workingInputBudget,
    ).toBeUndefined();
  });
  it("stops before model dispatch when the durable journal checkpoint fails", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const records: any[] = [];
    const engine = new AgentEngine({
      transport,
      getSettings: () => settings,
      getApiKey: () => "",
      emit: () => {},
      save: (run) => records.push(run),
      checkpoint: async () => {
        throw new Error("IndexedDB unavailable");
      },
    });
    const run = engine.start("Inspect the page", 7);
    await until(() => !engine.activeRunId);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(
      run.events.find((event) => event.type === "error")?.data.message,
    ).toContain("IndexedDB unavailable");
    expect(records.at(-1).status).toBe("failed");
  });
  it("checkpoints tool events before dispatch and stops on storage failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call",
                      type: "function",
                      function: {
                        name: "browser_click",
                        arguments: '{"ref":"r1"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      ),
    );
    const execute = vi.fn();
    let toolRecorded = false;
    const engine = new AgentEngine({
      transport: { ...transport, execute },
      getSettings: () => settings,
      getApiKey: () => "",
      emit: (_, event) => {
        if (event.type === "tool_call") toolRecorded = true;
      },
      save: () => {},
      checkpoint: async () => {
        if (toolRecorded) throw new Error("Journal write failed");
      },
    });
    const run = engine.start("Click", 7);
    await until(() => !engine.activeRunId);
    expect(execute).not.toHaveBeenCalled();
    expect(run.status).toBe("failed");
    expect(
      run.events.find((event) => event.type === "error")?.data.message,
    ).toContain("Journal write failed");
  });
});
