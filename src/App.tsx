import { useEffect, useState } from "react";
import {
  ArrowRight,
  Braces,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  FileText,
  History,
  LoaderCircle,
  MousePointer2,
  Plug,
  Plus,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Unplug,
  X,
} from "lucide-react";
import type {
  AppState,
  BridgeStatus,
  CustomTool,
  RunEvent,
  RunRecord,
  Settings,
} from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import {
  api,
  json,
  statusLabels,
  time,
  type Page,
  type Pairing,
  type Action,
} from "./ui";
import Workbench from "./Workbench";
import Configuration from "./Configuration";

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [page, setPage] = useState<Page>("workbench");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyChanged, setKeyChanged] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [customText, setCustomText] = useState("[]");
  const [streamConnected, setStreamConnected] = useState(false);
  const connected = !!state?.bridge.connected;
  const run = state?.runs.find((r) => r.id === selectedId);
  const activeRun = state?.runs.find((r) => r.id === state.activeRunId);
  const busy =
    !!activeRun && ["running", "awaiting_approval"].includes(activeRun.status);
  function mergeRun(incoming: RunRecord) {
    setState((previous) => {
      if (!previous) return previous;
      const existing = previous.runs.find((r) => r.id === incoming.id);
      // A fast local model may stream events before POST /runs returns its
      // initial snapshot. Reconcile by event ID instead of erasing live events.
      const older =
        (incoming.events.at(-1)?.id || 0) < (existing?.events.at(-1)?.id || 0);
      const events = [
        ...new Map(
          [...(existing?.events || []), ...incoming.events].map((event) => [
            event.id,
            event,
          ]),
        ).values(),
      ].sort((a, b) => a.id - b.id);
      const merged = {
        ...(older ? incoming : existing),
        ...(older ? existing : incoming),
        events,
      } as RunRecord;
      return {
        ...previous,
        activeRunId: ["running", "awaiting_approval"].includes(merged.status)
          ? merged.id
          : previous.activeRunId === merged.id
            ? null
            : previous.activeRunId,
        runs: [
          merged,
          ...previous.runs.filter((r) => r.id !== incoming.id),
        ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      };
    });
  }
  useEffect(() => {
    let events: EventSource | undefined;
    let cancelled = false;
    api<AppState>("/api/state")
      .then((initial) => {
        if (cancelled) return;
        setState(initial);
        setDraft(initial.settings);
        setCustomText(json(initial.settings.customTools));
        setSelectedId(initial.activeRunId || initial.runs[0]?.id || null);
        events = new EventSource("/api/events");
        events.onopen = () => setStreamConnected(true);
        events.onerror = () => setStreamConnected(false);
        events.addEventListener("state", (event) =>
          setState(JSON.parse((event as MessageEvent).data)),
        );
        events.addEventListener("bridge", (event) =>
          setState((previous) =>
            previous
              ? {
                  ...previous,
                  bridge: JSON.parse(
                    (event as MessageEvent).data,
                  ) as BridgeStatus,
                }
              : previous,
          ),
        );
        events.addEventListener("run", (event) =>
          mergeRun(JSON.parse((event as MessageEvent).data)),
        );
        events.addEventListener("run_status", (event) => {
          const update = JSON.parse((event as MessageEvent).data) as Pick<
            RunRecord,
            "id" | "status" | "updatedAt"
          >;
          setState((previous) =>
            previous
              ? {
                  ...previous,
                  activeRunId: ["running", "awaiting_approval"].includes(
                    update.status,
                  )
                    ? update.id
                    : previous.activeRunId === update.id
                      ? null
                      : previous.activeRunId,
                  runs: previous.runs.map((r) =>
                    r.id === update.id
                      ? {
                          ...r,
                          status: update.status,
                          updatedAt: update.updatedAt,
                        }
                      : r,
                  ),
                }
              : previous,
          );
        });
        events.addEventListener("settings", (event) =>
          setState((previous) =>
            previous
              ? { ...previous, ...JSON.parse((event as MessageEvent).data) }
              : previous,
          ),
        );
        events.addEventListener("event", (event) => {
          const update = JSON.parse((event as MessageEvent).data) as {
            runId: string;
            event: RunEvent;
          };
          setState((previous) => {
            if (!previous) return previous;
            const status =
              update.event.type === "status"
                ? (update.event.data.status as RunRecord["status"])
                : undefined;
            return {
              ...previous,
              activeRunId: status
                ? ["running", "awaiting_approval"].includes(status)
                  ? update.runId
                  : previous.activeRunId === update.runId
                    ? null
                    : previous.activeRunId
                : previous.activeRunId,
              runs: previous.runs.map((r) =>
                r.id === update.runId &&
                !r.events.some((e) => e.id === update.event.id)
                  ? {
                      ...r,
                      ...(status ? { status } : {}),
                      events: [...r.events, update.event],
                      updatedAt: update.event.time,
                    }
                  : r,
              ),
            };
          });
        });
      })
      .catch((e) =>
        setError(
          `${e.message} Make sure the Relay server is running, then reload.`,
        ),
      );
    return () => {
      cancelled = true;
      events?.close();
    };
  }, []);
  useEffect(() => {
    if (page === "connection")
      api<Pairing>("/api/pairing")
        .then(setPairing)
        .catch((e) => setError(e.message));
  }, [page]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  const action: Action = async (name, task) => {
    setPending(name);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending("");
    }
  };
  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function saveSettings() {
    await action("save", async () => {
      let customTools: CustomTool[];
      try {
        customTools = JSON.parse(customText);
      } catch {
        throw new Error(
          "Custom tools must contain valid JSON. Check the editor, then save again.",
        );
      }
      if (!Array.isArray(customTools))
        throw new Error("Custom tools must be a JSON array.");
      const result = await api<{ settings: Settings; hasApiKey: boolean }>(
        "/api/settings",
        {
          method: "PUT",
          body: json({
            ...draft,
            customTools,
            ...(keyChanged ? { apiKey } : {}),
          }),
        },
      );
      setDraft(result.settings);
      setCustomText(json(result.settings.customTools));
      setState((previous) =>
        previous ? { ...previous, ...result } : previous,
      );
      setApiKey("");
      setKeyChanged(false);
      setNotice("Settings saved. New runs use these settings.");
    });
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied to clipboard.");
    } catch {
      setError(
        "Clipboard access is unavailable. Select and copy the text manually.",
      );
    }
  }
  const nav = [
    { id: "workbench" as Page, icon: MousePointer2, label: "Workbench" },
    { id: "connection" as Page, icon: Plug, label: "Chrome connection" },
    {
      id: "settings" as Page,
      icon: SlidersHorizontal,
      label: "Model settings",
    },
    { id: "instructions" as Page, icon: FileText, label: "Agent instructions" },
    { id: "tools" as Page, icon: Braces, label: "Tools" },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => setPage("workbench")}
          aria-label="Relay workbench"
        >
          <span className="brand-mark">
            <ArrowRight size={21} strokeWidth={2.8} />
          </span>
          <span>
            Relay<span className="brand-caption">Your browser, directed.</span>
          </span>
        </button>
        <button
          className="new-task"
          onClick={() => {
            setSelectedId(null);
            setPage("workbench");
          }}
        >
          <Plus size={17} /> New task
        </button>
        <nav aria-label="Main navigation">
          {nav.map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              title={item.label}
              aria-current={page === item.id ? "page" : undefined}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === "connection" && (
                <i className={`status-dot ${connected ? "online" : ""}`} />
              )}
            </button>
          ))}
        </nav>
        <div className="history-heading">
          <History size={15} />
          <span>Recent tasks</span>
          <span className="count">{state?.runs.length || 0}</span>
        </div>
        <div className="run-list">
          {state?.runs.length ? (
            state.runs.map((item) => (
              <button
                key={item.id}
                className={`run-item ${selectedId === item.id && page === "workbench" ? "selected" : ""}`}
                onClick={() => {
                  setSelectedId(item.id);
                  setPage("workbench");
                }}
              >
                <span className={`run-indicator ${item.status}`} />
                <span>
                  <span className="run-title">{item.prompt}</span>
                  <span className="run-meta">
                    {statusLabels[item.status]}{" "}
                    <span>{time(item.createdAt)}</span>
                  </span>
                </span>
              </button>
            ))
          ) : (
            <p className="history-empty">
              Your tasks will appear here.
              <br />
              Each action stays inspectable.
            </p>
          )}
        </div>
        <button
          className="sidebar-connection"
          onClick={() => setPage("connection")}
        >
          <span className={`connection-symbol ${connected ? "connected" : ""}`}>
            {connected ? <Plug size={18} /> : <Unplug size={18} />}
          </span>
          <span>
            <strong>{connected ? "Chrome connected" : "Connect Chrome"}</strong>
            <small>
              {connected
                ? `${state?.bridge.tabs.length || 0} tabs available`
                : "Use your existing browser"}
            </small>
          </span>
          <ChevronRight size={15} />
        </button>
        <div className="local-footer">
          <ShieldCheck size={13} /> Runs locally on your computer{" "}
          <span
            className={`status-dot ${streamConnected ? "online" : ""}`}
            title={
              streamConnected ? "Server connected" : "Reconnecting to server"
            }
          />
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Personal workspace <ChevronRight size={14} />
            <strong>{nav.find((item) => item.id === page)?.label}</strong>
          </div>
          <div className="topbar-actions">
            <span className="model-indicator">
              <span
                className={`status-dot ${state?.settings.model ? "online" : ""}`}
              />
              {state?.settings.model || "No model configured"}
            </span>
            <button
              className="icon-button"
              aria-label="Model settings"
              onClick={() => setPage("settings")}
            >
              <Settings2 size={18} />
            </button>
          </div>
        </header>
        {error && (
          <div className="message error" role="alert">
            <CircleHelp size={17} />
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <CheckCheck size={17} />
            {notice}
          </div>
        )}
        {!state ? (
          <div className="loading-state">
            <LoaderCircle size={26} className="spin" />
            <h1>Opening your workspace</h1>
            <p>Connecting to the local Relay server.</p>
          </div>
        ) : page === "workbench" ? (
          <Workbench
            state={state}
            setState={setState}
            run={run}
            activeRun={activeRun}
            busy={busy}
            pending={pending}
            action={action}
            setPage={setPage}
            selectRun={(id) => setSelectedId(id)}
            mergeRun={mergeRun}
            streamConnected={streamConnected}
          />
        ) : (
          <Configuration
            state={state}
            draft={draft}
            update={update}
            page={page}
            setPage={setPage}
            pending={pending}
            action={action}
            saveSettings={saveSettings}
            apiKey={apiKey}
            setApiKey={(value) => {
              setApiKey(value);
              setKeyChanged(true);
            }}
            keyChanged={keyChanged}
            pairing={pairing}
            setPairing={setPairing}
            customText={customText}
            setCustomText={setCustomText}
            copy={copy}
            notice={setNotice}
          />
        )}
      </main>
    </div>
  );
}
