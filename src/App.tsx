import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  LoaderCircle,
  Plus,
  Plug,
  Route,
  Settings2,
  Square,
  X,
} from "lucide-react";
import type {
  AppState,
  CustomTool,
  RunEvent,
  RunRecord,
  Settings,
} from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { api, json, type Action, type Page, type Pairing } from "./ui";
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
  const run = state?.runs.find((r) => r.id === selectedId);
  const activeRun = state?.runs.find((r) => r.id === state.activeRunId);
  const busy =
    !!activeRun && ["running", "awaiting_approval"].includes(activeRun.status);
  function mergeRun(incoming: RunRecord) {
    setState((previous) => {
      if (!previous) return previous;
      const old = previous.runs.find((r) => r.id === incoming.id);
      const older =
        (incoming.events.at(-1)?.id || 0) < (old?.events.at(-1)?.id || 0);
      const events = [
        ...new Map(
          [...(old?.events || []), ...incoming.events].map((event) => [
            event.id,
            event,
          ]),
        ).values(),
      ].sort((a, b) => a.id - b.id);
      const merged = {
        ...(older ? incoming : old),
        ...(older ? old : incoming),
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
    let source: EventSource | undefined;
    let cancelled = false;
    api<AppState>("/api/state")
      .then((initial) => {
        if (cancelled) return;
        setState(initial);
        setDraft(initial.settings);
        setCustomText(json(initial.settings.customTools));
        setSelectedId(initial.activeRunId || initial.runs[0]?.id || null);
        source = new EventSource("/api/events");
        source.onopen = () => setStreamConnected(true);
        source.onerror = () => setStreamConnected(false);
        source.addEventListener("state", (event) =>
          setState(JSON.parse((event as MessageEvent).data)),
        );
        source.addEventListener("bridge", (event) =>
          setState((old) =>
            old
              ? { ...old, bridge: JSON.parse((event as MessageEvent).data) }
              : old,
          ),
        );
        source.addEventListener("run", (event) => {
          const record: RunRecord = JSON.parse((event as MessageEvent).data);
          mergeRun(record);
          if (record.events.length === 1) setSelectedId(record.id);
        });
        source.addEventListener("settings", (event) => {
          const settings = JSON.parse((event as MessageEvent).data);
          setState((old) => (old ? { ...old, ...settings } : old));
          setDraft((old) => ({
            ...old,
            approvalMode: settings.settings.approvalMode,
          }));
        });
        source.addEventListener("run_status", (event) => {
          const update = JSON.parse((event as MessageEvent).data);
          setState((old) =>
            old
              ? {
                  ...old,
                  activeRunId: ["running", "awaiting_approval"].includes(
                    update.status,
                  )
                    ? update.id
                    : old.activeRunId === update.id
                      ? null
                      : old.activeRunId,
                  runs: old.runs.map((r) =>
                    r.id === update.id ? { ...r, ...update } : r,
                  ),
                }
              : old,
          );
        });
        source.addEventListener("event", (event) => {
          const update = JSON.parse((event as MessageEvent).data) as {
            runId: string;
            event: RunEvent;
          };
          setState((old) => {
            if (!old) return old;
            const status =
              update.event.type === "status"
                ? (update.event.data.status as RunRecord["status"])
                : undefined;
            return {
              ...old,
              activeRunId: status
                ? ["running", "awaiting_approval"].includes(status)
                  ? update.runId
                  : old.activeRunId === update.runId
                    ? null
                    : old.activeRunId
                : old.activeRunId,
              runs: old.runs.map((r) =>
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
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      source?.close();
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
    const timer = setTimeout(() => setNotice(""), 3000);
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
    setDraft((old) => ({ ...old, [key]: value }));
  }
  async function saveSettings() {
    await action("save", async () => {
      let customTools: CustomTool[];
      try {
        customTools = JSON.parse(customText);
      } catch {
        throw new Error("Custom tools must be valid JSON.");
      }
      if (!Array.isArray(customTools))
        throw new Error("Custom tools must be an array.");
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
      setState((old) => (old ? { ...old, ...result } : old));
      setApiKey("");
      setKeyChanged(false);
      setNotice("Saved");
    });
  }
  async function changeApprovalMode(mode: Settings["approvalMode"]) {
    await action("approval-mode", async () => {
      const result = await api<{ settings: Settings; hasApiKey: boolean }>(
        "/api/approval-mode",
        { method: "PUT", body: json({ mode }) },
      );
      setState((old) => (old ? { ...old, ...result } : old));
      update("approvalMode", mode);
    });
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("Copied");
    } catch {
      setError("Select the text and copy it manually.");
    }
  }
  const pageTitle =
    page === "workbench" ? run?.prompt || "New task" : "Settings";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          aria-label="Relay workbench"
          onClick={() => setPage("workbench")}
        >
          <Route size={22} />
          <span>Relay</span>
        </button>
        <button
          className="new-task"
          aria-label="New task"
          title="New task"
          onClick={() => {
            setSelectedId(null);
            setPage("workbench");
          }}
        >
          <Plus size={17} />
          <span>New task</span>
        </button>
        <div className="run-list" aria-label="Task history">
          {state?.runs.map((item) => (
            <button
              key={item.id}
              title={item.prompt}
              aria-label={item.prompt}
              className={`run-item ${selectedId === item.id && page === "workbench" ? "selected" : ""}`}
              onClick={() => {
                setSelectedId(item.id);
                setPage("workbench");
              }}
            >
              <span className={`status-dot ${item.status}`} />
              <span className="run-title">{item.prompt}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className={`sidebar-item ${page === "connection" ? "selected" : ""}`}
            aria-label="Chrome connection"
            title="Chrome connection"
            onClick={() => setPage("connection")}
          >
            <Plug size={17} />
            <span>Chrome</span>
            <i
              className={`status-dot ${state?.bridge.connected ? "completed" : "offline"}`}
            />
          </button>
          <button
            className={`sidebar-item ${!["workbench", "connection"].includes(page) ? "selected" : ""}`}
            aria-label="Settings"
            title="Settings"
            onClick={() => setPage("settings")}
          >
            <Settings2 size={17} />
            <span>Settings</span>
          </button>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <h1 title={pageTitle}>{pageTitle}</h1>
          <div className="topbar-actions">
            {page === "workbench" && state && (
              <label
                className="auto-control"
                title="Automatically run enabled tools. Questions still pause for your answer."
              >
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Auto-approve"
                  checked={state.settings.approvalMode === "never"}
                  disabled={pending === "approval-mode"}
                  onChange={(e) =>
                    changeApprovalMode(e.target.checked ? "never" : "risky")
                  }
                />
                <span className="switch" aria-hidden="true" />
                <span>Auto-approve</span>
              </label>
            )}
            {busy && (
              <button
                className="button danger compact"
                disabled={pending === "stop"}
                onClick={() =>
                  action("stop", async () => {
                    await api(`/api/runs/${activeRun!.id}/stop`, {
                      method: "POST",
                    });
                  })
                }
              >
                <Square size={12} fill="currentColor" />
                Stop
              </button>
            )}
            <button
              className="model-button"
              aria-label="Model settings"
              title={state?.settings.model || "Set up model"}
              onClick={() => setPage("settings")}
            >
              {state?.settings.model || "Set up model"}
              <ArrowUpRight size={13} />
            </button>
          </div>
        </header>
        {error && (
          <div className="message error" role="alert">
            <CircleAlert size={17} />
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <Check size={15} />
            {notice}
          </div>
        )}
        {!state ? (
          <div className="loading-state">
            <LoaderCircle size={22} className="spin" />
            <span>Connecting…</span>
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
            selectRun={setSelectedId}
            mergeRun={mergeRun}
            streamConnected={streamConnected}
            changeApprovalMode={changeApprovalMode}
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
