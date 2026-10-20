import type { RunRecord } from "./types";

/** A readable Markdown transcript: your messages, the actions taken, and the answers. No raw traces. */
export function runToMarkdown(
  run: RunRecord,
  label: (name: string, args: Record<string, any>) => string,
  meta: { app: string; version: string; exportedAt?: Date } = { app: "Rove", version: "" },
): string {
  const title = run.prompt.replace(/\s+/g, " ").trim().slice(0, 90) || "Chat";
  const lines: string[] = [`# ${title}`, ""];
  const when = (meta.exportedAt ?? new Date()).toISOString().slice(0, 10);
  lines.push(`Exported from ${meta.app}${meta.version ? ` ${meta.version}` : ""} on ${when}.`, "");
  let actions: string[] = [];
  const flush = () => {
    if (actions.length) lines.push(...actions.map((action) => `- ${action}`), "");
    actions = [];
  };
  lines.push("## You", "", run.prompt.trim(), "");
  let answered = false;
  for (const event of run.events) {
    if (event.type === "user_message") {
      flush();
      lines.push("## You", "", String(event.data.message ?? "").trim(), "");
      answered = false;
    } else if (event.type === "attachment") {
      lines.push(`- Attached: ${String(event.data.name ?? "").replace(/\s+/g, " ")}`, "");
    } else if (event.type === "tool_call") {
      actions.push(label(String(event.data.name), event.data.args ?? {}));
    } else if (event.type === "assistant") {
      flush();
      if (!answered) lines.push("## Assistant", "");
      answered = true;
      lines.push(String(event.data.content ?? "").trim(), "");
    } else if (event.type === "error") {
      flush();
      lines.push(`> ${String(event.data.message ?? "").replace(/\n/g, "\n> ")}`, "");
    }
  }
  flush();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
