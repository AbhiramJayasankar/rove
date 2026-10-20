import { useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  Copy,
  LoaderCircle,
  Wrench,
} from "lucide-react";
import type { RunEvent, RunRecord } from "../shared/types";
import { AssistantMessage, json, ToolActivity } from "./ui";
import { tokenCount } from "./ModelPicker";

function reasoningText(message: any): string {
  const parts = [message?.reasoning_content, message?.reasoning];
  if (message?.reasoning_details)
    parts.push(
      typeof message.reasoning_details === "string"
        ? message.reasoning_details
        : json(message.reasoning_details),
    );
  return parts.filter((part) => typeof part === "string" && part).join("\n\n");
}
export default function ExecutionLog({ run }: { run: RunRecord }) {
  const [expanded, setExpanded] = useState(false);
  const requests = run.events.filter((e) => e.type === "model_request");
  const calls = run.events.filter((e) => e.type === "tool_call");
  const results = new Map(
    run.events
      .filter((e) => e.type === "tool_result")
      .map((e) => [e.data.callId, e]),
  );
  const responses = new Map(
    run.events
      .filter((e) => e.type === "model_response")
      .map((e) => [`${e.data.step}:${e.data.attempt || 1}`, e]),
  );
  const running = ["running", "awaiting_approval"].includes(run.status);
  return (
    <section className="execution-ledger">
      <button
        className="execution-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="execution-symbol">
          {running ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <Wrench size={17} />
          )}
        </span>
        <span>
          <strong>Execution</strong>
          <small>
            {requests.length} {requests.length === 1 ? "step" : "steps"} ·{" "}
            {calls.length} tool calls
          </small>
        </span>
        <ChevronDown size={16} className={expanded ? "" : "collapsed"} />
      </button>
      {expanded && (
        <div className="execution-steps">
          {requests.map((request, index) => {
            const response = responses.get(
              `${request.data.step}:${request.data.attempt || 1}`,
            );
            const rejected = run.events.find(
              (e) =>
                e.type === "model_error" &&
                e.data.step === request.data.step &&
                e.data.attempt === request.data.attempt,
            );
            const next = requests[index + 1]?.id || Infinity;
            const stepCalls = calls.filter(
              (call) => call.id > request.id && call.id < next,
            );
            const deltas = run.events.filter(
              (e) =>
                e.type === "model_delta" &&
                e.data.step === request.data.step &&
                (e.data.attempt || 1) === (request.data.attempt || 1),
            );
            const reason = response
              ? reasoningText(response.data.message)
              : deltas.map((e) => e.data.reasoning || "").join("");
            const content =
              response?.data.message?.content ||
              deltas.map((e) => e.data.content || "").join("");
            return (
              <div className="execution-step" key={request.id}>
                <div className="step-heading">
                  <span className="step-number">
                    {String(request.data.step).padStart(2, "0")}
                  </span>
                  <strong>
                    {response
                      ? stepCalls.length
                        ? "Tools selected"
                        : "Response"
                      : rejected
                        ? "Context adjusted"
                        : running
                          ? "Generating"
                          : "Interrupted"}
                  </strong>
                  <span>
                    {response?.data.durationMs
                      ? `${(response.data.durationMs / 1000).toFixed(1)}s`
                      : ""}
                  </span>
                  {response?.data.usage?.prompt_tokens != null && (
                    <span title="Input tokens reported by provider">
                      {tokenCount(response.data.usage.prompt_tokens)} in
                    </span>
                  )}
                </div>
                {rejected && (
                  <div className="context-adjustment">
                    The endpoint rejected the context. Relay compacted
                    observations and retried this request.
                  </div>
                )}
                {reason && (
                  <details className="reasoning-block" open={!response}>
                    <summary>
                      <Brain size={14} />
                      Reasoning
                      {!response && running && (
                        <LoaderCircle size={12} className="spin" />
                      )}
                    </summary>
                    <div className="reasoning-text">{reason}</div>
                  </details>
                )}
                {content && <AssistantMessage content={String(content)} />}
                {stepCalls.length > 0 && (
                  <div className="step-tools">
                    {stepCalls.map((call) => (
                      <ToolActivity
                        key={call.id}
                        event={call}
                        result={results.get(call.data.callId)}
                        working={running}
                      />
                    ))}
                  </div>
                )}
                <details className="request-details">
                  <summary>Request & response</summary>
                  <pre>
                    {json({
                      request: request.data,
                      response: response?.data,
                      error: rejected?.data,
                    })}
                  </pre>
                </details>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function TraceView({ events }: { events: RunEvent[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const visible = events.filter(
    (e) =>
      !query ||
      `${e.type} ${e.type === "screenshot" ? e.data.title || "" : json(e.data)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="trace-view">
      <div className="trace-controls">
        <input
          aria-label="Search trace"
          placeholder="Filter trace…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="text-button"
          onClick={() => setOpen(!open)}
        >
          {open ? "Collapse all" : "Expand all"}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Copy trace"
          title="Copy full trace"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(json(events));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {visible.map((e) => (
        <TraceRecord event={e} expanded={open} key={`${e.id}-${open}`} />
      ))}
    </div>
  );
}
function TraceRecord({
  event,
  expanded,
}: {
  event: RunEvent;
  expanded: boolean;
}) {
  const data =
    event.type === "screenshot"
      ? {
          ...event.data,
          dataUrl: "[See screenshot below or download complete trace]",
        }
      : event.data;
  return (
    <details className="trace-event" open={expanded}>
      <summary>
        <span>{event.type.replaceAll("_", " ")}</span>
        <time>{new Date(event.time).toLocaleTimeString()}</time>
      </summary>
      {event.type === "screenshot" && (
        <img
          className="trace-screenshot"
          src={event.data.dataUrl}
          alt={event.data.title || "Browser observation"}
        />
      )}
      <pre>{json(data)}</pre>
    </details>
  );
}
