import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CircleHelp,
  Code2,
  Eye,
  Globe2,
  LoaderCircle,
  Monitor,
  MousePointer2,
  Play,
  Plug,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { AppState, RunRecord, TabInfo } from "../shared/types";
import {
  api,
  json,
  statusLabels,
  time,
  TimelineEvent,
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
}: Props) {
  const [prompt, setPrompt] = useState("");
  const tabs = state.bridge.tabs.filter((tab) => {
    try {
      const url = new URL(tab.url);
      return (
        ["http:", "https:", "file:"].includes(url.protocol) &&
        !(
          url.port === window.location.port &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
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
  const endRef = useRef<HTMLDivElement>(null);
  const connected = state.bridge.connected;
  const selectedTab = tabs.find((t) => t.id === tabId);
  const shots = run?.events.filter((e) => e.type === "screenshot") || [];
  const shot =
    manualShot || (shots[shots.length - 1]?.data as Shot | undefined);
  const pauseEvents = (run?.events || []).filter((e) =>
    [
      "user_question",
      "user_reply",
      "approval_required",
      "approval_decision",
    ].includes(e.type),
  );
  const lastPause = pauseEvents[pauseEvents.length - 1];
  const lastQuestion =
    lastPause?.type === "user_question" ? lastPause : undefined;
  const waitingQuestion =
    !!lastQuestion &&
    ["running", "awaiting_approval"].includes(run?.status || "");
  const approval =
    lastPause?.type === "approval_required" ? lastPause : undefined;
  useEffect(() => {
    setManualShot(null);
    setSnapshot(null);
    setReply("");
  }, [run?.id]);
  useEffect(() => {
    setManualShot(null);
  }, [shots.length]);
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === tabId))
      setTabId(tabs.find((t) => t.active)?.id || tabs[0]?.id);
  }, [state.bridge.tabs, tabId]);
  useEffect(() => {
    if (run?.status === "running")
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [run?.events.length]);
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
    });
  }
  async function refreshBrowser(screenshotOnly = true) {
    await action(screenshotOnly ? "screenshot" : "snapshot", async () => {
      if (!tabId) throw new Error("Select a Chrome tab first.");
      const result = await api<any>("/api/browser", {
        method: "POST",
        body: json({
          action: screenshotOnly ? "browser_screenshot" : "browser_snapshot",
          args: { tabId },
        }),
      });
      if (screenshotOnly) {
        if (!result.dataUrl)
          throw new Error(
            "Chrome returned no screenshot. Choose a normal webpage and try again.",
          );
        setManualShot({
          dataUrl: result.dataUrl,
          url: result.url || selectedTab?.url,
          title: result.title || selectedTab?.title,
        });
      } else setSnapshot(result);
    });
  }
  function host(url?: string) {
    if (!url) return "Your Chrome browser";
    try {
      return new URL(url).hostname || url;
    } catch {
      return url;
    }
  }
  return (
    <>
      <section className="workspace-heading">
        <div>
          <div className="section-kicker">
            <span className="tiny-browser" /> Browser workbench
          </div>
          <h1>
            {!run
              ? "What should your browser do?"
              : run.status === "completed"
                ? "Task complete."
                : run.status === "failed"
                  ? "Task needs attention."
                  : run.status === "stopped"
                    ? "Task stopped."
                    : run.status === "awaiting_approval"
                      ? "Your input is needed."
                      : "A task in motion."}
          </h1>
          <p>
            {run
              ? "Follow the decisions, inspect the actions, stay in control."
              : "Give your browser a task. See every step it takes."}
          </p>
        </div>
        <div className="heading-actions">
          {run && (
            <a
              className="button secondary compact"
              href={`/api/runs/${run.id}/export`}
              download
            >
              <ArrowDownToLine size={15} />
              Export run
            </a>
          )}
          {busy && (
            <button
              className="button danger compact"
              disabled={pending === "stop"}
              onClick={() =>
                action("stop", async () => {
                  const stopped = await api<RunRecord>(
                    `/api/runs/${activeRun!.id}/stop`,
                    { method: "POST" },
                  );
                  if (stopped?.id) mergeRun(stopped);
                })
              }
            >
              <Square size={13} fill="currentColor" />
              Stop task
            </button>
          )}
        </div>
      </section>
      {state.runs.length > 0 && (
        <select
          className="mobile-history"
          aria-label="Recent tasks"
          value={run?.id || ""}
          onChange={(e) => {
            if (e.target.value) selectRun(e.target.value);
          }}
        >
          <option value="">Recent tasks</option>
          {state.runs.map((item) => (
            <option key={item.id} value={item.id}>
              {item.prompt}
            </option>
          ))}
        </select>
      )}
      {(!connected || !state.settings.model) && (
        <div className="setup-strip">
          <span className="setup-icon">
            <Plug size={18} />
          </span>
          <div>
            <strong>
              {!connected
                ? "One connection. Your whole browser."
                : "Choose the model that drives Relay."}
            </strong>
            <p>
              {!connected
                ? "Connect the Chrome extension to work with your existing tabs and sessions."
                : "Add an OpenAI-compatible endpoint and model to start your first task."}
            </p>
          </div>
          <button
            className="text-button"
            onClick={() => setPage(!connected ? "connection" : "settings")}
          >
            {!connected ? "Connect Chrome" : "Set up model"}
            <ArrowRight size={16} />
          </button>
        </div>
      )}
      <div className="workbench-grid">
        <section className="task-panel" aria-label="Task and activity">
          <div className="task-composer">
            <div className="panel-label">
              <span>
                <Terminal size={16} />
                {run ? "Next task" : "Your task"}
              </span>
              <span className="subtle">Plain language. Real actions.</span>
            </div>
            <textarea
              aria-label="Task prompt"
              placeholder="Find the best train options for Friday, compare the departure times, and put a shortlist together…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  if (!busy && connected && state.settings.model && !pending)
                    startRun();
                }
              }}
            />
            <div className="composer-footer">
              <span>
                <ShieldCheck size={14} />
                {state.settings.approvalMode === "always"
                  ? "Approve every action"
                  : state.settings.approvalMode === "risky"
                    ? "Approve sensitive actions"
                    : "Automatic actions"}
              </span>
              <button
                className="button primary"
                onClick={startRun}
                disabled={
                  !prompt.trim() ||
                  !connected ||
                  !state.settings.model ||
                  busy ||
                  !!pending
                }
              >
                {pending === "run" ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Play size={15} fill="currentColor" />
                )}
                Run task
              </button>
            </div>
          </div>
          <div className="activity-heading">
            <h2>
              Activity{" "}
              {run && (
                <span className={`status-pill ${run.status}`}>
                  {statusLabels[run.status]}
                </span>
              )}
            </h2>
            <span>
              {run
                ? `${run.events.length} events`
                : "Waiting for your first task"}
            </span>
          </div>
          <div className="activity-scroll" aria-live="polite">
            {run ? (
              <>
                <div className="user-task">
                  <span className="user-avatar">You</span>
                  <div>
                    <p>{run.prompt}</p>
                    <time>{time(run.createdAt)}</time>
                  </div>
                </div>
                <div className="timeline">
                  {run.events.map((event) => (
                    <TimelineEvent key={event.id} event={event} />
                  ))}
                  <div ref={endRef} />
                </div>
                {run.status === "awaiting_approval" && approval && (
                  <div className="decision-panel">
                    <span className="decision-title">
                      <ShieldCheck size={18} />
                      Your approval is needed
                    </span>
                    <p>
                      Relay wants to use <strong>{approval.data.tool}</strong>.
                    </p>
                    <details>
                      <summary>Review action details</summary>
                      <pre>{json(approval.data.args)}</pre>
                    </details>
                    <div>
                      <button
                        className="button primary"
                        disabled={!!pending}
                        onClick={() =>
                          action("approve", async () => {
                            await api(`/api/runs/${run.id}/approval`, {
                              method: "POST",
                              body: json({
                                approvalId: approval.data.id,
                                approved: true,
                              }),
                            });
                          })
                        }
                      >
                        <Check size={15} />
                        Approve once
                      </button>
                      <button
                        className="button secondary"
                        disabled={!!pending}
                        onClick={() =>
                          action("deny", async () => {
                            await api(`/api/runs/${run.id}/approval`, {
                              method: "POST",
                              body: json({
                                approvalId: approval.data.id,
                                approved: false,
                              }),
                            });
                          })
                        }
                      >
                        Deny action
                      </button>
                    </div>
                  </div>
                )}
                {waitingQuestion && (
                  <form
                    className="decision-panel"
                    onSubmit={(e) => {
                      e.preventDefault();
                      action("reply", async () => {
                        await api(`/api/runs/${run.id}/reply`, {
                          method: "POST",
                          body: json({ message: reply }),
                        });
                        setReply("");
                      });
                    }}
                  >
                    <span className="decision-title">
                      <CircleHelp size={18} />
                      Relay needs your input
                    </span>
                    <p>{String(lastQuestion?.data.question || "")}</p>
                    <textarea
                      aria-label="Reply to Relay"
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      placeholder="Your answer or additional instructions"
                    />
                    <button
                      className="button primary"
                      disabled={!reply.trim() || !!pending}
                    >
                      <Send size={15} />
                      Send answer
                    </button>
                  </form>
                )}
              </>
            ) : (
              <div className="activity-empty">
                <span className="empty-orbit">
                  <MousePointer2 size={24} />
                </span>
                <h3>A clear view of every move.</h3>
                <p>
                  Plans, browser actions, tool results, and approvals appear
                  here as your task runs.
                </p>
                <div className="transparency-note">
                  <Eye size={15} />
                  Full requests and results are always inspectable.
                </div>
              </div>
            )}
          </div>
          <div className="task-panel-footer">
            <span className={`status-dot ${streamConnected ? "online" : ""}`} />
            {streamConnected ? "Live activity" : "Reconnecting…"}
            <span>Ctrl + Enter to run</span>
          </div>
        </section>
        <section className="browser-stage" aria-label="Browser view">
          <div className="browser-stage-heading">
            <h2>
              <Monitor size={17} />
              Browser view
            </h2>
            <span className="live-badge">
              <span className={`status-dot ${connected ? "online" : ""}`} />
              {connected ? "Connected" : "Offline"}
            </span>
          </div>
          <div className="browser-window">
            <div className="browser-tabbar">
              <span className="browser-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="browser-tab">
                <Globe2 size={14} />
                <span>
                  {shot?.title || selectedTab?.title || "Your Chrome session"}
                </span>
              </span>
              <button
                className="icon-button"
                title="Refresh available tabs"
                aria-label="Refresh available tabs"
                onClick={() =>
                  action("tabs", async () => {
                    const tabs = await api<TabInfo[]>("/api/tabs");
                    setState((s) =>
                      s ? { ...s, bridge: { ...s.bridge, tabs } } : s,
                    );
                  })
                }
              >
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="browser-address">
              <ShieldCheck size={14} />
              <select
                aria-label="Chrome tab"
                value={tabId ?? ""}
                onChange={(e) => {
                  setTabId(e.target.value ? Number(e.target.value) : undefined);
                  setManualShot(null);
                }}
              >
                <option value="">Select a Chrome tab</option>
                {tabs.map((tab) => (
                  <option value={tab.id} key={tab.id}>
                    {tab.title || tab.url}
                  </option>
                ))}
              </select>
              <span title={shot?.url || selectedTab?.url}>
                {host(shot?.url || selectedTab?.url)}
              </span>
            </div>
            <div className={`browser-viewport ${shot ? "has-shot" : ""}`}>
              {shot ? (
                <img
                  src={shot.dataUrl}
                  alt={`Chrome view: ${shot.title || "current page"}`}
                />
              ) : (
                <div className="browser-placeholder">
                  <div className="browser-illustration">
                    <div className="illustration-window">
                      <div>
                        <i />
                        <i />
                        <i />
                      </div>
                      <span />
                      <span />
                      <span />
                      <MousePointer2 size={26} />
                    </div>
                    <span className="illustration-plug">
                      <Plug size={23} />
                    </span>
                  </div>
                  <h3>
                    {connected
                      ? "Your browser is ready."
                      : "Bring your own browser."}
                  </h3>
                  <p>
                    {connected
                      ? "Select a tab and take a screenshot, or start a task to watch the browser as Relay works."
                      : "Your tabs, your sessions, your tools. Connect Chrome to see your browser here."}
                  </p>
                  <button
                    className="button secondary"
                    disabled={(connected && !tabId) || !!pending}
                    onClick={() =>
                      connected ? refreshBrowser() : setPage("connection")
                    }
                  >
                    {connected ? <Eye size={15} /> : <Plug size={15} />}
                    {connected ? "Take screenshot" : "Connect Chrome"}
                  </button>
                </div>
              )}
            </div>
            <div className="browser-window-footer">
              <span>
                <Eye size={14} />
                {shot
                  ? "Latest captured screenshot"
                  : "Screenshots appear during the task"}
              </span>
              <button
                className="icon-button"
                aria-label="Take browser screenshot"
                disabled={!connected || !tabId || !!pending}
                onClick={() => refreshBrowser()}
              >
                <RefreshCw
                  size={15}
                  className={pending === "screenshot" ? "spin" : ""}
                />
              </button>
            </div>
          </div>
          <div className="browser-tools">
            <span>
              <ShieldCheck size={15} />
              You can take over in Chrome at any time.
            </span>
            <button
              className="text-button"
              disabled={!connected || !tabId || !!pending || busy}
              title={
                busy
                  ? "Stop the task before inspecting page refs."
                  : "Read a fresh page snapshot"
              }
              onClick={() => refreshBrowser(false)}
            >
              <Code2 size={14} />
              Inspect page
            </button>
          </div>
          {snapshot !== null && (
            <details className="snapshot-result" open>
              <summary>
                Current page snapshot
                <button
                  className="icon-button"
                  aria-label="Close snapshot"
                  onClick={(e) => {
                    e.preventDefault();
                    setSnapshot(null);
                  }}
                >
                  <X size={14} />
                </button>
              </summary>
              <pre>{json(snapshot)}</pre>
            </details>
          )}
          <div className="session-note">
            <span className="session-note-icon">
              <ShieldCheck size={20} />
            </span>
            <div>
              <strong>Built around your control</strong>
              <p>
                Relay uses your chosen model and the tools you enable. Change
                the instructions, inspect the requests, or stop any task.
              </p>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
