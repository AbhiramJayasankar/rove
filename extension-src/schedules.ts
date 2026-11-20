import { MAX_SCHEDULES, nextRunAfter, scheduleName, type Schedule, type ScheduleOutcome, type ScheduleRepeat } from "../extension-core/schedule";

/** Runs saved prompts at set times through chrome.alarms. Alarms survive the worker sleeping; after a
 *  Chrome restart or an extension update `sync()` sets them again from storage. */
const STORAGE_KEY = "schedules";
const ALARM_PREFIX = "rove-schedule:";
const RETRY_MS = 5 * 60_000;
/** A run that could not start because three tasks were running is retried for this long. */
const RETRY_FOR_MS = 30 * 60_000;
/** A time missed while Chrome was closed still runs if Chrome opens within this long. */
const LATE_LIMIT_MS = 12 * 60 * 60_000;

export type SchedulerDeps = {
  startRun(prompt: string): Promise<{ id: string }>;
  canStart(): boolean;
  changed(schedules: Schedule[]): void;
  notify(schedule: Schedule, title: string, message: string, runId?: string): void;
};
export type ScheduleInput = { id?: string; name: string; prompt: string; repeat: ScheduleRepeat; enabled: boolean };

export class Scheduler {
  schedules: Schedule[] = [];
  private retrySince = new Map<string, number>();
  /** Schedules being started right now, so a second alarm for the same time cannot start them twice. */
  private firing = new Set<string>();
  private runs = new Map<string, string>(); // runId -> schedule id
  private writing = Promise.resolve();
  constructor(private deps: SchedulerDeps) {}

  async load() {
    const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    this.schedules = Array.isArray(saved) ? saved : [];
    for (const schedule of this.schedules)
      if (schedule.lastRun?.runId && ["running", "awaiting_approval", "awaiting_user"].includes(schedule.lastRun.outcome))
        // The worker restarted mid-run: the engine fails interrupted runs, so this one ended.
        schedule.lastRun = { ...schedule.lastRun, outcome: "failed", note: "Rove restarted while it ran." };
    await this.sync();
  }

  /** Make the alarms match storage, and run what came due while Chrome was closed. */
  async sync(now = Date.now()) {
    const alarms = await chrome.alarms.getAll();
    const wanted = new Set<string>();
    for (const schedule of this.schedules) {
      if (!schedule.enabled) {
        schedule.nextAt = undefined;
        continue;
      }
      if (schedule.nextAt === undefined) schedule.nextAt = nextRunAfter(schedule.repeat, now);
      else if (schedule.nextAt <= now) {
        const missedAt = schedule.nextAt;
        if (now - missedAt <= LATE_LIMIT_MS) {
          schedule.nextAt = now + 1000;
        } else {
          schedule.lastRun = { at: missedAt, outcome: "skipped", note: "Chrome was closed at the scheduled time." };
          schedule.nextAt = nextRunAfter(schedule.repeat, now);
          if (schedule.repeat.kind === "once") schedule.enabled = false;
        }
      }
      if (schedule.nextAt !== undefined) {
        wanted.add(ALARM_PREFIX + schedule.id);
        await chrome.alarms.create(ALARM_PREFIX + schedule.id, { when: Math.max(schedule.nextAt, now + 1000) });
      }
    }
    for (const alarm of alarms)
      if (alarm.name.startsWith(ALARM_PREFIX) && !wanted.has(alarm.name)) await chrome.alarms.clear(alarm.name);
    await this.persist();
  }

  async save(input: ScheduleInput): Promise<Schedule> {
    const existing = input.id ? this.schedules.find((item) => item.id === input.id) : undefined;
    if (input.id && !existing) throw new Error("Scheduled task not found.");
    if (!existing && this.schedules.length >= MAX_SCHEDULES) throw new Error(`Rove keeps at most ${MAX_SCHEDULES} scheduled tasks.`);
    const now = Date.now();
    if (input.enabled && nextRunAfter(input.repeat, now) === undefined)
      throw new Error(input.repeat.kind === "once" ? "Choose a time in the future." : "Choose at least one day.");
    const schedule: Schedule = {
      ...(existing ?? { id: crypto.randomUUID(), createdAt: now }),
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      repeat: input.repeat,
      enabled: input.enabled,
      nextAt: undefined,
    };
    this.schedules = existing ? this.schedules.map((item) => (item.id === schedule.id ? schedule : item)) : [...this.schedules, schedule];
    this.retrySince.delete(schedule.id);
    await this.sync(now);
    return this.schedules.find((item) => item.id === schedule.id)!;
  }

  async remove(id: string) {
    this.schedules = this.schedules.filter((item) => item.id !== id);
    this.retrySince.delete(id);
    await chrome.alarms.clear(ALARM_PREFIX + id);
    await this.persist();
  }

  /** Start a schedule's task now, outside its times. */
  async runNow(id: string) {
    const schedule = this.schedules.find((item) => item.id === id);
    if (!schedule) throw new Error("Scheduled task not found.");
    if (!this.deps.canStart()) throw new Error("Three tasks are already running. Wait for one to finish.");
    return this.start(schedule, Date.now(), false);
  }

  /** chrome.alarms.onAlarm. Returns false for alarms that are not Rove schedules. */
  async onAlarm(name: string): Promise<boolean> {
    if (!name.startsWith(ALARM_PREFIX)) return false;
    const schedule = this.schedules.find((item) => item.id === name.slice(ALARM_PREFIX.length));
    if (!schedule?.enabled || this.firing.has(schedule.id)) return true;
    const now = Date.now();
    // An alarm left over from before the schedule moved on (or a duplicate) is not due yet.
    if (schedule.nextAt === undefined || schedule.nextAt > now + 2000) return true;
    if (!this.deps.canStart()) {
      const since = this.retrySince.get(schedule.id) ?? now;
      this.retrySince.set(schedule.id, since);
      if (now - since < RETRY_FOR_MS) {
        schedule.nextAt = now + RETRY_MS;
        await chrome.alarms.create(name, { when: schedule.nextAt });
        await this.persist();
        return true;
      }
      this.retrySince.delete(schedule.id);
      schedule.lastRun = { at: now, outcome: "skipped", note: "Three tasks were already running for 30 minutes." };
      this.deps.notify(schedule, `Skipped: ${scheduleName(schedule)}`, "Three other Rove tasks were running, so this one did not start.");
      await this.advance(schedule, now);
      return true;
    }
    this.retrySince.delete(schedule.id);
    this.firing.add(schedule.id);
    try {
      await this.start(schedule, now, true);
    } finally {
      this.firing.delete(schedule.id);
    }
    return true;
  }

  private async start(schedule: Schedule, now: number, advance: boolean) {
    let runId: string | undefined;
    try {
      runId = (await this.deps.startRun(schedule.prompt)).id;
      this.runs.set(runId, schedule.id);
      schedule.lastRun = { runId, at: now, outcome: "running" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      schedule.lastRun = { at: now, outcome: "failed", note: message };
      this.deps.notify(schedule, `Could not start: ${scheduleName(schedule)}`, message);
    }
    if (advance) await this.advance(schedule, now);
    else await this.persist();
    return { runId };
  }

  private async advance(schedule: Schedule, now: number) {
    schedule.nextAt = nextRunAfter(schedule.repeat, now);
    if (schedule.nextAt === undefined) {
      if (schedule.repeat.kind === "once") schedule.enabled = false;
      await chrome.alarms.clear(ALARM_PREFIX + schedule.id);
    } else await chrome.alarms.create(ALARM_PREFIX + schedule.id, { when: schedule.nextAt });
    await this.persist();
  }

  owns(runId: string) {
    return this.runs.has(runId) || this.schedules.some((item) => item.lastRun?.runId === runId);
  }

  /** Keep the list's "last run" in step with the task, and tell the user when it needs them or ends. */
  onRunStatus(runId: string, status: string, summary?: string) {
    const schedule = this.schedules.find((item) => item.id === this.runs.get(runId) || item.lastRun?.runId === runId);
    if (!schedule?.lastRun || schedule.lastRun.runId !== runId) return;
    const outcome = status as ScheduleOutcome;
    if (schedule.lastRun.outcome === outcome) return;
    schedule.lastRun = { ...schedule.lastRun, outcome, ...(summary ? { note: summary } : {}) };
    const name = scheduleName(schedule);
    if (outcome === "completed") this.deps.notify(schedule, `Done: ${name}`, summary || "The scheduled task finished.", runId);
    else if (outcome === "failed") this.deps.notify(schedule, `Failed: ${name}`, summary || "The scheduled task failed.", runId);
    else if (outcome === "awaiting_approval") this.deps.notify(schedule, `Waiting for you: ${name}`, "The scheduled task needs your approval to continue.", runId);
    else if (outcome === "awaiting_user") this.deps.notify(schedule, `Question: ${name}`, summary || "The scheduled task asked you a question.", runId);
    if (["completed", "failed", "stopped"].includes(outcome)) this.runs.delete(runId);
    void this.persist();
  }

  private persist() {
    const snapshot = structuredClone(this.schedules);
    this.writing = this.writing.then(() => chrome.storage.local.set({ [STORAGE_KEY]: snapshot })).catch(() => {});
    this.deps.changed(snapshot);
    return this.writing;
  }
}
