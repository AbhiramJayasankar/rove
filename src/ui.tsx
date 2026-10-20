import { useState } from "react";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Eye,
  MousePointer2,
  ShieldCheck,
} from "lucide-react";
import type { RunEvent } from "../shared/types";
export const statusLabels: Record<string, string> = {
  running: "Working",
  awaiting_approval: "Needs approval",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};
export const json = (value: unknown) => JSON.stringify(value, null, 2);
export const time = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      body.error || body.message || `Request failed (${response.status}).`,
    );
  return body as T;
}
export type Page =
  "workbench" | "connection" | "settings" | "instructions" | "tools";
export type Pairing = {
  token: string;
  extensionPath: string;
  serverUrl: string;
};
export type Shot = { dataUrl: string; url?: string; title?: string };
export type Action = (name: string, task: () => Promise<void>) => Promise<void>;
export function TimelineEvent({ event }: { event: RunEvent }) {
  const [expanded, setExpanded] = useState(false);
  const data = event.data;
  const labels: Record<string, string> = {
    model_request: "Request sent to model",
    model_response: "Model response",
    assistant: "Relay",
    tool_call: String(data.name || "Tool action"),
    tool_result: String(data.name || "Tool result"),
    screenshot: "Browser screenshot captured",
    approval_required: "Approval requested",
    user_question: "Question for you",
    user_reply: "Your answer",
    status: String(
      data.message ||
        statusLabels[data.status] ||
        data.status ||
        "Status updated",
    ),
    error: "Something needs attention",
  };
  const Icon =
    event.type === "assistant"
      ? MousePointer2
      : event.type === "error" || event.type === "user_question"
        ? CircleHelp
        : event.type === "tool_call"
          ? Code2
          : event.type === "screenshot"
            ? Eye
            : event.type === "approval_required"
              ? ShieldCheck
              : event.type.startsWith("model_")
                ? Braces
                : Check;
  const text =
    event.type === "assistant"
      ? data.content
      : event.type === "error" || event.type === "user_reply"
        ? data.message
        : event.type === "user_question"
          ? data.question
          : undefined;
  const filtered =
    event.type === "screenshot"
      ? { ...data, dataUrl: "[Screenshot shown in browser view]" }
      : data;
  return (
    <article
      className={`timeline-event event-${event.type} ${data.error ? "event-error" : ""}`}
    >
      <div className="timeline-icon">
        <Icon size={14} />
      </div>
      <div className="event-body">
        <button
          className="event-heading"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span>{labels[event.type] || event.type.replaceAll("_", " ")}</span>
          <time>{time(event.time)}</time>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {text && <p className="event-text">{String(text)}</p>}
        {event.type === "tool_call" && !expanded && (
          <div className="tool-preview">
            {Object.entries(data.args || {})
              .slice(0, 2)
              .map(([key, value]) => (
                <span key={key}>
                  {key}:{" "}
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </span>
              ))}
          </div>
        )}
        {expanded && <pre className="event-json">{json(filtered)}</pre>}
      </div>
    </article>
  );
}
