import { describe, expect, it } from "vitest";
import { runToMarkdown } from "../../shared/markdown";
import type { RunRecord } from "../../shared/types";

const event = (id: number, type: string, data: Record<string, any>) => ({ id, time: "2026-10-21T00:00:00Z", type, data });
describe("Markdown export", () => {
  it("writes your messages, the actions taken and the answers, without raw traces", () => {
    const run: RunRecord = {
      id: "r1", prompt: "Find free model endpoints", status: "completed", createdAt: "", updatedAt: "",
      events: [
        event(1, "status", { status: "running" }),
        event(2, "model_request", { messages: [{ role: "user", content: "secret trace" }] }),
        event(3, "tool_call", { name: "browser_navigate", args: { url: "https://freellm.net" } }),
        event(4, "tool_result", { result: { huge: "snapshot" } }),
        event(5, "assistant", { content: "Here are three options." }),
        event(6, "user_message", { message: "Which is fastest?" }),
        event(7, "assistant", { content: "Groq." }),
      ],
    };
    const md = runToMarkdown(run, (name, args) => `${name} ${args.url ?? ""}`.trim(), { app: "Rove", version: "2.2.0", exportedAt: new Date("2026-10-21") });
    expect(md).toContain("# Find free model endpoints");
    expect(md).toContain("Exported from Rove 2.2.0 on 2026-10-21.");
    expect(md).toContain("## You\n\nFind free model endpoints");
    expect(md).toContain("- browser_navigate https://freellm.net");
    expect(md).toContain("## Assistant\n\nHere are three options.");
    expect(md).toContain("## You\n\nWhich is fastest?");
    expect(md).toContain("Groq.");
    expect(md).not.toContain("secret trace");
    expect(md).not.toContain("snapshot");
  });

  it("lists attachment names beneath their own messages without contents", () => {
    const run: RunRecord = {
      id: "r", prompt: "Read these", status: "completed", createdAt: "", updatedAt: "",
      events: [
        event(1, "attachment", { name: "notes.txt", kind: "text", text: "private contents" }),
        event(2, "attachment", { name: "pixel.png", kind: "image", dataUrl: "data:image/png;base64,YQ==" }),
        event(3, "assistant", { content: "First answer" }),
        event(4, "user_message", { message: "And this?" }),
        event(5, "attachment", { name: "next.txt", kind: "text", text: "more private contents" }),
        event(6, "assistant", { content: "Second answer" }),
      ],
    };
    const md = runToMarkdown(run, () => "");
    expect(md).toContain('## You\n\nRead these\n\n- Attached: notes.txt\n\n- Attached: pixel.png\n\n## Assistant\n\nFirst answer');
    expect(md).toContain('## You\n\nAnd this?\n\n- Attached: next.txt\n\n## Assistant\n\nSecond answer');
    expect(md).not.toContain("private contents");
    expect(md).not.toContain("base64");
  });
});
