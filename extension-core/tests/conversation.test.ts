import { describe, it, expect } from "vitest";
import { conversationHistory, historyBeforeEdit } from "../conversation";
import { AgentEngine } from "../agent";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import type { RunRecord, RunEvent } from "../../shared/types";
import { vi, afterEach } from "vitest";
afterEach(() => vi.unstubAllGlobals());
const event = (id: number, type: string, data: any): RunEvent => ({
  id,
  type,
  data,
  time: new Date().toISOString(),
});
const record = (events: RunEvent[]): RunRecord => ({
  id: "chat",
  prompt: "Original question",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "completed",
  events,
});
describe("saved chat continuation", () => {
  it("cuts history before an edited follow-up without mutating the original", () => {
    const original = record([
      event(1, "model_request", { step: 1, messages: [{ role: "user", content: "Original question" }] }),
      event(2, "model_response", { step: 1, message: { role: "assistant", content: "Earlier answer" } }),
      event(3, "user_message", { message: "Old follow-up" }),
      event(4, "model_request", { messages: [{ role: "user", content: "Discarded context" }] }),
    ]);
    const edited = historyBeforeEdit(original, 3, "Replacement");
    expect(edited.events.map((item) => item.id)).toEqual([1, 2]);
    expect(edited.revision).toBe(1);
    expect(edited.prompt).toBe(original.prompt);
    expect(conversationHistory(edited)).toEqual([
      { role: "user", content: "Original question" },
      { role: "assistant", content: "Earlier answer" },
    ]);
    expect(original.events).toHaveLength(4);
  });
  it("resets the first message and rejects stale edit targets", () => {
    const original = record([event(1, "user_message", { message: "Later" })]);
    const edited = historyBeforeEdit(original, 0, "New first question");
    expect(edited.events).toEqual([]);
    expect(edited.prompt).toBe("New first question");
    expect(conversationHistory(edited)).toEqual([{ role: "user", content: "New first question" }]);
    expect(() => historyBeforeEdit(original, 99, "Missing")).toThrow("Message no longer exists");
  });
  it("retains compacted messages, full provider reasoning and original screenshot pixels", () => {
    const run = record([
      event(1, "screenshot", {
        callId: "read",
        source: "automatic",
        dataUrl: "data:image/png;base64,YQ==",
      }),
      event(2, "model_request", {
        step: 3,
        attempt: 1,
        messages: [
          { role: "system", content: "Old instructions" },
          { role: "user", content: "Original question" },
          {
            role: "user",
            content: [
              { type: "text", text: "Automatic screenshot after read (read)." },
              { type: "image_url", image_url: { url: "[Image omitted]" } },
            ],
          },
        ],
      }),
      event(3, "model_response", {
        step: 3,
        attempt: 1,
        message: {
          role: "assistant",
          content: "Verified answer",
          reasoning_content: "Full reasoning ".repeat(5000),
        },
      }),
    ]);
    const messages = conversationHistory(run);
    expect(messages.at(-1).reasoning_content).toBe(
      run.events[2].data.message.reasoning_content,
    );
    expect(messages[2].content[1].image_url.url).toBe(
      "data:image/png;base64,YQ==",
    );
    expect(run.events[1].data.messages[2].content[1].image_url.url).toBe(
      "[Image omitted]",
    );
  });
  it("uses journal references when a provider reuses a tool call ID", () => {
    const messages = conversationHistory(
      record([
        event(1, "screenshot", {
          callId: "reused",
          source: "automatic",
          dataUrl: "data:image/png;base64,YQ==",
        }),
        event(2, "screenshot", {
          callId: "reused",
          source: "automatic",
          dataUrl: "data:image/png;base64,Yg==",
        }),
        event(3, "model_request", {
          step: 2,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "[Rove screenshot 1] Automatic screenshot after read (reused).",
                },
                { type: "image_url", image_url: { url: "[Image omitted]" } },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "[Rove screenshot 2] Automatic screenshot after read (reused).",
                },
                { type: "image_url", image_url: { url: "[Image omitted]" } },
              ],
            },
          ],
        }),
      ]),
    );
    expect(messages[0].content[1].image_url.url).toBe(
      "data:image/png;base64,YQ==",
    );
    expect(messages[1].content[1].image_url.url).toBe(
      "data:image/png;base64,Yg==",
    );
  });
  it("repairs interrupted tool batches with explicit unknown outcomes without replaying actions", () => {
    const calls = [
      {
        id: "sent",
        type: "function",
        function: { name: "browser_click", arguments: '{"ref":"r1"}' },
      },
      {
        id: "unsent",
        type: "function",
        function: { name: "browser_snapshot", arguments: "{}" },
      },
    ];
    const messages = conversationHistory(
      record([
        event(1, "model_request", {
          step: 1,
          messages: [{ role: "user", content: "Click once" }],
        }),
        event(2, "model_response", {
          step: 1,
          message: { role: "assistant", content: null, tool_calls: calls },
        }),
        event(3, "tool_call", {
          callId: "sent",
          name: "browser_click",
          args: { ref: "r1" },
        }),
      ]),
    );
    expect(
      messages
        .filter((message) => message.role === "tool")
        .map((message) => message.tool_call_id),
    ).toEqual(["sent", "unsent"]);
    expect(JSON.parse(messages[2].content)).toMatchObject({
      interrupted: true,
    });
    expect(messages[2].content).toContain("may already have happened");
  });
  it("continues with the same ID, monotonic steps and prior answers after serialization", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "Follow-up answer" } },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const execute = vi.fn();
    const previous = record([
      event(1, "model_request", {
        step: 8,
        messages: [
          { role: "system", content: "Old instructions" },
          { role: "user", content: "Original question" },
        ],
      }),
      event(2, "model_response", {
        step: 8,
        message: {
          role: "assistant",
          content: "Prior answer",
          reasoning_content: "Provider reasoning",
        },
      }),
    ]);
    const engine = new AgentEngine({
      transport: { execute, status: () => ({ connected: true, tabs: [] }) },
      getSettings: () => ({ ...DEFAULT_SETTINGS, model: "fixture" }),
      getApiKey: () => "",
      emit: () => {},
      save: () => {},
    });
    const run = engine.continue(
      JSON.parse(JSON.stringify(previous)),
      "Follow-up",
      7,
    );
    await vi.waitFor(() => expect(engine.activeRunId).toBeNull());
    expect(run.id).toBe(previous.id);
    expect(run.status).toBe("completed");
    expect(previous.events).toHaveLength(2);
    const request = run.events.findLast(
      (event) => event.type === "model_request",
    )!;
    expect(request.data.step).toBe(9);
    const messages = JSON.parse(fetch.mock.calls[0][1].body).messages;
    expect(
      messages.find((message: any) => message.role === "assistant"),
    ).toMatchObject({
      content: "Prior answer",
      reasoning_content: "Provider reasoning",
    });
    expect(messages.at(-1).content).toContain("Follow-up");
    expect(messages.at(-1).content).toContain("Refresh the page snapshot");
    expect(execute).not.toHaveBeenCalled();
  });
});
