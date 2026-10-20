import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  History,
  LoaderCircle,
  Plus,
  Route,
  Settings2,
  Moon,
  Sun,
  X,
} from "lucide-react";
import type { AppState, RunEvent, RunRecord, Settings, TabInfo } from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { api, json, type Action, type Page } from "./ui";
import { RuntimeEventSource as EventSource } from "./transport";
import Workbench from "./Workbench";
import Configuration from "./Configuration";
import HistoryDialog from "./HistoryDialog";
import { applyTheme, readTheme } from "./theme";
import { readVisibleModels } from "./modelVisibility";

export default function App() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const historyDialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
  const [providerName, setProviderName] = useState("");
  const providerRef = useRef<string | undefined>(undefined);
  const [page, setPage] = useState<Page>("workbench");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newChatVersion, setNewChatVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyChanged, setKeyChanged] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const stateRef = useRef<AppState | null>(null);
  const selectedRef = useRef<string | null>(null);
  const reconciling = useRef(false);
  const reconcileRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    stateRef.current = state;
    selectedRef.current = selectedId;
  });
  const run = state?.runs.find((r) => r.id === selectedId);
  const activeRun = state?.runs.find((r) => r.id === state.activeRunId);
  const busy =
    !!activeRun && ["running", "awaiting_approval"].includes(activeRun.status);
  function mergeRun(incoming: RunRecord) {
    setState((previous) => {
      if (!previous) return previous;
      const existing = previous.runs.find((r) => r.id === incoming.id);
      if ((incoming.revision || 0) < (existing?.revision || 0)) return previous;
      const old = incoming.revision === existing?.revision ? existing : undefined;
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
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      };
    });
  }
  // The live event port can drop or stall (the worker restarts, Chrome closes the port, the panel
  // was hidden). Events sent meanwhile are not replayed, so compare against the stored run and
  // re-fetch whatever is missing instead of trusting the stream alone.
  async function reconcile() {
    if (reconciling.current) return;
    reconciling.current = true;
    try {
      const fresh = await api<AppState>("/api/state");
      const local = stateRef.current;
      if (!local) return;
      const wanted = new Set(
        [selectedRef.current, fresh.activeRunId, local.activeRunId].filter(
          (id): id is string => !!id,
        ),
      );
      for (const id of wanted) {
        const stored = fresh.runs.find((r) => r.id === id);
        if (!stored) continue;
        const mine = local.runs.find((r) => r.id === id);
        if (
          !mine ||
          mine.status !== stored.status ||
          (mine.revision || 0) !== (stored.revision || 0) ||
          (stored.lastEventId ?? 0) > (mine.events.at(-1)?.id ?? 0)
        )
          mergeRun(await api<RunRecord>(`/api/runs/${id}`));
      }
      setState((old) =>
        old && old.activeRunId !== fresh.activeRunId
          ? { ...old, activeRunId: fresh.activeRunId }
          : old,
      );
    } catch {
      /* the next tick retries */
    } finally {
      reconciling.current = false;
    }
  }
  reconcileRef.current = reconcile;
  const watching =
    !!state &&
    (!!state.activeRunId ||
      (!!run && ["running", "awaiting_approval"].includes(run.status)));
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void reconcileRef.current(), 4000);
    return () => clearInterval(timer);
  }, [watching]);
  // Coming back to the panel (switching tabs, refocusing the window) re-syncs runs and the tab
  // list, which a dropped event connection would otherwise leave stale until a reload.
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== "visible") return;
      void reconcileRef.current();
      api<TabInfo[]>("/api/tabs")
        .then((tabs) =>
          setState((old) =>
            old ? { ...old, bridge: { ...old.bridge, tabs } } : old,
          ),
        )
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, []);
  useEffect(() => {
    let source: EventSource | undefined;
    let cancelled = false;
    api<AppState>("/api/state")
      .then((initial) => {
        if (cancelled) return;
        setState(initial);
        providerRef.current = initial.activeProviderId;
        setDraft(initial.settings);
        setProviderName(initial.providers.find(provider => provider.id === initial.activeProviderId)?.name || "Provider");
        setSelectedId(initial.activeRunId || initial.runs[0]?.id || null);
        source = new EventSource("/api/events");
        source.onopen = () => setStreamConnected(true);
        source.onerror = () => setStreamConnected(false);
        source.addEventListener("state", (event) => {
          const incoming: AppState = JSON.parse(event.data);
          setTimeout(() => void reconcileRef.current(), 0);
          setState((old) => ({
            ...incoming,
            runs: incoming.runs.map((record) => {
              const previous = old?.runs.find((item) => item.id === record.id);
              return previous?.events.length && previous.revision === record.revision
                ? {
                    ...record,
                    events: [
                      ...new Map(
                        [...previous.events, ...record.events].map((item) => [
                          item.id,
                          item,
                        ]),
                      ).values(),
                    ].sort((a, b) => a.id - b.id),
                  }
                : record;
            }),
          }));
        });
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
          if (settings.activeProviderId !== providerRef.current) {
            setApiKey(""); setKeyChanged(false); setDraft(settings.settings);
            providerRef.current = settings.activeProviderId;
          }
          setState((old) => (old ? { ...old, ...settings } : old));
          setProviderName(settings.providers?.find((provider: { id: string }) => provider.id === settings.activeProviderId)?.name || "Provider");
          setDraft((old) => ({
            ...old,
            baseUrl: settings.settings.baseUrl,
            approvalMode: settings.settings.approvalMode,
            model: settings.settings.model,
            reasoningEffort: settings.settings.reasoningEffort,
            contextWindow: settings.settings.contextWindow,
          }));
        });
        source.addEventListener("model_info", (event) =>
          setState((old) =>
            old
              ? { ...old, modelInfo: JSON.parse((event as MessageEvent).data) }
              : old,
          ),
        );
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
    if (!state?.settings.baseUrl || !state.settings.model) return;
    let cancelled = false;
    api<{ modelInfo: AppState["modelInfo"] }>("/api/models")
      .then((result) => {
        if (!cancelled)
          setState((old) =>
            old ? { ...old, modelInfo: result.modelInfo } : old,
          );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [state?.settings.baseUrl, state?.settings.model]);
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    api<RunRecord>(`/api/runs/${selectedId}`)
      .then((record) => {
        if (!cancelled) mergeRun(record);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);
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
  async function saveSettings(saveVoice?: () => Promise<void>) {
    await action("save", async () => {
      await saveVoice?.();
      const result = await api<{ settings: Settings; hasApiKey: boolean }>(
        "/api/settings",
        {
          method: "PUT",
          body: json({
            ...draft,
            providerName,
            providerId: state?.activeProviderId,

            ...(keyChanged ? { apiKey } : {}),
          }),
        },
      );
      setDraft(result.settings);
      setState((old) => (old ? { ...old, ...result } : old));
      setApiKey("");
      setKeyChanged(false);
      setNotice("Saved");
    });
  }
  async function changeApprovalMode(mode: Settings["approvalMode"]) {
    const previous = state?.settings.approvalMode || "never";
    setState((old) =>
      old ? { ...old, settings: { ...old.settings, approvalMode: mode } } : old,
    );
    update("approvalMode", mode);
    await action("approval-mode", async () => {
      try {
        const result = await api<{ settings: Settings; hasApiKey: boolean }>(
          "/api/approval-mode",
          { method: "PUT", body: json({ mode }) },
        );
        setState((old) => (old ? { ...old, ...result } : old));
      } catch (error) {
        setState((old) =>
          old
            ? { ...old, settings: { ...old.settings, approvalMode: previous } }
            : old,
        );
        update("approvalMode", previous);
        throw error;
      }
    });
  }
  async function changeProvider(id: string, model?: string) {
    await action("provider", async () => {
      const add = id.startsWith("add:");
      const result = await api<Pick<AppState, "settings" | "providers" | "activeProviderId" | "hasApiKey" | "modelInfo">>("/api/providers", {
        method: id === "remove" ? "DELETE" : add ? "POST" : "PUT",
        body: json(id === "remove" ? { id: state?.activeProviderId } : add ? {
          name: id === "add:openrouter" ? "OpenRouter" : "New provider",
          baseUrl: id === "add:openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1",
        } : { id, model }),
      });
      if (id === "remove" && state?.activeProviderId) {
        // Drop the removed provider's saved "models in chat" choice with it.
        const removed = state.activeProviderId;
        const saved = await readVisibleModels();
        if (removed in saved) {
          delete saved[removed];
          await chrome.storage.local.set({ visibleModels: saved });
        }
      }
      setState(old => old ? { ...old, ...result } : old); setDraft(result.settings);
      setProviderName(result.providers.find(provider => provider.id === result.activeProviderId)?.name || "Provider");
      setApiKey(""); setKeyChanged(false);
    });
  }

  return (
    <div className="app-shell">
      <header className="extension-header">
        <button
          className={page === "workbench" ? "brand" : "back-to-chat"}
          aria-label={page === "workbench" ? "Relay workbench" : "Back to chat"}
          onClick={() => setPage("workbench")}
        >
          {page === "workbench" ? (
            <>
              <Route size={20} />
              <span>Relay</span>
            </>
          ) : (
            <>
              <ArrowLeft size={17} />
              <span>Back to chat</span>
            </>
          )}
        </button>
        <div className="header-actions">
          <button
            className="icon-button"
            aria-label={theme === "light" ? "Use dark mode" : "Use light mode"}
            title={theme === "light" ? "Dark mode" : "Light mode"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button
            className="icon-button"
            aria-label="Task history"
            title="History"
            onClick={() => historyDialog.current?.showModal()}
          >
            <History size={18} />
          </button>
          {!busy && (
            <button
              className="icon-button"
              aria-label="New task"
              title="New task"
              onClick={() => {
                setSelectedId(null);
                setNewChatVersion((value) => value + 1);
                setPage("workbench");
              }}
            >
              <Plus size={20} />
            </button>
          )}
          <button
            className={`icon-button ${page !== "workbench" ? "selected" : ""}`}
            aria-label="Settings"
            title="Settings"
            aria-pressed={page !== "workbench"}
            onClick={() =>
              setPage(page === "workbench" ? "settings" : "workbench")
            }
          >
            <Settings2 size={18} />
          </button>
        </div>
      </header>
      <main className="main-shell">
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
        ) : (
          <>
            <div className="workbench-slot" hidden={page !== "workbench"}>
              <Workbench
                newChatVersion={newChatVersion}
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
                visible={page === "workbench"}
              />
            </div>
            {page !== "workbench" && (
              <Configuration
                providerName={providerName}
                setProviderName={setProviderName}
                changeProvider={changeProvider}
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
                notice={setNotice}
              />
            )}
          </>
        )}
      </main>
      <HistoryDialog
        dialogRef={historyDialog}
        runs={state?.runs || []}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setPage("workbench");
        }}
      />
    </div>
  );
}
