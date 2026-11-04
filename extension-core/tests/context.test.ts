import { describe, expect, it } from "vitest";
import { compactContext, estimateTokens } from "../context";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

const turn = (id: string, size = 100) => [
  {
    role: "assistant",
    reasoning_content: `Remember ${id}`,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: "browser_snapshot", arguments: "{}" },
      },
    ],
  },
  { role: "tool", tool_call_id: id, content: "text".repeat(size) },
  {
    role: "user",
    content: [
      { type: "text", text: "Browser observation" },
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64," + "A".repeat(600000) },
      },
    ],
  },
];
describe("large model context", () => {
  it("reserves the largest output that leaves room for the current task", () => {
    const messages = [
      { role: "system", content: "Instructions" },
      { role: "user", content: "Task" },
    ];
    const settings = {
      ...DEFAULT_SETTINGS,
      contextWindow: 8192,
      maxOutputTokens: 8192,
    };
    const usage = compactContext(messages, settings, []);
    expect(usage.reservedOutputTokens).toBe(
      8192 - 2048 - usage.estimatedTokens,
    );
    expect(usage.inputBudget).toBeGreaterThanOrEqual(usage.estimatedTokens);
    expect(usage.droppedMessages).toBe(0);
  });
  it("retains prior tool calls and reasoning despite multi-megabyte screenshots", () => {
    const messages = [
      { role: "system", content: "Instructions" },
      { role: "user", content: "Task" },
      ...turn("one"),
      ...turn("two"),
      ...turn("three"),
    ];
    const usage = compactContext(messages, DEFAULT_SETTINGS, []);
    expect(usage.droppedMessages).toBe(0);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(3);
    expect(JSON.stringify(messages)).toContain("Remember one");
    expect(estimateTokens(messages)).toBeLessThan(16000);
  });
  it("caps images independently without deleting their tool history", () => {
    const messages = [
      { role: "system", content: "Instructions" },
      { role: "user", content: "Task" },
      ...turn("one"),
      ...turn("two"),
      ...turn("three"),
    ];
    const usage = compactContext(
      messages,
      { ...DEFAULT_SETTINGS, maxImages: 1 },
      [],
    );
    expect(usage.removedImages).toBe(2);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(3);
    expect(JSON.stringify(messages).match(/data:image/g)).toHaveLength(1);
  });
  it("evicts complete oldest groups only near the selected context limit", () => {
    const messages = [
      { role: "system", content: "Instructions" },
      { role: "user", content: "Task" },
      ...turn("one", 1500),
      ...turn("two", 1500),
      ...turn("three", 1500),
    ];
    const usage = compactContext(
      messages,
      {
        ...DEFAULT_SETTINGS,
        contextWindow: 7000,
        maxOutputTokens: 512,
        maxImages: 0,
      },
      [],
    );
    expect(usage.droppedMessages).toBeGreaterThan(0);
    expect(messages[1].content).toBe("Task");
    const ids = messages
      .filter((m: any) => m.role === "assistant")
      .flatMap((m: any) => m.tool_calls.map((c: any) => c.id));
    expect(
      messages.filter((m) => m.role === "tool").map((m: any) => m.tool_call_id),
    ).toEqual(ids);
    expect(ids).toContain("three");
  });
});

describe("small model context", () => {
  const small = { ...DEFAULT_SETTINGS, contextWindow: 8192, maxOutputTokens: 16384 };
  it("shortens a long earlier answer instead of failing a follow-up", () => {
    const long = "Lamps come in many shapes and sizes. ".repeat(500);
    const messages = [
      { role: "system", content: "Instructions ".repeat(300) },
      { role: "user", content: "First question" },
      { role: "assistant", content: long },
      { role: "user", content: "Second question" },
      { role: "assistant", content: long },
      { role: "user", content: "Third question" },
    ];
    const usage = compactContext(messages, small, []);
    expect(usage.estimatedTokens).toBeLessThanOrEqual(usage.inputBudget);
    expect(messages[1].content).toBe("First question");
    expect(messages.at(-1)!.content).toBe("Third question");
    const answer = messages.findLast((m: any) => m.role === "assistant")!;
    expect(answer.content).toContain("[Earlier answer shortened to fit this model's context.]");
    expect(answer.content.length).toBeLessThan(long.length);
  });
  it("names an oversized page observation and suggests a smaller snapshot", () => {
    const messages = [
      { role: "system", content: "Instructions" },
      { role: "user", content: "Task" },
      { role: "assistant", content: null, tool_calls: [{ id: "s", type: "function", function: { name: "browser_snapshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "s", content: "text ".repeat(20000) },
    ];
    expect(() => compactContext(messages, small, [])).toThrow("The latest page observation is too large for this model's context.");
  });
  it("says plainly when the newest step cannot fit at all", () => {
    const messages = [
      { role: "system", content: "Instructions" },
      { role: "user", content: "x".repeat(40000) },
    ];
    expect(() => compactContext(messages, small, [])).toThrow(/This chat's newest step needs about [\d,]+ tokens, more than the [\d,]+ this model has room for/);
  });
});
