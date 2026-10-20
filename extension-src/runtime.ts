import { Validator } from "@cfworker/json-schema";
import { AgentEngine, MAX_CONCURRENT_RUNS } from "../extension-core/agent";
import { historyBeforeEdit } from "../extension-core/conversation";
import { ModelCatalogue, effectiveSettings } from "../extension-core/catalogue";
import { BUILTIN_TOOLS } from "../extension-core/tools";
import { testModel } from "../extension-core/model";
import type {
  AppState,
  ModelInfo,
  RunRecord,
  Settings,
  BrowserTransport,
  BridgeStatus,
} from "../shared/types";
import { ExtensionStore } from "./store";
import { ProviderStore } from "./providers";
import { settingsSchema, normalizeSettings, record, z } from "./validation";
import {
  perform,
  listTabs,
  detachAll,
  releaseTab,
  prepareRun,
  setNotifier,
  hasPendingDialogs,
  recoverSessions,
} from "./browser.js";

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
function claimTab(tabId: number, runId?: string) {
  const owner = tabLeases.get(tabId);
  if (owner && owner !== runId && (engine.isActive(owner) || admitting.has(owner)))
    throw new Error(`Tab ${tabId} is owned by another task. Choose an unleased tab or navigate with newTab:true.`);
  if (runId) tabLeases.set(tabId, runId);
}
async function releaseRun(runId: string) {
  for (const [tabId, owner] of tabLeases) {
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
function redact(message: string) {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}
function transportForRun(runId?: string): BrowserTransport {
  return {
    status: () => ({ connected: true, browser: "Chrome", tabs: tabsFor(runId) }),
    execute: (action, args, signal) => {
      const job = async () => {
        signal?.throwIfAborted();
        await store.flush();
        signal?.throwIfAborted();
        if (runId && !engine.isActive(runId)) throw new Error("Run is not active.");
        const result = await perform(action, args, (tabId: number) => {
          signal?.throwIfAborted();
          claimTab(tabId, runId);
        }, !!runId);
        signal?.throwIfAborted();
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
setNotifier((type: string, data: any) => {
  if (type === "tabs") {
    tabs = data;
    broadcast("bridge", transport.status());
  } else {
    broadcast(type, data);
    if (type === "browser_notice" && data.event === "detached") {
      const owner = tabLeases.get(data.tabId);
      const stopped = data.reason === "canceled_by_user" ? engine.activeRunIds
        : ["target_closed", "connection_lost"].includes(data.reason) && owner && engine.isActive(owner) ? [owner] : [];
      for (const runId of stopped) engine.stop(
        runId,
        "Chrome disconnected the browser debugger. Check the page, then start a new task to reconnect. No browser action was replayed.",
      );
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
  await store.init();
  await providers.init(store.settings, apiKey);
  await catalogue.init();
  await recoverSessions();
  tabLeases.clear();
  await refreshTabs();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
})();
function state(): AppState {
  return {
    providers: providers.summaries(), activeProviderId: providers.activeId,
    settings: normalizeSettings(store.settings),
    modelInfo: catalogue.peek(store.settings, apiKey),
    hasApiKey: !!apiKey,
    bridge: transport.status(),
    runs: store.summaries(),
    activeRunId: engine.activeRunId,
    activeRunIds: engine.activeRunIds,
    tools: BUILTIN_TOOLS,
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
    modelInfo: catalogue.peek(store.settings, apiKey),
    activeRunIds: engine.activeRunIds,
    activeRunId: engine.activeRunId,
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
  if (method === "PUT" && path === "/api/settings") {
    if (engine.activeRunIds.length || admissions)
      throw new Error("Stop the active tasks before changing settings.");
    if (body.providerId !== undefined && body.providerId !== providers.activeId) throw new Error("Provider changed in another window. Reload settings before saving.");
    const settings = settingsSchema.parse(body) as Settings;
    const nextKey =
      body.apiKey === undefined
        ? apiKey
        : z.string().max(10000).parse(body.apiKey);
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
    const key = input.apiKey === undefined ? apiKey : input.apiKey;
    try {
      const { models, warnings } = await listProviderModels(input.refresh ?? url.searchParams.has("refresh"), { settings: candidate, key });
      return { models, modelInfo: catalogue.peek(candidate, key), warnings };
    } catch (error) {
      throw new Error(
        key ? String(error).split(key).join("[redacted]") : String(error),
      );
    }
  }
  if (method === "POST" && path === "/api/model/test") {
    const candidate = settingsSchema.parse({
      ...store.settings,
      ...body,
    }) as Settings;
    const key =
      body.apiKey === undefined
        ? apiKey
        : z.string().max(10000).parse(body.apiKey);
    admissions++;
    try {
      await enqueue(async () => {
        if (!engine.activeRunIds.length) await prepareRun(undefined, (tabId: number) => claimTab(tabId));
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
        : await enqueue(() => prepareRun(input.tabId, (tabId: number) => claimTab(tabId, runId)));
      await refreshTabs();
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
          : await enqueue(() => prepareRun(input.tabId, (tabId: number) => claimTab(tabId, id)));
        await refreshTabs();
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
