import { useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  MousePointer2,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RunEvent } from "../shared/types";
import { useT } from "./i18n";
export const statusLabels: Record<string, string> = {
  running: "Working",
  awaiting_approval: "Waiting for you",
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
export { api } from "./transport";
export type Page = "workbench" | "settings" | "instructions" | "tools";
export type Shot = {
  dataUrl: string;
  url?: string;
  title?: string;
  tabId?: number;
};
export type Action = (name: string, task: () => Promise<void>) => Promise<void>;
type Translate = (text: string, vars?: Record<string, string | number>) => string;
export function toolTitle(
  name: string,
  args: Record<string, any> = {},
  t: Translate = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, key) => String(vars[key] ?? m)) : text),
): string {
  if (name === "browser_type")
    return args.text ? t("Type “{text}”", { text: String(args.text).slice(0, 80) }) : t("Type text");
  if (name === "browser_navigate") {
    try {
      return t("Open {host}", { host: new URL(args.url).hostname });
    } catch {
      return t("Open page");
    }
  }
  if (name === "browser_press_key")
    return args.key ? t("Press {key}", { key: args.key }) : t("Press key");
  const titles: Record<string, string> = {
    browser_snapshot: "Read page",
    browser_screenshot: "Capture screenshot",
    browser_click: "Click element",
    browser_scroll: "Scroll page",
    browser_tabs: "Read tabs",
    browser_select: "Select option",
    browser_history: "Navigate history",
    browser_close_tab: "Close tab",
    browser_wait: "Wait",
    browser_hover: "Hover element",
    browser_drag: "Drag element",
    browser_downloads: "Check downloads",
    browser_save_file: args.filename ? t("Save {name}", { name: String(args.filename).slice(0, 60) }) : "Save file",
    browser_dialog: "Handle dialog",
    browser_upload: "Upload file",
    browser_evaluate: "Run page script",
    browser_cdp: "Run browser command",
    ask_user: "Ask a question",
  };
  return titles[name] ? t(titles[name]) : name;
}
export function AssistantMessage({ content }: { content: string }) {
  return (
    <div className="assistant-message">
      <span className="assistant-mark">
        <MousePointer2 size={15} />
      </span>
      <div className="markdown">
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: (props) => (
              <a {...props} target="_blank" rel="noreferrer noopener" />
            ),
          }}
        >
          {content}
        </Markdown>
      </div>
    </div>
  );
}
export function ToolActivity({
  event,
  result,
  working,
}: {
  event: RunEvent;
  result?: RunEvent;
  working: boolean;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`tool-activity ${result?.data.error ? "has-error" : ""}`}>
      <button
        className="tool-activity-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {result?.data.error ? (
          <CircleAlert size={14} />
        ) : result ? (
          <Check size={14} />
        ) : working ? (
          <LoaderCircle size={14} className="spin" />
        ) : (
          <ChevronRight size={14} />
        )}
        <span>{toolTitle(event.data.name, event.data.args, t)}</span>
        <ChevronRight size={13} className={expanded ? "rotated" : ""} />
      </button>
      {expanded && (
        <pre>
          {json({
            tool: event.data.name,
            args: event.data.args,
            ...(result
              ? { result: result.data.result, error: result.data.error }
              : {}),
          })}
        </pre>
      )}
    </div>
  );
}
export function TimelineEvent({ event }: { event: RunEvent }) {
  const data =
    event.type === "screenshot"
      ? { ...event.data, dataUrl: "[Image shown in browser view]" }
      : event.data;
  return (
    <details className="trace-event">
      <summary>
        <span>{event.type.replaceAll("_", " ")}</span>
        <time>{time(event.time)}</time>
      </summary>
      <pre>{json(data)}</pre>
    </details>
  );
}
