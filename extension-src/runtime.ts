import { Validator } from "@cfworker/json-schema";
import { AgentEngine, MAX_CONCURRENT_RUNS, contextBaseline } from "../extension-core/agent";
import { historyBeforeEdit } from "../extension-core/conversation";
import { ModelCatalogue, effectiveSettings } from "../extension-core/catalogue";
import { BUILTIN_TOOLS } from "../extension-core/tools";
import { parseReasoningBody, testModel } from "../extension-core/model";
import type {
  AppState,
  ModelInfo,
  RunRecord,
  Settings,
  BrowserTransport,
  BridgeStatus,
} from "../shared/types";
import { webSearch, SEARCH_PROVIDERS, SEARCH_PROVIDER_IDS, type SearchProvider } from "../extension-core/search";
import { hostOf, ruleFor } from "../shared/siteRules";
import { ExtensionStore } from "./store";
import { ProviderStore } from "./providers";
import { settingsSchema, normalizeSettings, record, z } from "./validation";
import {
  perform,
  listTabs,
  detachAll,
  releaseTab,
  prepareRun,
  configureBrowser,
  groupTab,
  forgetGroup,
  setNotifier,
  hasPendingDialogs,
  recoverSessions,
  isBlankPage,
} from "./browser.js";

// Registered at start-up so a click that wakes the worker is not missed.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  // open() must be called inside the click, without awaiting first. Chrome handles the two calls
  // in order, so the panel is enabled for this tab before it opens.
  void chrome.sidePanel.setOptions({ tabId: tab.id, path: "index.html", enabled: true });
  void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
const store = new ExtensionStore();
const providers = new ProviderStore();
const catalogue = new ModelCatalogue();
const attachmentFields = {
  name: z.string().trim().min(1, "Attachment names cannot be empty.").transform(name => name.slice(0, 120)),
  size: z.number().int().nonnegative(),
};
const attachmentsSchema = z.array(z.discriminatedUnion("kind", [
  z.object({
    ...attachmentFields,
    kind: z.literal("image"),
    mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    dataUrl: z.string().max(6_000_000, "Attachment image data must be at most 6,000,000 characters."),
  }).strict().refine(({ mime, dataUrl }) => {
    const prefix = `data:${mime};base64,`;
    if (!dataUrl.startsWith(prefix)) return false;
    const base64 = dataUrl.slice(prefix.length);
    return base64.length > 0 && base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64);
  }, "Attachment images must be base64 data URLs matching their MIME type."),
  z.object({
    ...attachmentFields,
    kind: z.literal("text"),
    mime: z.string(),
    text: z.string().max(200_000, "Attachment text must be at most 200,000 characters."),
  }).strict(),
])).max(5, "At most 5 attachments are allowed per message.").optional();
const ports = new Set<chrome.runtime.Port>();
let apiKey = "";
const API_KEY_STORAGE_KEY = "modelApiKey";
// Web search keys, one per search API. Each is sent only to its own provider's fixed endpoint.
const SEARCH_KEYS_STORAGE_KEY = "searchApiKeys";
let searchKeys: Partial<Record<SearchProvider, string>> = {};
const searchKeysSchema = z.object({
  exa: z.string().trim().max(1000).optional(),
  tavily: z.string().trim().max(1000).optional(),
  parallel: z.string().trim().max(1000).optional(),
}).strict();
function searchKeyState() {
  return Object.fromEntries(SEARCH_PROVIDER_IDS.map((id) => [id, !!searchKeys[id]])) as Record<SearchProvider, boolean>;
}
async function runWebSearch(args: Record<string, any>, signal?: AbortSignal) {
  const provider = store.settings.webSearch;
  if (!provider || provider === "off") throw new Error("Web search is off. The user can choose a search API in Settings > Tools.");
  const found = await webSearch(provider, searchKeys[provider] ?? "", { query: String(args.query ?? ""), maxResults: args.maxResults }, signal);
  // Results on sites the user blocked are dropped, so the model is never pointed at them.
  const rules = store.settings.siteRules ?? [];
  const results = found.results.filter((result) => ruleFor(rules, hostOf(result.url))?.action !== "block");
  return { ...found, results, ...(results.length < found.results.length ? { blockedResults: found.results.length - results.length } : {}) };
}
let admissions = 0;
const admitting = new Set<string>();
// Leases are deliberately not persisted: restart fails every interrupted run.
const tabLeases = new Map<number, string>();
let settingsQueue = Promise.resolve();
function changeSettings<T>(job: () => Promise<T>): Promise<T> {
  const result = settingsQueue.then(job);
  settingsQueue = result.then(() => {}, () => {});
  return result;
}
let tabs: BridgeStatus["tabs"] = [];
let browserQueue = Promise.resolve();
let runKeepAlive: ReturnType<typeof setInterval> | undefined;
async function refreshTabs() {
  tabs = (await listTabs()).filter(
    (tab): tab is typeof tab & { id: number } => typeof tab.id === "number",
  );
  return tabs;
}
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const result = browserQueue.then(job);
  browserQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}
function releaseIdleBrowser() {
  return enqueue(async () => {
    await store.flush();
    await catalogue.flush();
    await cleanupIdleBrowser();
  });
}
/** The lease callback browser.js receives: claims the tab for the run and groups the tabs Rove itself opens. */
function leaseFor(runId?: string, signal?: AbortSignal) {
  return (tabId: number, info?: { created?: boolean }) => {
    signal?.throwIfAborted();
    claimTab(tabId, runId);
    if (info?.created) void groupTab(runId ?? "manual", tabId);
  };
}
function claimTab(tabId: number, runId?: string) {
  const owner = tabLeases.get(tabId);
  if (owner && owner !== runId && (engine.isActive(owner) || admitting.has(owner)))
    throw new Error(runId
      ? `Tab ${tabId} is owned by another task. Choose an unleased tab or navigate with newTab:true.`
      : "Rove is working in this tab right now. Its screenshots appear in the task's activity; try again when it finishes.");
  if (runId) {
    tabLeases.set(tabId, runId);
    bindTabChat(tabId, runId);
  }
}
// Which chat the side panel shows on each tab. A task binds every tab it works in; the panel binds
// the tab a chat was started or opened from. Session storage clears when Chrome restarts, so a
// reused tab ID never brings back an unrelated old chat.
const TAB_CHATS_KEY = "tabChats";
let tabChats: Record<string, string> = {};
let tabChatsWrite = Promise.resolve();
function bindTabChat(tabId: number, runId: string | null) {
  const key = String(tabId);
  if (runId === null ? !(key in tabChats) : tabChats[key] === runId) return;
  tabChats = { ...tabChats };
  if (runId === null) delete tabChats[key];
  else tabChats[key] = runId;
  const snapshot = tabChats;
  tabChatsWrite = tabChatsWrite
    .then(() => chrome.storage.session.set({ [TAB_CHATS_KEY]: snapshot }))
    .catch(() => {});
  broadcast("tab_chats", snapshot);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  bindTabChat(tabId, null);
  recentActions.delete(tabId);
  openedTabs.delete(tabId);
});
/** Starting or continuing a chat on a tab another task is using: say so in the user's terms. */
async function prepareChat(tabId: number | undefined, runId: string) {
  try {
    return await enqueue(() => prepareRun(tabId, leaseFor(runId)));
  } catch (error) {
    if (error instanceof Error && /is owned by another task/.test(error.message))
      throw new Error("Another Rove task is working in this tab. Wait for it to finish or stop it, or choose New Tab in the tab picker.");
    throw error;
  }
}
// New Tab mode started beside an empty tab (Chrome's New Tab page): the task's first new tab is
// that tab instead of another one. Used once per message; browser.js checks it is still empty.
const blankTabs = new Map<string, number>();
function busyWithAnotherRun(tabId: number, runId?: string) {
  const owner = tabLeases.get(tabId);
  return !!owner && owner !== runId && (engine.isActive(owner) || admitting.has(owner));
}
function rememberBlankTab(runId: string, tabId: number | undefined) {
  blankTabs.delete(runId);
  if (tabId === undefined) return;
  const tab = tabs.find((item) => item.id === tabId);
  if (tab && isBlankPage(tab.url) && !busyWithAnotherRun(tabId, runId)) blankTabs.set(runId, tabId);
}
// Tabs a page opens from a tab a task is driving (a link with target=_blank, window.open) belong to
// that task straight away, so the side panel there shows the task instead of an empty chat.
// target=_blank links are noopener, so Chrome may report no opener or another one: a tab created in the same
// window while the task's action runs, or just after it, counts too. A blank tab is the user's own
// (Ctrl+T), never the page's.
type RecentAction = { runId: string; windowId?: number; started: number; until: number };
const recentActions = new Map<number, RecentAction>();
const OPENED_TAB_WINDOW_MS = 2000;
// Actions through which a page can open a tab. Reads, screenshots and navigation of the tab itself cannot.
const OPENS_TABS = new Set(["browser_click", "browser_press_key", "browser_type", "browser_select", "browser_drag", "browser_evaluate", "browser_cdp", "browser_dialog", "browser_upload"]);
const openedTabs = new Map<number, number[]>();
function openerOf(tab: chrome.tabs.Tab): number | undefined {
  const now = Date.now();
  const live = (recent?: RecentAction) => !!recent && recent.until >= now && engine.isActive(recent.runId);
  // Chrome's opener is not always the page that opened the tab (a tab Rove created reports the tab
  // that was active then), so a mismatch falls through to the timing rule.
  if (typeof tab.openerTabId === "number" && live(recentActions.get(tab.openerTabId))) return tab.openerTabId;
  if (isBlankPage(tab.pendingUrl || tab.url)) return undefined;
  let best: number | undefined;
  for (const [tabId, recent] of recentActions)
    if (live(recent) && recent.windowId === tab.windowId && (best === undefined || recent.started > recentActions.get(best)!.started))
      best = tabId;
  return best;
}
chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id !== "number") return;
  const opener = openerOf(tab);
  const recent = opener === undefined ? undefined : recentActions.get(opener);
  if (opener === undefined || !recent) return;
  if (tabLeases.get(opener) !== recent.runId || busyWithAnotherRun(tab.id, recent.runId)) return;
  try {
    claimTab(tab.id, recent.runId);
    // A tab opened from one of the user's own groups stays in that group.
    if ((tab.groupId ?? -1) === -1) void groupTab(recent.runId, tab.id);
    openedTabs.set(opener, [...(openedTabs.get(opener) ?? []), tab.id]);
  } catch {
    // Claiming is a convenience; the task can still pick the tab with browser_tabs.
  }
});
async function releaseRun(runId: string) {
  blankTabs.delete(runId);
  for (const [tabId, recent] of recentActions) if (recent.runId === runId) recentActions.delete(tabId);
  forgetGroup(runId);
  for (const [tabId, owner] of tabLeases) {
    if (owner === runId) openedTabs.delete(tabId);
    if (owner === runId && await releaseTab(tabId)) tabLeases.delete(tabId);
  }
}
async function cleanupIdleBrowser() {
  if (!engine.activeRunIds.length && admissions === 0 && !hasPendingDialogs()) {
    await detachAll();
    tabLeases.clear();
  }
}
function tabsFor(runId?: string) {
  return tabs.map(tab => {
    const owner = tabLeases.get(tab.id);
    return { ...tab, busyWithAnotherTask: !!owner && owner !== runId && (engine.isActive(owner) || admitting.has(owner)) };
  });
}
function broadcast(type: string, data: unknown) {
  for (const port of ports) {
    try {
      port.postMessage({ type, data });
    } catch {
      ports.delete(port);
    }
  }
}
/** The saved key belongs to the saved provider's server. Discovery and tests run while another
 * address is being typed get no key unless one is typed for it, so a half-typed or mistyped
 * address never receives the credential. */
function savedKeyFor(baseUrl: string) {
  try {
    return new URL(baseUrl).origin === new URL(store.settings.baseUrl).origin ? apiKey : "";
  } catch {
    return "";
  }
}
function redact(message: string) {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}
function transportForRun(runId?: string): BrowserTransport {
  return {
    status: () => ({ connected: true, browser: "Chrome", tabs: tabsFor(runId) }),
    execute: (action, args, signal) => {
      // Web search talks to a search API, not the browser, so it does not wait for browser work.
      if (action === "web_search") return runWebSearch(args, signal);
      const job = async () => {
        signal?.throwIfAborted();
        await store.flush();
        signal?.throwIfAborted();
        if (runId && !engine.isActive(runId)) throw new Error("Run is not active.");
        let actual = args;
        if (runId && action === "browser_navigate" && args.newTab && blankTabs.has(runId)) {
          const blank = blankTabs.get(runId)!;
          blankTabs.delete(runId);
          if (!busyWithAnotherRun(blank, runId)) actual = { ...args, reuseTabId: blank };
        }
        const target = Number.isInteger(args.tabId) ? Number(args.tabId) : undefined;
        const tracks = !!runId && target !== undefined && OPENS_TABS.has(action);
        // The tab list can lag behind a tab Rove has just opened, so ask Chrome when it has no window.
        const windowId = !tracks ? undefined
          : tabs.find((tab) => tab.id === target)?.windowId ?? (await chrome.tabs.get(target!).catch(() => undefined))?.windowId;
        const tracked = tracks ? { runId: runId!, windowId, started: Date.now(), until: Infinity } : undefined;
        if (tracked) recentActions.set(target!, tracked);
        let result;
        try {
          result = await perform(action, actual, leaseFor(runId, signal), !!runId);
        } finally {
          if (tracked && recentActions.get(target!) === tracked) tracked.until = Date.now() + OPENED_TAB_WINDOW_MS;
        }
        signal?.throwIfAborted();
        const opened = target !== undefined ? openedTabs.get(target) : undefined;
        if (opened?.length && result && typeof result === "object" && !Array.isArray(result)) {
          openedTabs.delete(target!);
          // Tell the model where the click went: the page opened a new tab, which this task now owns.
          result = { ...result, openedTabs: opened };
        }
        if (action === "browser_tabs") {
          tabs = result;
          return tabsFor(runId);
        }
        return result;
      };
      return action === "browser_wait" ? job() : enqueue(job);
    },
  };
}
const transport = transportForRun();
const engine = new AgentEngine({
  transport,
  transportForRun,
  getSettings: () => structuredClone(store.settings),
  getApiKey: () => apiKey,
  checkpoint: () => store.flush(),
  resolveModel: (settings, key, signal) =>
    catalogue.resolve(settings, key, signal),
  learnContextBudget: (settings, key, budget, maxImages) => {
    catalogue.learn(settings, key, budget, maxImages);
    broadcast("model_info", catalogue.peek(store.settings, apiKey));
  },
  emit: (runId, event) => {
    broadcast("event", { runId, event });
    if (event.type === "status") {
      if (engine.activeRunIds.length) {
        // New Tab mode has no debugger until the model opens a destination.
        // Keep pending model I/O alive without manufacturing a browser tab.
        runKeepAlive ??= setInterval(() => {
          void chrome.runtime.getPlatformInfo().catch(() => {});
        }, 20000);
      } else {
        clearInterval(runKeepAlive);
        runKeepAlive = undefined;
      }
      broadcast("run_status", {
        id: runId,
        status: event.data.status,
        updatedAt: event.time,
        activeRunIds: engine.activeRunIds,
        activeRunId: engine.activeRunId,
      });
      if (["completed", "failed", "stopped"].includes(event.data.status)) {
        queueMicrotask(() => {
          void enqueue(async () => {
            try {
              await store.flush();
              await catalogue.flush();
              // A follow-up may have begun before this queued cleanup executes.
              if (!engine.isActive(runId) && !admitting.has(runId)) await releaseRun(runId);
              await cleanupIdleBrowser();
            } catch (error) {
              broadcast("browser_notice", {
                event: "error",
                message: redact(String(error)),
              });
            }
          });
        });
      }
    }
  },
  save: (run: RunRecord) => {
    const first = !store.hasRun(run.id);
    store.saveRun(run);
    if (first) broadcast("run", run);
  },
});
// Browser behaviour settings apply to the next action of every task, not just to tasks admitted afterwards.
configureBrowser(() => store.settings);
setNotifier((type: string, data: any) => {
  if (type === "tabs") {
    tabs = data;
    broadcast("bridge", transport.status());
  } else {
    broadcast(type, data);
    if (type === "browser_notice" && data.event === "detached") {
      const owner = tabLeases.get(data.tabId);
      // Closing Chrome's debugging bar detaches every tab. By default the tasks carry on: the next
      // browser action attaches again (the bar returns with it), and an action already sent
      // when the bar closed reports an ordinary tool error instead of being replayed.
      const stopped = data.reason === "canceled_by_user" ? (store.settings.keepGoingOnBarClose ? [] : engine.activeRunIds)
        : ["target_closed", "connection_lost"].includes(data.reason) && owner && engine.isActive(owner) ? [owner] : [];
      const reason = data.reason === "target_closed"
        ? "The tab this task was working in was closed, so the task stopped. No browser action was replayed."
        : data.reason === "canceled_by_user"
          ? "Chrome's debugging bar was closed, so the task stopped. Start it again to reconnect. No browser action was replayed."
          : "Chrome disconnected the browser debugger. Check the page, then start a new task to reconnect. No browser action was replayed.";
      for (const runId of stopped) engine.stop(runId, reason);
    }
    if (type === "browser_notice" && data.event === "dialog_closed")
      void enqueue(async () => {
        await store.flush();
        for (const owner of new Set(tabLeases.values()))
          if (!engine.isActive(owner) && !admitting.has(owner)) await releaseRun(owner);
        await cleanupIdleBrowser();
      });
  }
});
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  await chrome.storage.session.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  const saved = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  const legacy = (await chrome.storage.session.get("apiKey")).apiKey;
  if (typeof saved[API_KEY_STORAGE_KEY] === "string")
    apiKey = saved[API_KEY_STORAGE_KEY];
  else {
    apiKey = typeof legacy === "string" ? legacy : "";
    await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: apiKey });
  }
  await chrome.storage.session.remove("apiKey");
  const savedSearchKeys = searchKeysSchema.safeParse((await chrome.storage.local.get(SEARCH_KEYS_STORAGE_KEY))[SEARCH_KEYS_STORAGE_KEY]);
  searchKeys = savedSearchKeys.success ? savedSearchKeys.data : {};
  const savedTabChats = (await chrome.storage.session.get(TAB_CHATS_KEY))[TAB_CHATS_KEY];
  if (savedTabChats && typeof savedTabChats === "object") {
    const open = new Set((await chrome.tabs.query({})).map((tab) => String(tab.id)));
    tabChats = Object.fromEntries(
      Object.entries(savedTabChats).filter(([tabId, runId]) => open.has(tabId) && typeof runId === "string"),
    ) as Record<string, string>;
  }
  await store.init();
  await providers.init(store.settings, apiKey);
  await catalogue.init();
  await recoverSessions();
  tabLeases.clear();
  await refreshTabs();
  // Rove's side panel belongs to the tabs it was opened on: off everywhere else, so switching
  // to another tab closes it there, and coming back shows it again.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await chrome.sidePanel.setOptions({ enabled: false });
})();
function state(): AppState {
  return {
    providers: providers.summaries(), activeProviderId: providers.activeId,
    settings: normalizeSettings(store.settings),
    modelInfo: catalogue.peek(store.settings, apiKey),
    hasApiKey: !!apiKey,
    searchKeys: searchKeyState(),
    bridge: transport.status(),
    runs: store.summaries(),
    activeRunId: engine.activeRunId,
    activeRunIds: engine.activeRunIds,
    tools: BUILTIN_TOOLS,
    tabChats,
    contextBaseline: contextBaseline(store.settings),
  };
}
function ownPage(sender: chrome.runtime.MessageSender) {
  return (
    sender.id === chrome.runtime.id &&
    !!sender.url &&
    sender.url.startsWith(chrome.runtime.getURL(""))
  );
}
function settingsResult() {
  return {
    providers: providers.summaries(), activeProviderId: providers.activeId,
    settings: normalizeSettings(store.settings),
    hasApiKey: !!apiKey,
    searchKeys: searchKeyState(),
    modelInfo: catalogue.peek(store.settings, apiKey),
    activeRunIds: engine.activeRunIds,
    activeRunId: engine.activeRunId,
    contextBaseline: contextBaseline(store.settings),
  };
}
function reserveAdmission(runId: string) {
  if (engine.isActive(runId) || admitting.has(runId))
    throw new Error("Stop the current response before continuing this chat.");
  // Connection probes also hold idle cleanup, but do not consume a task slot.
  if (engine.activeRunIds.length + admitting.size >= MAX_CONCURRENT_RUNS)
    throw new Error("Up to 3 tasks can run at once.");
  admitting.add(runId);
  admissions++;
}
function endAdmission(runId: string) {
  admitting.delete(runId);
  admissions--;
}
async function listProviderModels(refresh: boolean, override?: { settings: Settings; key: string }) {
  const snapshot = [...providers.profiles];
  const results = await Promise.allSettled(snapshot.map(async profile => {
    const connection = providers.connection(profile.id);
    const settings = override && profile.id === providers.activeId ? override.settings : { ...store.settings, baseUrl: profile.baseUrl, model: profile.model };
    const key = override && profile.id === providers.activeId ? override.key : connection.key;
    try {
      const models = await catalogue.list(settings, key, refresh);
      return models.map(model => ({ ...model, providerId: profile.id, providerName: profile.name }));
    } catch (error) { throw new Error(key ? String(error).split(key).join("[redacted]") : String(error)); }
  }));
  const models: ModelInfo[] = [], warnings: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") models.push(...result.value);
    else warnings.push(`Could not load ${snapshot[index].name} models.`);
  });
  if (results.every(result => result.status === "rejected")) throw new Error(warnings.join(" "));
  return { models, warnings };
}
/** What a settings backup carries: everything in Settings, but not chat history. */
const BACKUP_KEYS = [
  "settings", "modelProviders", "activeModelProviderId", "visibleModels", "shortcuts", "voiceSettings",
  "relay.modelProfiles.v1", "rove.modelOverrides.v1",
];
const BACKUP_SECRET_KEYS = [API_KEY_STORAGE_KEY, "modelProviderKeys", "voiceApiKey", SEARCH_KEYS_STORAGE_KEY];
const BACKUP_FORMAT = "rove-settings-backup";
async function backup(includeKeys: boolean) {
  const keys = includeKeys ? [...BACKUP_KEYS, ...BACKUP_SECRET_KEYS] : BACKUP_KEYS;
  return {
    format: BACKUP_FORMAT,
    version: 1,
    app: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    includesKeys: includeKeys,
    storage: await chrome.storage.local.get(keys),
  };
}
function sameOrigin(a: unknown, b: unknown) {
  try {
    return new URL(String(a)).origin === new URL(String(b)).origin;
  } catch {
    return false;
  }
}
/** Read settings, keys and providers from storage again, as start-up does, after a restore. */
async function loadSavedState() {
  const saved = await chrome.storage.local.get([API_KEY_STORAGE_KEY, SEARCH_KEYS_STORAGE_KEY, "settings"]);
  store.settings = normalizeSettings(saved.settings);
  apiKey = typeof saved[API_KEY_STORAGE_KEY] === "string" ? saved[API_KEY_STORAGE_KEY] : "";
  const keys = searchKeysSchema.safeParse(saved[SEARCH_KEYS_STORAGE_KEY]);
  searchKeys = keys.success ? keys.data : {};
  // A restored search API without its key here would offer a tool that cannot work.
  if (store.settings.webSearch !== "off" && !searchKeys[store.settings.webSearch])
    store.settings = { ...store.settings, webSearch: "off" };
  await providers.init(store.settings, apiKey);
  await catalogue.reload();
  engine.setApprovalMode(store.settings.approvalMode);
}
async function restore(body: unknown) {
  const input = z
    .object({ format: z.literal(BACKUP_FORMAT, "This file is not a Rove settings backup."), version: z.literal(1), storage: record })
    .parse(body);
  const allowed = new Set([...BACKUP_KEYS, ...BACKUP_SECRET_KEYS]);
  const values = Object.fromEntries(Object.entries(input.storage).filter(([key]) => allowed.has(key)));
  // Reject a backup the worker could not start from, before anything is written.
  try {
    normalizeSettings(values.settings);
  } catch {
    throw new Error("This backup's settings are not valid for this version of Rove.");
  }
  if (values[SEARCH_KEYS_STORAGE_KEY] !== undefined && !searchKeysSchema.safeParse(values[SEARCH_KEYS_STORAGE_KEY]).success)
    throw new Error("This backup's web search keys are not valid.");
  // A backup without keys keeps the keys saved here, but only for the same provider at the same
  // address: a key must never follow a provider whose address the backup changed.
  const current = await chrome.storage.local.get(["modelProviders", "modelProviderKeys", "activeModelProviderId", "voiceSettings"]);
  if (!("modelProviderKeys" in values)) {
    const before: any[] = Array.isArray(current.modelProviders) ? current.modelProviders : [];
    const after: any[] = Array.isArray(values.modelProviders) ? values.modelProviders : before;
    const oldKeys = (current.modelProviderKeys ?? {}) as Record<string, string>;
    values.modelProviderKeys = Object.fromEntries(after.flatMap((profile) => {
      const old = before.find((item) => item?.id === profile?.id);
      return old && oldKeys[profile.id] && sameOrigin(old.baseUrl, profile.baseUrl) ? [[profile.id, oldKeys[profile.id]]] : [];
    }));
  }
  if (!(API_KEY_STORAGE_KEY in values)) {
    const active = String(values.activeModelProviderId ?? current.activeModelProviderId ?? "");
    values[API_KEY_STORAGE_KEY] = (values.modelProviderKeys as Record<string, string>)[active] ?? "";
  }
  if (!("voiceApiKey" in values) && values.voiceSettings !== undefined && !sameOrigin((current.voiceSettings as any)?.baseUrl, (values.voiceSettings as any)?.baseUrl))
    values.voiceApiKey = "";
  await chrome.storage.local.set(values);
}
async function route(path: string, method: string, body: any, settingsLocked = false): Promise<any> {
  const url = new URL(path, "https://rove.invalid");
  path = url.pathname;
  if (!settingsLocked && ((method === "PUT" && ["/api/settings", "/api/approval-mode", "/api/run-options"].includes(path)) ||
      (path === "/api/providers" && ["POST", "PUT", "DELETE"].includes(method))))
    return changeSettings(() => route(path, method, body, true));
  if (method === "GET" && path === "/api/state") return state();
  if (method === "GET" && path === "/api/health")
    return { ok: true, version: "2.0.0", runtime: "chrome-extension" };
  if (method === "GET" && path === "/api/tabs") {
    await refreshTabs();
    return tabsFor();
  }
  if (method === "GET" && path === "/api/settings") return settingsResult();
  if (method === "PUT" && path === "/api/tab-chat") {
    const input = z
      .object({ tabId: z.number().int().nonnegative(), runId: z.string().max(100) })
      .strict()
      .parse(body);
    if (input.runId && !store.hasRun(input.runId)) throw new Error("Chat not found.");
    await chrome.tabs.get(input.tabId);
    bindTabChat(input.tabId, input.runId);
    return { tabChats };
  }
  if (method === "PUT" && path === "/api/settings") {
    if (engine.activeRunIds.length || admissions)
      throw new Error("Stop the active tasks before changing settings.");
    if (body.providerId !== undefined && body.providerId !== providers.activeId) throw new Error("Provider changed in another window. Reload settings before saving.");
    const settings = settingsSchema.parse(body) as Settings;
    const nextKey =
      body.apiKey === undefined
        ? apiKey
        : z.string().max(10000).parse(body.apiKey);
    if (settings.webSearch !== "off" && !searchKeys[settings.webSearch])
      throw new Error(`Add an API key for ${SEARCH_PROVIDERS[settings.webSearch].name} to use it for web search, or turn web search off.`);
    await providers.saveCurrent(settings, nextKey, body.providerName === undefined ? undefined : z.string().trim().min(1).max(80).parse(body.providerName));
    store.settings = settings;
    apiKey = nextKey;
    engine.setApprovalMode(settings.approvalMode);
    const result = settingsResult();
    broadcast("settings", result);
    return result;
  }
  if (method === "PUT" && path === "/api/approval-mode") {
    const mode = z.enum(["always", "risky", "never"]).parse(body.mode);
    const runId = z.string().min(1).optional().parse(body.runId);
    if (runId !== undefined) engine.setApprovalMode(mode, runId);
    else {
      await store.saveSettings({ ...store.settings, approvalMode: mode });
      engine.setApprovalMode(mode);
    }
    const result = { ...settingsResult(), ...(runId ? { runId, approvalMode: mode } : {}) };
    broadcast("settings", result);
    return result;
  }
  if (path === "/api/providers" && ["POST", "PUT", "DELETE"].includes(method)) {
    if (engine.activeRunIds.length || admissions) throw new Error("Stop the active tasks before changing settings.");
      const result = method === "POST" ? await providers.add(body, store.settings)
        : method === "DELETE" ? await providers.remove(z.string().parse(body.id), store.settings)
        : await providers.select(z.string().parse(body.id), store.settings, body.model === undefined ? undefined : z.string().max(200).parse(body.model));
      store.settings = result.settings; apiKey = result.key;
      const updated = settingsResult(); broadcast("settings", updated); return updated;
  }
  if (method === "PUT" && path === "/api/run-options") {
    const options = z
      .object({
        providerId: z.string().max(100).optional(),
        model: z.string().min(1).max(200).optional(),
        reasoningEffort: z
          .string()
          .regex(/^[a-z][a-z0-9_-]{0,39}$/)
          .optional(),
      })
      .strict()
      .parse(body);
    if (options.providerId && options.providerId !== providers.activeId) {
        const selected = await providers.select(options.providerId, store.settings, options.model);
        store.settings = selected.settings; apiKey = selected.key;
        const result = settingsResult(); broadcast("settings", result); return result;
    }
    const settings = settingsSchema.parse({
      ...store.settings,
      ...options,
      ...(options.model && options.model !== store.settings.model
        ? { reasoningEffort: "default" }
        : {}),
    }) as Settings;
    await providers.saveCurrent(settings, apiKey);
    store.settings = settings;
    const result = settingsResult();
    broadcast("settings", result);
    return result;
  }
  if (method === "GET" && path === "/api/models") {
    const { models, warnings } = await listProviderModels(url.searchParams.has("refresh"));
    const modelInfo = catalogue.peek(store.settings, apiKey);
    broadcast("model_info", modelInfo);
    return { models, modelInfo, warnings };
  }
  if (method === "POST" && path === "/api/models") {
    const input = z
      .object({
        baseUrl: z.string(),
        apiKey: z.string().max(10000).optional(),
        refresh: z.boolean().optional(),
      })
      .parse(body);
    const candidate = settingsSchema.parse({
      ...store.settings,
      baseUrl: input.baseUrl,
    }) as Settings;
    const key = input.apiKey === undefined ? savedKeyFor(candidate.baseUrl) : input.apiKey;
    try {
      const { models, warnings } = await listProviderModels(input.refresh ?? url.searchParams.has("refresh"), { settings: candidate, key });
      return { models, modelInfo: catalogue.peek(candidate, key), warnings };
    } catch (error) {
      throw new Error(
        key ? String(error).split(key).join("[redacted]") : String(error),
      );
    }
  }
  if (method === "PUT" && path === "/api/model-override") {
    const input = z
      .object({
        baseUrl: z.string().max(2000),
        model: z.string().min(1).max(200),
        override: z
          .object({
            images: z.enum(["on", "off"]).optional(),
            reasoning: z
              .array(
                z.object({
                  value: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
                  label: z.string().trim().min(1).max(40),
                  body: z.string().max(4000).superRefine((text, ctx) => {
                    try {
                      parseReasoningBody(text);
                    } catch (error) {
                      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
                    }
                  }),
                }),
              )
              .max(8)
              .refine((levels) => new Set(levels.map((level) => level.value)).size === levels.length, "Reasoning level IDs must be unique.")
              .optional(),
          })
          .nullable(),
      })
      .parse(body);
    await catalogue.setOverride(input.baseUrl, input.model, input.override);
    // Refresh what the active model looks like, and every provider list the picker shows.
    const modelInfo = catalogue.peek(store.settings, apiKey);
    broadcast("model_info", modelInfo);
    return { modelInfo, model: catalogue.find(input.baseUrl, input.model) };
  }
  if (method === "POST" && path === "/api/model/test") {
    const candidate = settingsSchema.parse({
      ...store.settings,
      ...body,
    }) as Settings;
    const key =
      body.apiKey === undefined
        ? savedKeyFor(candidate.baseUrl)
        : z.string().max(10000).parse(body.apiKey);
    admissions++;
    try {
      await enqueue(async () => {
        if (!engine.activeRunIds.length) await prepareRun(undefined, leaseFor());
      });
      const info = await catalogue.resolve(candidate, key).catch(() => null);
      return {
        ok: true,
        message: await testModel(effectiveSettings(candidate, info), key, info),
      };
    } catch (error) {
      throw new Error(
        key ? String(error).split(key).join("[redacted]") : String(error),
      );
    } finally {
      admissions--;
      await releaseIdleBrowser();
    }
  }
  if (method === "PUT" && path === "/api/search-key") {
    // Saved on its own, before the settings that choose the provider, like the voice key.
    const input = z
      .object({ provider: z.enum(["exa", "tavily", "parallel"]), apiKey: z.string().trim().max(1000) })
      .strict()
      .parse(body);
    const next = { ...searchKeys };
    if (input.apiKey) next[input.provider] = input.apiKey;
    else delete next[input.provider];
    await chrome.storage.local.set({ [SEARCH_KEYS_STORAGE_KEY]: next });
    searchKeys = next;
    const result = settingsResult();
    broadcast("settings", result);
    return result;
  }
  if (method === "POST" && path === "/api/search/test") {
    const input = z
      .object({ provider: z.enum(["exa", "tavily", "parallel"]), apiKey: z.string().trim().max(1000).optional() })
      .strict()
      .parse(body);
    const key = input.apiKey || searchKeys[input.provider] || "";
    const found = await webSearch(input.provider, key, { query: "Chrome extension side panel", maxResults: 2 });
    return { ok: true, message: `${found.provider} answered with ${found.results.length} result${found.results.length === 1 ? "" : "s"}.` };
  }
  if (method === "GET" && path === "/api/backup") return backup(url.searchParams.get("keys") === "1");
  if (method === "POST" && path === "/api/backup") {
    if (engine.activeRunIds.length || admissions) throw new Error("Stop the active tasks before restoring settings.");
    await restore(body);
    await loadSavedState();
    const result = settingsResult();
    broadcast("settings", result);
    return { ok: true, ...result };
  }
  if (method === "POST" && path === "/api/browser") {
    const input = z
      .object({ action: z.string(), args: record.default({}) })
      .parse(body);
    const definition = BUILTIN_TOOLS.find((tool) => tool.name === input.action);
    if (!definition || input.action === "ask_user")
      throw new Error("Unknown browser action.");
    const validation = new Validator(definition.parameters).validate(
      input.args,
    );
    if (!validation.valid) throw new Error(JSON.stringify(validation.errors));
    try {
      return await transport.execute(input.action, input.args);
    } finally {
      await releaseIdleBrowser();
    }
  }
  if (method === "POST" && path === "/api/runs") {
    const input = z
      .object({
        prompt: z.string().trim().min(1).max(50000),
        tabId: z.number().int().positive().nullable().optional(),
        reuseTabId: z.number().int().positive().optional(),
        attachments: attachmentsSchema,
      })
      .parse(body);
    const runId = crypto.randomUUID();
    reserveAdmission(runId);
    let reserved = true;
    try {
      await settingsQueue;
      if (!store.settings.model.trim()) throw new Error("Choose a model in settings first.");
      const selected = input.tabId === null
        ? {tabId:undefined}
        : await prepareChat(input.tabId ?? undefined, runId);
      await refreshTabs();
      if (input.tabId === null) rememberBlankTab(runId, input.reuseTabId);
      // Snapshot settings and key only after any concurrent picker commit finishes.
      const run = await changeSettings(async () => {
        if (!store.settings.model.trim()) throw new Error("Choose a model in settings first.");
        const run = engine.start(input.prompt, selected.tabId, runId, input.attachments);
        endAdmission(runId); reserved = false;
        return run;
      });
      await store.flush();
      return run;
    } catch (error) {
      if (!engine.isActive(runId)) await enqueue(() => releaseRun(runId));
      throw error;
    } finally {
      if (reserved) endAdmission(runId);
      await releaseIdleBrowser();
    }
  }
  const match = path.match(
    /^\/api\/runs\/([^/]+)(?:\/(export|stop|approval|reply|messages))?$/,
  );
  if (match) {
    const [, id, action] = match;
    if (method === "POST" && action === "messages") {
      const input = z
        .object({
          message: z.string().trim().min(1).max(50000),
          editMessageId: z.number().int().nonnegative().optional(),
          tabId: z.number().int().positive().nullable().optional(),
          reuseTabId: z.number().int().positive().optional(),
          attachments: attachmentsSchema,
        })
        .refine(input => input.editMessageId === undefined || input.attachments === undefined,
          "Attachments cannot be supplied when editing a message.")
        .parse(body);
      reserveAdmission(id);
      let reserved = true;
      try {
        await settingsQueue;
        if (!store.settings.model.trim()) throw new Error("Choose a model in settings first.");
        let previous = await store.getRun(id);
        if (!previous) throw new Error("Chat not found.");
        if (input.editMessageId !== undefined)
          previous = historyBeforeEdit(previous, input.editMessageId, input.message);
        const selected = input.tabId === null
          ? {tabId:undefined}
          : await prepareChat(input.tabId ?? undefined, id);
        await refreshTabs();
        if (input.tabId === null) rememberBlankTab(id, input.reuseTabId);
        else blankTabs.delete(id);
        if (input.editMessageId !== undefined) {
          await store.replaceRun(previous);
          broadcast("run", previous);
        }
        const run = await changeSettings(async () => {
          if (!store.settings.model.trim()) throw new Error("Choose a model in settings first.");
          const run = input.editMessageId === 0
            ? engine.restart(previous, input.message, selected.tabId)
            : engine.continue(previous, input.message, selected.tabId, input.attachments);
          endAdmission(id); reserved = false;
          return run;
        });
        await store.flush();
        return run;
      } catch (error) {
        if (!engine.isActive(id)) await enqueue(() => releaseRun(id));
        throw error;
      } finally {
        if (reserved) endAdmission(id);
        await releaseIdleBrowser();
      }
    }
    if (method === "GET" && (!action || action === "export")) {
      const run = await store.getRun(id);
      if (!run) throw new Error("Task not found.");
      return run;
    }
    if (method === "POST" && action === "stop") engine.stop(id);
    else if (method === "POST" && action === "approval") {
      const input = z
        .object({ approvalId: z.string(), approved: z.boolean() })
        .parse(body);
      engine.approve(id, input.approvalId, input.approved);
    } else if (method === "POST" && action === "reply")
      engine.reply(id, z.string().trim().min(1).max(50000).parse(body.message));
    else throw new Error("Unknown task action.");
    await store.flush();
    return { ok: true };
  }
  throw new Error("Unknown Rove operation.");
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!ownPage(sender) || message?.type !== "rove-api") return false;
  void ready
    .then(() => {
      if (typeof message.path !== "string" || !message.path.startsWith("/api/"))
        throw new Error("Invalid operation.");
      return route(message.path, message.method || "GET", message.body || {});
    })
    .then(
      (data) => respond({ ok: true, data: data ?? null }),
      (error) =>
        respond({
          ok: false,
          error: redact(error instanceof Error ? error.message : String(error)),
        }),
    );
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "rove-rpc" && port.sender && ownPage(port.sender)) {
    // Chrome messages have a size ceiling. Chunk transfers so complete journals
    // cross the same API boundary without truncating their trace.
    let parts: string[] = [],
      submitted = false,
      disconnected = false;
    port.onDisconnect.addListener(() => {
      disconnected = true;
      parts = [];
    });
    const post = (message: unknown) => {
      if (!disconnected)
        try {
          port.postMessage(message);
        } catch {
          disconnected = true;
        }
    };
    port.onMessage.addListener((message) => {
      if (submitted) return;
      if (message?.type === "chunk" && typeof message.data === "string") {
        parts.push(message.data);
        return;
      }
      if (message?.type !== "end") {
        post({ type: "error", error: "Invalid request transfer." });
        submitted = true;
        return;
      }
      submitted = true;
      void ready
        .then(async () => {
          const request = JSON.parse(parts.join(""));
          parts = [];
          if (
            typeof request.path !== "string" ||
            !request.path.startsWith("/api/")
          )
            throw new Error("Invalid operation.");
          const value = await route(
            request.path,
            request.method || "GET",
            request.body || {},
          );
          const serialized = JSON.stringify(value ?? null);
          for (
            let offset = 0;
            offset < serialized.length && !disconnected;
            offset += 1_000_000
          )
            post({
              type: "chunk",
              data: serialized.slice(offset, offset + 1_000_000),
            });
          post({ type: "end" });
        })
        .catch((error) =>
          post({
            type: "error",
            error: redact(
              error instanceof Error ? error.message : String(error),
            ),
          }),
        );
    });
    return;
  }
  if (port.name !== "rove-events" || !port.sender || !ownPage(port.sender)) {
    port.disconnect();
    return;
  }
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  void ready
    .then(() => {
      if (ports.has(port)) port.postMessage({ type: "state", data: state() });
    })
    .catch((error) => {
      try {
        port.postMessage({
          type: "browser_notice",
          data: { event: "error", message: redact(String(error)) },
        });
      } catch {}
    });
});
