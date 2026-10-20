import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ArrowDownToLine,
  ArrowUp,
  Check,
  ChevronDown,
  Code2,
  Globe,
  LoaderCircle,
  Maximize2,
  Monitor,
  Plug,
  RefreshCw,
  Send,
  Square,
  X,
} from "lucide-react";
import ModelPicker, { tokenCount } from "./ModelPicker";
import { reasoningOptions } from "../shared/capabilities";
import ExecutionLog, { TraceView } from "./ExecutionLog";
import type { AppState, RunRecord, Settings } from "../shared/types";
import {
  api,
  AssistantMessage,
  json,
  statusLabels,
  TimelineEvent,
  ToolActivity,
  toolTitle,
  type Action,
  type Page,
  type Shot,
} from "./ui";
type Props = {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState | null>>;
  run?: RunRecord;
  activeRun?: RunRecord;
  busy: boolean;
  pending: string;
  action: Action;
  setPage: (page: Page) => void;
  selectRun: (id: string) => void;
  mergeRun: (run: RunRecord) => void;
  streamConnected: boolean;
  changeApprovalMode: (mode: Settings["approvalMode"]) => Promise<void>;
};
export default function Workbench({
  state,
  setState,
  run,
  activeRun,
  busy,
  pending,
  action,
  setPage,
  selectRun,
  mergeRun,
  streamConnected,
  changeApprovalMode,
}: Props) {
  const [prompt, setPrompt] = useState("");
  const tabs = state.bridge.tabs.filter((tab) => {
    try {
      const url = new URL(tab.url);
      return (
        ["http:", "https:", "file:"].includes(url.protocol) &&
        !(
          url.port === location.port &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )
      );
    } catch {
      return false;
    }
  });
  const [tabId, setTabId] = useState<number | undefined>(
    tabs.find((t) => t.active)?.id || tabs[0]?.id,
  );
  const [manualShot, setManualShot] = useState<Shot | null>(null);
  const [reply, setReply] = useState("");
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [activityView, setActivityView] = useState<"activity" | "trace">(
    "activity",
  );
  const [mobileView, setMobileView] = useState<"task" | "browser">("task");
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const follows = useRef(true);
  const followsBrowser = useRef(true);
  const browserRef = useRef<HTMLElement>(null);
  const shots = run?.events.filter((e) => e.type === "screenshot") || [];
  const runShot = shots.at(-1)?.data as Shot | undefined;
  const previousShot = state.runs
    .flatMap((r) =>
      r.events.filter(
        (e) => e.type === "screenshot" && (!tabId || e.data.tabId === tabId),
      ),
    )
    .sort((a, b) => b.time.localeCompare(a.time))[0]?.data as Shot | undefined;
  const shot =
    manualShot ||
    (runShot && (!tabId || !runShot.tabId || runShot.tabId === tabId)
      ? runShot
      : previousShot);
  const selectedTab = tabs.find((t) => t.id === tabId);
  const pause = [...(run?.events || [])]
    .reverse()
    .find((e) =>
      [
        "approval_required",
        "approval_decision",
        "user_question",
        "user_reply",
      ].includes(e.type),
    );
  const approval =
    run?.status === "awaiting_approval" && pause?.type === "approval_required"
      ? pause
      : undefined;
  const question =
    run?.status === "awaiting_approval" && pause?.type === "user_question"
      ? pause
      : undefined;
  const latestContext = run?.events.findLast(
    (e) => e.type === "context_usage",
  )?.data;
  const latestUsage = run?.events.findLast((e) => e.type === "model_response")
    ?.data.usage;
  const inputTokens =
    latestUsage?.prompt_tokens ?? latestContext?.estimatedTokens;
  const contextWindow =
    latestContext?.contextWindow ||
    state.modelInfo?.contextWindow ||
    state.settings.contextWindow;
  const reasoningChoices = reasoningOptions(state.settings, state.modelInfo);
  async function runOptions(options: Partial<Settings>) {
    await action("run-options", async () => {
      const result = await api<{ settings: Settings; hasApiKey: boolean }>(
        "/api/run-options",
        { method: "PUT", body: json(options) },
      );
      setState((old) => (old ? { ...old, ...result } : old));
    });
  }
  async function stopRun() {
    if (!activeRun) return;
    await action("stop", () =>
      api(`/api/runs/${activeRun.id}/stop`, { method: "POST" }),
    );
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        activeRun &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        void stopRun();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [activeRun?.id]);
  useEffect(() => {
    if (!tabs.some((t) => t.id === tabId))
      setTabId(tabs.find((t) => t.active)?.id || tabs[0]?.id);
  }, [state.bridge.tabs, tabId]);
  useEffect(() => {
    setManualShot(null);
    setSnapshot(null);
    setReply("");
    follows.current = true;
    followsBrowser.current = true;
  }, [run?.id]);
  useEffect(() => {
    setManualShot(null);
    if (followsBrowser.current && runShot?.tabId) setTabId(runShot.tabId);
  }, [shots.length, run?.id]);
  useEffect(() => {
    if (follows.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [run?.events.length, activityView]);
  async function startRun() {
    if (!prompt.trim()) return;
    await action("run", async () => {
      const created = await api<RunRecord>("/api/runs", {
        method: "POST",
        body: json({ prompt: prompt.trim(), tabId }),
      });
      mergeRun(created);
      selectRun(created.id);
      setPrompt("");
      setManualShot(null);
      setMobileView("task");
    });
  }
  async function capture(inspect = false) {
    await action(inspect ? "snapshot" : "screenshot", async () => {
      const result = await api<any>("/api/browser", {
        method: "POST",
        body: json({
          action: inspect ? "browser_snapshot" : "browser_screenshot",
          args: { tabId },
        }),
      });
      if (inspect) setSnapshot(result);
      else {
        if (!result.dataUrl) throw new Error("No screenshot returned.");
        setManualShot(result);
      }
    });
  }
  const canRun =
    !!prompt.trim() &&
    state.bridge.connected &&
    !!state.settings.model &&
    !busy &&
    !pending;
  return (
    <div className={`workspace mobile-${mobileView}`}>
      <div className="mobile-view-tabs">
        <button
          className={mobileView === "task" ? "selected" : ""}
          onClick={() => setMobileView("task")}
        >
          Task
        </button>
        <button
          className={mobileView === "browser" ? "selected" : ""}
          onClick={() => setMobileView("browser")}
        >
          Browser
        </button>
        <select
          aria-label="Recent tasks"
          value={run?.id || ""}
          onChange={(e) => e.target.value && selectRun(e.target.value)}
        >
          <option value="">Recent tasks</option>
          {state.runs.map((r) => (
            <option value={r.id} key={r.id}>
              {r.prompt}
            </option>
          ))}
        </select>
      </div>
      <section className="task-panel" aria-label="Task and activity">
        <div className="panel-toolbar">
          <div className="view-tabs">
            <button
              className={activityView === "activity" ? "selected" : ""}
              onClick={() => setActivityView("activity")}
            >
              Activity
            </button>
            <button
              className={activityView === "trace" ? "selected" : ""}
              onClick={() => setActivityView("trace")}
            >
              Trace
            </button>
          </div>
          <div className="panel-toolbar-right">
            {run && (
              <span className={`run-status ${run.status}`} role="status">
                <i className={`status-dot ${run.status}`} />
                {statusLabels[run.status]}
              </span>
            )}
            {run && (
              <a
                className="icon-button"
                href={`/api/runs/${run.id}/export`}
                download
                aria-label="Export run"
                title="Export run"
              >
                <ArrowDownToLine size={15} />
              </a>
            )}
          </div>
        </div>
        {(approval || question) && (
          <div
            className="decision-panel"
            role="region"
            aria-label={approval ? "Approval required" : "Reply required"}
          >
            {approval ? (
              <>
                <strong>
                  {toolTitle(approval.data.tool, approval.data.args)}
                </strong>
                <details>
                  <summary>Action details</summary>
                  <pre>
                    {json({
                      tool: approval.data.tool,
                      args: approval.data.args,
                    })}
                  </pre>
                </details>
                <div className="decision-actions">
                  <button
                    className="button primary"
                    disabled={!!pending}
                    onClick={() =>
                      action("approve", async () => {
                        await api(`/api/runs/${run!.id}/approval`, {
                          method: "POST",
                          body: json({
                            approvalId: approval.data.id,
                            approved: true,
                          }),
                        });
                      })
                    }
                  >
                    <Check size={14} />
                    Approve once
                  </button>
                  <button
                    className="button secondary"
                    disabled={!!pending}
                    onClick={() =>
                      action("deny", async () => {
                        await api(`/api/runs/${run!.id}/approval`, {
                          method: "POST",
                          body: json({
                            approvalId: approval.data.id,
                            approved: false,
                          }),
                        });
                      })
                    }
                  >
                    Deny
                  </button>
                </div>
                <button
                  className="text-button"
                  disabled={!!pending}
                  onClick={() => changeApprovalMode("never")}
                >
                  Auto-approve and continue
                </button>
              </>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  action("reply", async () => {
                    await api(`/api/runs/${run!.id}/reply`, {
                      method: "POST",
                      body: json({ message: reply }),
                    });
                    setReply("");
                  });
                }}
              >
                <strong>Relay needs your input</strong>
                <p>{String(question!.data.question)}</p>
                <div className="reply-row">
                  <input
                    aria-label="Reply to Relay"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    autoFocus
                    placeholder="Your answer"
                  />
                  <button
                    className="button primary"
                    aria-label="Send answer"
                    disabled={!reply.trim() || !!pending}
                  >
                    <Send size={15} />
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
        <div
          className="activity-scroll"
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (el)
              follows.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
          aria-live="polite"
        >
          {run ? (
            <>
              <div className="user-message">{run.prompt}</div>
              {activityView === "trace" ? (
                <TraceView events={run.events} />
              ) : (
                <>
                  <ExecutionLog run={run} key={run.id} />
                  {run.events
                    .filter(
                      (e) =>
                        e.type === "model_response" &&
                        !e.data.message?.tool_calls?.length &&
                        e.data.message?.content,
                    )
                    .map((e) => (
                      <AssistantMessage
                        key={e.id}
                        content={String(e.data.message.content)}
                      />
                    ))}
                  {run.events
                    .filter((e) => ["error", "user_reply"].includes(e.type))
                    .map((e) => (
                      <div
                        className={
                          e.type === "error" ? "activity-error" : "user-message"
                        }
                        key={e.id}
                      >
                        {String(e.data.message)}
                      </div>
                    ))}
                </>
              )}
              {run.status === "running" && (
                <div className="working-indicator">
                  <LoaderCircle size={14} className="spin" />
                  Generating
                  <button
                    type="button"
                    className="text-button"
                    onClick={stopRun}
                  >
                    Stop
                  </button>
                </div>
              )}
              {run.status === "stopped" && (
                <div className="stopped-message">
                  Stopped{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setPrompt(run.prompt)}
                  >
                    Edit & retry
                  </button>
                </div>
              )}
              <div ref={bottomRef} />
            </>
          ) : (
            <div className="task-empty">
              <span className="empty-cursor">
                <Globe size={32} strokeWidth={1.3} />
              </span>
            </div>
          )}
        </div>
        <form
          className="task-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (canRun) startRun();
          }}
        >
          <div className="composer-model-row">
            <ModelPicker
              model={state.settings.model}
              disabled={pending === "run-options"}
              onSelect={(model) => runOptions({ model })}
            />
            <select
              aria-label="Reasoning level"
              value={state.settings.reasoningEffort}
              onChange={(e) =>
                runOptions({
                  reasoningEffort: e.target
                    .value as Settings["reasoningEffort"],
                })
              }
              title={busy ? "For the next task" : "Reasoning level"}
              disabled={pending === "run-options"}
            >
              {reasoningChoices.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <textarea
            aria-label="Task prompt"
            placeholder="Ask Relay to do something…"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                if (canRun) startRun();
              }
            }}
          />
          <div className="composer-controls">
            <span
              className={`connection-state ${streamConnected ? "" : "disconnected"}`}
              title={
                latestContext?.inputBudget &&
                latestContext.inputBudget < contextWindow * 0.9
                  ? `Endpoint advertises ${contextWindow.toLocaleString()} tokens; working input budget ${Math.floor(latestContext.inputBudget).toLocaleString()} after a context rejection. ${streamConnected ? "Server connected" : "Reconnecting"}`
                  : streamConnected
                    ? "Server connected"
                    : "Reconnecting to server"
              }
            >
              <i
                className={`status-dot ${streamConnected ? "completed" : "offline"}`}
              />
              {inputTokens != null
                ? `${latestUsage?.prompt_tokens == null ? "~" : ""}${tokenCount(inputTokens)} / ${tokenCount(contextWindow)}`
                : `${tokenCount(contextWindow)} context`}
              {latestContext?.inputBudget &&
                latestContext.inputBudget < contextWindow * 0.9 && (
                  <span className="budget-adjusted">
                    {tokenCount(latestContext.inputBudget)} input budget
                  </span>
                )}
              {busy && (
                <span className="next-task-label">Changes apply next task</span>
              )}
            </span>
            {busy ? (
              <button
                className="run-button stop-generation"
                type="button"
                aria-label="Stop generation"
                title="Stop (Escape)"
                disabled={pending === "stop"}
                onClick={stopRun}
              >
                <Square size={16} fill="currentColor" />
              </button>
            ) : (
              <button
                className="run-button"
                type="submit"
                aria-label="Run task"
                title="Run task (Ctrl+Enter)"
                disabled={!canRun}
              >
                {pending === "run" ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <ArrowUp size={18} />
                )}
              </button>
            )}
          </div>
        </form>
      </section>
      <section
        className="browser-stage"
        aria-label="Browser view"
        ref={browserRef}
      >
        <div className="browser-toolbar">
          <Globe size={15} />
          <select
            aria-label="Chrome tab"
            value={tabId ?? ""}
            onChange={(e) => {
              followsBrowser.current = false;
              setTabId(e.target.value ? Number(e.target.value) : undefined);
              setManualShot(null);
            }}
          >
            <option value="">Select tab</option>
            {tabs.map((t) => (
              <option value={t.id} key={t.id}>
                {t.title || t.url}
              </option>
            ))}
          </select>
          <div className="browser-actions">
            <button
              className="icon-button"
              aria-label="Inspect page"
              title={
                busy ? "Stop the task before inspecting refs" : "Inspect page"
              }
              disabled={!state.bridge.connected || !tabId || !!pending || busy}
              onClick={() => capture(true)}
            >
              <Code2 size={16} />
            </button>
            <button
              className="icon-button"
              aria-label="Take browser screenshot"
              title="Refresh screenshot"
              disabled={!state.bridge.connected || !tabId || !!pending}
              onClick={() => capture()}
            >
              <RefreshCw
                size={16}
                className={pending === "screenshot" ? "spin" : ""}
              />
            </button>
            <button
              className="icon-button"
              aria-label="Expand browser view"
              title="Expand browser view"
              onClick={() => {
                if (document.fullscreenElement)
                  document.exitFullscreen().catch(() => {});
                else browserRef.current?.requestFullscreen().catch(() => {});
              }}
            >
              <Maximize2 size={16} />
            </button>
          </div>
        </div>
        {shot?.url && (
          <div className="browser-url" title={shot.url}>
            {shot.url}
          </div>
        )}
        <div className={`browser-viewport ${shot ? "has-shot" : ""}`}>
          {shot ? (
            <img
              src={shot.dataUrl}
              alt={`Chrome view: ${shot.title || "current page"}`}
            />
          ) : (
            <div className="browser-empty">
              <Monitor size={32} strokeWidth={1.25} />
              <h2>
                {state.bridge.connected
                  ? "Chrome is connected"
                  : "Connect Chrome"}
              </h2>
              <button
                className="button secondary"
                disabled={state.bridge.connected && (!tabId || !!pending)}
                onClick={() =>
                  state.bridge.connected ? capture() : setPage("connection")
                }
              >
                {state.bridge.connected ? (
                  <>
                    <RefreshCw size={14} />
                    Take screenshot
                  </>
                ) : (
                  <>
                    <Plug size={14} />
                    Connect Chrome
                  </>
                )}
              </button>
            </div>
          )}
        </div>
        {snapshot !== null && (
          <div className="snapshot-drawer">
            <div className="panel-toolbar">
              <strong>Page snapshot</strong>
              <button
                className="icon-button"
                aria-label="Close snapshot"
                onClick={() => setSnapshot(null)}
              >
                <X size={16} />
              </button>
            </div>
            <pre>{json(snapshot)}</pre>
          </div>
        )}
      </section>
    </div>
  );
}
