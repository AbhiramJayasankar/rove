import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  AlignLeft,
  Brain,
  ShieldCheck,
  Eye,
  Search,
  ArrowUp,
  Check,
  Code2,
  FileText,
  ScanSearch,
  Globe,
  LoaderCircle,
  Maximize2,
  Monitor,
  RefreshCw,
  Square,
  X,
} from "lucide-react";
import ModelPicker from "./ModelPicker";
import UsageRing from "./UsageRing";
import ShortcutMenu, { shortcutMatches, slashQuery } from "./ShortcutMenu";
import AttachButton from "./AttachButton";
import ImageModeToggle from "./ImageModeToggle";
import Tooltip from "./Tooltip";
import { ToolDetails } from "./toolInfo";
import { attachmentPayload, type Attachment } from "./attachments";
import { shortcutText, useShortcuts, type Shortcut } from "./shortcuts";
import VoiceInput from "./VoiceInput";
import Conversation, { type ConversationHandle } from "./Conversation";
import ChoiceMenu from "./ChoiceMenu";
import {
  reasoningOptions,
  resolvedReasoningEffort,
} from "../shared/capabilities";
import { TraceView } from "./ExecutionLog";
import { downloadJson, downloadText } from "./transport";
import { runToMarkdown } from "../shared/markdown";
import type { AppState, RunRecord, Settings } from "../shared/types";
import { api, json, toolTitle, type Action, type Page, type Shot } from "./ui";
import { useT } from "./i18n";
type Props = {
  newChatVersion: number;
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
  approvalMode: Settings["approvalMode"];
  visible: boolean;
};
export default function Workbench({
  newChatVersion,
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
  approvalMode,
  visible,
}: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const t = useT();
  const [attachDrafts, setAttachDrafts] = useState<Record<string, Attachment[]>>({});
  const [attachError, setAttachError] = useState("");
  const draftId = run?.id || "new";
  const prompt = drafts[draftId] || "";
  const setPrompt = (value: string) =>
    setDrafts((previous) => ({ ...previous, [draftId]: value }));
  const attachments = attachDrafts[draftId] || [];
  const setAttachments = (items: Attachment[]) =>
    setAttachDrafts((previous) => ({ ...previous, [draftId]: items }));
  const tabs = state.bridge.tabs.filter((tab) => {
    try {
      const url = new URL(tab.url);
      return ["http:", "https:", "file:"].includes(url.protocol);
    } catch {
      return false;
    }
  });
  const [tabId, setTabId] = useState<number | undefined>(
    tabs.find((t) => t.active)?.id || tabs[0]?.id,
  );
  const [manualShot, setManualShot] = useState<Shot | null>(null);
  useEffect(() => {
    if (newChatVersion) {
      setTabId(undefined);
      setManualShot(null);
      followsBrowser.current = false;
    }
  }, [newChatVersion]);
  const [snapshot, setSnapshot] = useState<unknown>(null);
  const [activityView, setActivityView] = useState<"activity" | "trace">(
    "activity",
  );
  const [mobileView, setMobileView] = useState<"task" | "browser">("task");
  const scrollRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const shortcuts = useShortcuts();
  const [shortcutIndex, setShortcutIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<ConversationHandle>(null);
  const [retryEditRequested, setRetryEditRequested] = useState(false);
  useEffect(() => {
    if (retryEditRequested && activityView === "activity") {
      conversationRef.current?.editLatest();
      setRetryEditRequested(false);
    }
  }, [retryEditRequested, activityView]);
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
  useEffect(() => {
    if (question) {
      follows.current = true;
      setMobileView("task");
      setActivityView("activity");
    }
  }, [question?.id]);
  useEffect(() => {
    const input = promptRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }, [prompt, visible]);
  const slash = slashQuery(prompt);
  const slashMatches = slash === null ? [] : shortcutMatches(shortcuts, slash);
  const slashOpen = slash !== null && !slashDismissed;
  useEffect(() => {
    setShortcutIndex(0);
    if (slash === null) setSlashDismissed(false);
  }, [slash]);
  function pickShortcut(shortcut: Shortcut) {
    setPrompt(shortcutText(shortcut));
    setSlashDismissed(true);
    requestAnimationFrame(() => promptRef.current?.focus());
  }
  const reasoningChoices = reasoningOptions(state.settings, state.modelInfo);
  async function runOptions(options: Partial<Settings> & { providerId?: string }) {
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
    if (tabId !== undefined && !tabs.some((t) => t.id === tabId))
      setTabId(tabs.find((t) => t.active)?.id || tabs[0]?.id);
  }, [state.bridge.tabs, tabId]);
  useEffect(() => {
    setManualShot(null);
    setSnapshot(null);
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
  }, [run?.events.length, activityView, visible]);
  async function startRun(message = prompt, editMessageId?: number) {
    if (!message.trim()) return false;
    let saved = false;
    await action("run", async () => {
      const created = await api<RunRecord>(
        run ? `/api/runs/${run.id}/messages` : "/api/runs",
        {
          method: "POST",
          body: json(
            run
              ? {
                  message: message.trim(),
                  tabId: tabId ?? null,
                  editMessageId,
                  ...(editMessageId === undefined && attachments.length ? { attachments: attachmentPayload(attachments) } : {}),
                }
              : {
                  prompt: message.trim(),
                  tabId: tabId ?? null,
                  ...(attachments.length ? { attachments: attachmentPayload(attachments) } : {}),
                },
          ),
        },
      );
      mergeRun(created);
      selectRun(created.id);
      if (editMessageId === undefined) {
        setPrompt("");
        setAttachments([]);
      }
      setAttachError("");
      setManualShot(null);
      setMobileView("task");
      saved = true;
    });
    return saved;
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
    !!state.settings.model &&
    !busy &&
    !voiceBusy &&
    !pending;
  return (
    <div className={`workspace view-${mobileView}`}>
      <div className="context-strip">
        <ChoiceMenu
          className="target-picker"
          label={t("Chrome tab")}
          icon={<Globe size={14} />}
          value={String(tabId ?? "")}
          options={[
            { value: "", label: t("New Tab") },
            ...tabs.map((tab) => ({
              value: String(tab.id),
              label: tab.title || tab.url,
              description: tab.url,
            })),
          ]}
          onChange={(value) => {
            followsBrowser.current = false;
            setTabId(value ? Number(value) : undefined);
            setManualShot(null);
          }}
        />
        <div className="panel-toolbar">
          <div
            className="view-switch"
            role="group"
            aria-label={t("View")}
            style={
              {
                "--view-index":
                  mobileView === "browser"
                    ? 0
                    : activityView === "activity"
                      ? 1
                      : 2,
              } as React.CSSProperties
            }
          >
            <span className="view-switch-thumb" aria-hidden="true" />
            <button
              type="button"
              aria-label={t("Browser preview")}
              title={t("Browser preview")}
              aria-pressed={mobileView === "browser"}
              disabled={!tabId}
              onClick={() => {
                setMobileView("browser");
                if (!shot) void capture();
              }}
            >
              <Eye size={15} />
            </button>
            <button
              type="button"
              aria-label={t("Activity")}
              title={t("Activity")}
              aria-pressed={
                mobileView === "task" && activityView === "activity"
              }
              onClick={() => {
                setMobileView("task");
                setActivityView("activity");
              }}
            >
              <AlignLeft size={15} />
            </button>
            <button
              type="button"
              aria-label={t("Trace")}
              title={t("Trace")}
              aria-pressed={mobileView === "task" && activityView === "trace"}
              onClick={() => {
                setMobileView("task");
                setActivityView("trace");
              }}
            >
              <Code2 size={15} />
            </button>
          </div>
        </div>
      </div>
      <section className="task-panel" aria-label={t("Task and activity")}>
        {approval && (
          <div
            className="decision-panel"
            role="region"
            aria-label={t("Approval required")}
          >
            <>
              <strong>
                {toolTitle(approval.data.tool, approval.data.args, t)}
                {state.tools.find((tool) => tool.name === approval.data.tool) && (
                  <Tooltip label={t("About {name}", { name: toolTitle(approval.data.tool, {}, t) })} width={320}>
                    <ToolDetails tool={state.tools.find((tool) => tool.name === approval.data.tool)!} t={t} />
                  </Tooltip>
                )}
              </strong>
              {approval.data.reason === "site rule" && (
                <p className="decision-note">{t("Your site rules ask before acting on {site}.", { site: String(approval.data.site) })}</p>
              )}
              <details>
                <summary>{t("Action details")}</summary>
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
                  {t("Approve once")}
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
                  {t("Deny")}
                </button>
              </div>
              {approval.data.reason !== "site rule" && (
                <button
                  className="text-button"
                  disabled={!!pending}
                  onClick={() => changeApprovalMode("never")}
                >
                  {t("Auto-approve and continue")}
                </button>
              )}
            </>
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
              {activityView === "trace" ? (
                <TraceView
                  events={run.events}
                  exportPending={!!pending}
                  onExportMarkdown={() => {
                    void action("export-markdown", async () => {
                      const record = await api<RunRecord>(`/api/runs/${run.id}/export`);
                      downloadText(
                        runToMarkdown(record, (name, args) => toolTitle(name, args, t), { app: "Rove", version: __APP_VERSION__ }),
                        `rove-chat-${run.id.slice(0, 8)}.md`,
                        "text/markdown",
                      );
                    });
                  }}
                  onExport={() => {
                    void action("export-run", async () => {
                      const record = await api<RunRecord>(
                        `/api/runs/${run.id}/export`,
                      );
                      downloadJson(record, `rove-run-${run.id}.json`);
                    });
                  }}
                />
              ) : (
                <Conversation
                  editorRef={conversationRef}
                  key={`${run.id}:${run.revision || 0}`}
                  run={run}
                  disabled={busy || !!pending}
                  onEdit={(id, message) => startRun(message, id)}
                  replyPending={!!pending}
                  onReply={(message) =>
                    action("reply", async () => {
                      await api(`/api/runs/${run!.id}/reply`, {
                        method: "POST",
                        body: json({ message }),
                      });
                    })
                  }
                />
              )}
              {run.status === "stopped" && (
                <div className="stopped-message">
                  {t("Stopped")}{" "}
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      setActivityView("activity");
                      setRetryEditRequested(true);
                    }}
                  >
                    {t("Edit & retry")}
                  </button>
                </div>
              )}
              <div ref={bottomRef} />
            </>
          ) : (
            <div className="task-empty">
              <h1>{t("What’s the task?")}</h1>
              {!state.settings.model ? (
                <button
                  className="setup-model"
                  onClick={() => setPage("settings")}
                >
                  {t("Connect a model")}
                  <ArrowUp size={14} />
                </button>
              ) : (
                <div className="quick-actions">
                  {[
                    [AlignLeft, "Summarize this page", "Summarize the current page. Read its content and give me the key points."],
                    [Search, "Find something on this page", "Find "],
                    [Globe, "Open a site and do something", "Open "],
                  ].map(([Icon, label, text]) => (
                    <button
                      key={label as string}
                      onClick={() => {
                        setPrompt(t(text as string));
                        promptRef.current?.focus();
                      }}
                    >
                      <Icon size={15} aria-hidden="true" />
                      {t(label as string)}
                    </button>
                  ))}
                </div>
              )}
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
          {attachments.length > 0 && (
            <div className="attachment-chips" role="group" aria-label={t("Attachments")}>
              {attachments.map((item) => (
                <span className="attachment-chip" key={item.id}>
                  {item.kind === "image" && item.dataUrl ? <img src={item.dataUrl} alt="" /> : <FileText size={13} aria-hidden="true" />}
                  <span>{item.name}</span>
                  <button type="button" aria-label={t("Remove {name}", { name: item.name })} onClick={() => setAttachments(attachments.filter((other) => other.id !== item.id))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {attachments.some((item) => item.kind === "image") && state.modelInfo?.supportsVision === false && (
            <div className="attach-note">{t("This model cannot see images, so image attachments will be left out.")}</div>
          )}
          {attachError && (
            <div className="voice-error attach-error" role="alert">
              {attachError}
            </div>
          )}
          {slashOpen && (
            <ShortcutMenu
              shortcuts={shortcuts}
              query={slash!}
              index={shortcutIndex}
              onPick={pickShortcut}
              onSettings={() => setPage("instructions")}
            />
          )}
          <textarea
            ref={promptRef}
            aria-label={t("Task prompt")}
            placeholder={run ? t("Reply to Rove…") : t("Ask Rove…")}
            rows={1}
            readOnly={voiceBusy}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (slashOpen && slashMatches.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setShortcutIndex((index) => (index + (e.key === "ArrowDown" ? 1 : -1) + slashMatches.length) % slashMatches.length);
                  return;
                }
                if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
                  e.preventDefault();
                  pickShortcut(slashMatches[shortcutIndex] ?? slashMatches[0]);
                  return;
                }
              }
              if (slashOpen && e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setSlashDismissed(true);
                return;
              }
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (canRun) startRun();
              }
            }}
          />
          <div className="composer-controls">
            <ModelPicker
              providerId={state.activeProviderId}
              model={state.settings.model}
              label={
                state.modelInfo?.id === state.settings.model
                  ? state.modelInfo.name
                  : undefined
              }
              disabled={busy || pending === "run-options"}
              onSelect={(model, _context, providerId) => runOptions({ model, providerId })}
            />

            {reasoningChoices.length > 1 && <ChoiceMenu
              label={t("Reasoning level")}
              icon={<Brain size={14} />}
              placement="top"
              value={resolvedReasoningEffort(state.settings, state.modelInfo)}
              options={reasoningChoices.map((option) => ({ ...option, label: t(option.label), ...(option.description ? { description: t(option.description) } : {}) }))}
              onChange={(reasoningEffort) => runOptions({ reasoningEffort })}
              disabled={busy || pending === "run-options"}
            />}
            <ChoiceMenu
              label={t("Approval mode")}
              icon={<ShieldCheck size={13} />}
              placement="top"
              value={
                approvalMode === "never" ? "never" : "risky"
              }
              displayLabel={
                approvalMode === "never" ? t("Auto-approve") : t("Ask first")
              }
              options={[
                {
                  value: "never",
                  label: t("Auto-approve"),
                  description: t("Run enabled tools without pausing."),
                },
                {
                  value: "risky",
                  label: t("Ask permission"),
                  description: t("Review browser changes before they run."),
                },
              ]}
              onChange={(mode) =>
                changeApprovalMode(mode as Settings["approvalMode"])
              }
              disabled={pending === "approval-mode"}
            />
            <UsageRing
              run={run}
              model={state.modelInfo}
              connected={streamConnected}
            />
            {state.modelInfo?.id === state.settings.model && (
              <ImageModeToggle
                model={state.modelInfo}
                endpoint={state.settings.baseUrl}
                disabled={pending === "run-options"}
                onError={setAttachError}
              />
            )}
            <AttachButton
              tabId={tabId}
              count={attachments.length}
              disabled={busy || voiceBusy}
              onAdd={(items) => {
                setAttachError("");
                setAttachments([...attachments, ...items]);
              }}
              onError={setAttachError}
            />
            <VoiceInput input={promptRef} value={prompt} onChange={setPrompt} context={`${draftId}:${newChatVersion}`} visible={visible} onBusy={setVoiceBusy} />
            {busy ? (
              <button
                className="run-button stop-generation"
                type="button"
                aria-label={t("Stop generation")}
                title={t("Stop (Escape)")}
                disabled={pending === "stop"}
                onClick={stopRun}
              >
                <Square size={16} fill="currentColor" />
              </button>
            ) : (
              <button
                className="run-button"
                type="submit"
                aria-label={t("Run task")}
                title={t("Run task (Enter)")}
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
        aria-label={t("Browser view")}
        ref={browserRef}
      >
        <div className="browser-toolbar">
          <Globe size={15} />
          <h2>{t("Preview")}</h2>
          <div className="browser-actions">
            <button
              className="icon-button"
              aria-label={t("Inspect page")}
              title={
                busy ? t("Stop the task before inspecting refs") : t("Inspect page")
              }
              disabled={!tabId || !!pending || busy}
              onClick={() => capture(true)}
            >
              <ScanSearch size={16} />
            </button>
            <button
              className="icon-button"
              aria-label={t("Take browser screenshot")}
              title={t("Refresh screenshot")}
              disabled={!tabId || !!pending}
              onClick={() => capture()}
            >
              <RefreshCw
                size={16}
                className={pending === "screenshot" ? "spin" : ""}
              />
            </button>
            <button
              className="icon-button"
              aria-label={t("Expand browser view")}
              title={t("Expand browser view")}
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
              alt={t("Chrome view: {title}", { title: shot.title || t("current page") })}
            />
          ) : (
            <div className="browser-empty">
              <Monitor size={30} strokeWidth={1.25} />
              <p>{tabId ? t("No screenshot yet") : t("Choose a tab to preview it")}</p>
              <button
                className="button secondary"
                disabled={!tabId || !!pending}
                onClick={() => capture()}
              >
                <RefreshCw size={14} />
                {t("Take screenshot")}
              </button>
            </div>
          )}
        </div>
        {snapshot !== null && (
          <div className="snapshot-drawer">
            <div className="panel-toolbar">
              <strong>{t("Page snapshot")}</strong>
              <button
                className="icon-button"
                aria-label={t("Close snapshot")}
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
