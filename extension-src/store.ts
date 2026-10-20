import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { RunRecord, Settings } from "../shared/types";
import { normalizeSettings } from "./validation";

type RunMeta = Omit<RunRecord, "events"> & { lastEventId: number };

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
}
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(tx.error || new Error("History transaction failed."));
  });
}

/** Append-only event journal. Each metadata/event batch commits atomically. */
export class ExtensionStore {
  settings: Settings = structuredClone(DEFAULT_SETTINGS);
  private db!: IDBDatabase;
  private metas = new Map<string, RunMeta>();
  private counts = new Map<string, number>();
  private pending: Promise<void> = Promise.resolve();
  private failure?: Error;
  async init() {
    const open = indexedDB.open("relay", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("runs", { keyPath: "id" });
      open.result.createObjectStore("events", { keyPath: ["runId", "id"] });
    };
    this.db = await request(open);
    const saved = await chrome.storage.local.get("settings");
    this.settings = normalizeSettings(saved.settings);
    await chrome.storage.local.set({ settings: this.settings });
    const metas = await request<RunMeta[]>(
      this.db.transaction("runs").objectStore("runs").getAll(),
    );
    for (const meta of metas) {
      this.metas.set(meta.id, meta);
      this.counts.set(meta.id, meta.lastEventId);
    }
    // A browser/worker restart must never replay an action whose result is unknown.
    for (const meta of metas) {
      if (!["running", "awaiting_approval"].includes(meta.status)) continue;
      const run = (await this.getRun(meta.id))!;
      run.status = "failed";
      run.updatedAt = new Date().toISOString();
      run.events.push({
        id: meta.lastEventId + 1,
        time: run.updatedAt,
        type: "status",
        data: {
          status: "failed",
          message:
            "Chrome interrupted this task. Its history is saved. Check the page before starting a new task; no actions were replayed.",
        },
      });
      this.saveRun(run);
    }
    await this.flush();
  }
  async saveSettings(settings: Settings) {
    const normalized = normalizeSettings(settings);
    await chrome.storage.local.set({ settings: normalized });
    this.settings = normalized;
  }
  hasRun(id: string) {
    return this.metas.has(id);
  }
  summaries(): RunRecord[] {
    return [...this.metas.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((meta) => ({ ...meta, events: [] }));
  }
  async replaceRun(run: RunRecord) {
    await this.flush();
    const tx = this.db.transaction(["runs", "events"], "readwrite", { durability: "strict" });
    const done = committed(tx);
    const { events, ...record } = run;
    const meta = { ...record, lastEventId: events.at(-1)?.id || 0 };
    tx.objectStore("events").delete(IDBKeyRange.bound([run.id, 0], [run.id, Number.MAX_SAFE_INTEGER]));
    for (const event of events) tx.objectStore("events").put({ ...event, runId: run.id });
    tx.objectStore("runs").put(meta);
    await done;
    this.counts.set(run.id, meta.lastEventId);
    this.metas.set(run.id, meta);
  }
  saveRun(run: RunRecord) {
    const lastEventId = run.events.at(-1)?.id || 0;
    const oldCount = this.counts.get(run.id) || 0;
    const events = run.events.filter((event) => event.id > oldCount);
    const { events: _, ...record } = run;
    const meta = { ...record, lastEventId };
    this.counts.set(run.id, lastEventId);
    this.metas.set(run.id, meta);
    this.pending = this.pending
      .then(async () => {
        const tx = this.db.transaction(["runs", "events"], "readwrite", {
          durability: "strict",
        });
        const done = committed(tx);
        tx.objectStore("runs").put(meta);
        for (const event of events)
          tx.objectStore("events").put({ ...event, runId: run.id });
        await done;
      })
      .catch((error) => {
        this.failure =
          error instanceof Error ? error : new Error(String(error));
      });
  }
  async flush() {
    await this.pending;
    if (this.failure) throw this.failure;
  }
  async getRun(id: string): Promise<RunRecord | undefined> {
    await this.flush();
    const meta = this.metas.get(id);
    if (!meta) return;
    const events = await request<any[]>(
      this.db
        .transaction("events")
        .objectStore("events")
        .getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])),
    );
    const { lastEventId: _, ...record } = meta;
    return { ...record, events: events.map(({ runId: _, ...event }) => event) };
  }
}
