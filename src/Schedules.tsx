import { useState } from "react";
import { CalendarClock, LoaderCircle, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Schedule, ScheduleRepeat } from "../extension-core/schedule";
import type { AppState } from "../shared/types";
import { api, json } from "./ui";
import { useT } from "./i18n";

type Kind = ScheduleRepeat["kind"];
type Draft = { id?: string; name: string; prompt: string; kind: Kind; at: string; time: string; days: number[]; hours: number; start: string; enabled: boolean };
// Monday first, as most calendars outside the US show it.
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const pad = (value: number) => String(value).padStart(2, "0");
/** A timestamp as the value of a datetime-local input, in this computer's time. */
function localInput(time: number) {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function soon() {
  const next = new Date(Date.now() + 60 * 60_000);
  next.setMinutes(Math.ceil(next.getMinutes() / 5) * 5, 0, 0);
  return next.getTime();
}
function blankDraft(): Draft {
  return { name: "", prompt: "", kind: "days", at: localInput(soon()), time: "09:00", days: ALL_DAYS, hours: 3, start: localInput(soon()), enabled: true };
}
function draftOf(schedule: Schedule): Draft {
  const draft = { ...blankDraft(), id: schedule.id, name: schedule.name, prompt: schedule.prompt, kind: schedule.repeat.kind, enabled: schedule.enabled };
  if (schedule.repeat.kind === "once") draft.at = localInput(schedule.repeat.at);
  if (schedule.repeat.kind === "days") Object.assign(draft, { time: schedule.repeat.time, days: schedule.repeat.days });
  if (schedule.repeat.kind === "hours") Object.assign(draft, { hours: schedule.repeat.hours, start: localInput(schedule.repeat.start) });
  return draft;
}
function repeatOf(draft: Draft): ScheduleRepeat {
  if (draft.kind === "once") return { kind: "once", at: new Date(draft.at).getTime() };
  if (draft.kind === "hours") return { kind: "hours", hours: draft.hours, start: new Date(draft.start).getTime() };
  return { kind: "days", time: draft.time, days: [...draft.days].sort() };
}
const weekday = (day: number, style: "short" | "narrow" = "short") => new Date(2024, 0, 7 + day).toLocaleDateString(undefined, { weekday: style });
function when(time: number) {
  const days = (time - Date.now()) / 86_400_000;
  return new Date(time).toLocaleString(undefined, days > -6 && days < 6
    ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
/** "08:30" in this computer's clock style, e.g. "8:30 AM". */
function clock(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(2024, 0, 1, hours, minutes).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function name(schedule: Pick<Schedule, "name" | "prompt">) {
  return schedule.name.trim() || schedule.prompt.trim().split("\n")[0];
}

export default function Schedules({ state, openRun }: { state: AppState; openRun: (id: string) => void }) {
  const t = useT();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const schedules = [...(state.schedules ?? [])].sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || a.createdAt - b.createdAt);
  const asks = state.settings.approvalMode !== "never";

  function describe(repeat: ScheduleRepeat) {
    if (repeat.kind === "once") return t("Once, {when}", { when: when(repeat.at) });
    if (repeat.kind === "hours") return repeat.hours === 1 ? t("Every hour") : t("Every {n} hours", { n: repeat.hours });
    const days = [...new Set(repeat.days)].sort().join();
    if (days === "0,1,2,3,4,5,6") return t("Every day at {time}", { time: clock(repeat.time) });
    if (days === "1,2,3,4,5") return t("Weekdays at {time}", { time: clock(repeat.time) });
    if (days === "0,6") return t("Weekends at {time}", { time: clock(repeat.time) });
    return t("{days} at {time}", { days: WEEK.filter((day) => repeat.days.includes(day)).map((day) => weekday(day)).join(", "), time: clock(repeat.time) });
  }
  function lastRun(schedule: Schedule) {
    const last = schedule.lastRun;
    if (!last) return null;
    const label =
      last.outcome === "running" ? t("Running now") :
      last.outcome === "awaiting_approval" || last.outcome === "awaiting_user" ? t("Waiting for you") :
      last.outcome === "completed" ? t("Finished {when}", { when: when(last.at) }) :
      last.outcome === "failed" ? t("Failed {when}", { when: when(last.at) }) :
      last.outcome === "stopped" ? t("Stopped {when}", { when: when(last.at) }) :
      t("Skipped {when}", { when: when(last.at) });
    const chat = last.runId && state.runs.some((run) => run.id === last.runId) ? last.runId : undefined;
    return (
      <span className={`schedule-last ${last.outcome}`}>
        <span className={`status-dot ${last.outcome === "skipped" ? "" : last.outcome}`} aria-hidden="true" />
        {label}
        {chat && (
          <button type="button" className="text-button" onClick={() => openRun(chat)}>
            {t("Open chat")}
          </button>
        )}
      </span>
    );
  }
  async function call(key: string, job: () => Promise<unknown>) {
    setWorking(key);
    setError("");
    try {
      await job();
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      setWorking("");
    }
  }
  const save = (body: unknown) => api("/api/schedules", { method: "PUT", body: json(body) });
  async function submit() {
    if (!draft) return;
    if (draft.kind !== "days" && Number.isNaN(new Date(draft.kind === "once" ? draft.at : draft.start).getTime())) {
      setError(t("Choose a date and time."));
      return;
    }
    const ok = await call("save", () => save({ ...(draft.id ? { id: draft.id } : {}), name: draft.name, prompt: draft.prompt, repeat: repeatOf(draft), enabled: true }));
    if (ok) setDraft(null);
  }

  return (
    <section className="settings-page schedules-page">
      <div className="settings-content">
      <div className="schedules-heading">
        <h2 className="settings-title">{t("Scheduled tasks")}</h2>
        {!draft && (
          <button type="button" className="button secondary" onClick={() => { setError(""); setDraft(blankDraft()); }}>
            <Plus size={15} />
            {t("New schedule")}
          </button>
        )}
      </div>
      <p className="schedules-note">
        {t("Rove starts these by itself in a new tab at the times you set, using your current model. Chrome has to be open; a time missed while it was closed runs when Chrome opens, if that is within 12 hours.")}
      </p>
      {asks && (
        <p className="schedules-note warn">
          {t("Your approval setting asks before some actions, so a scheduled task may stop and wait for you. Rove sends a notification when it does. Set approvals to Never in the composer for tasks that should run unattended.")}
        </p>
      )}
      {error && <p className="schedules-error" role="alert">{error}</p>}

      {draft && (
        <form className="schedule-editor" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="field">
            <span>{t("What should Rove do?")}</span>
            <textarea
              rows={4}
              required
              value={draft.prompt}
              placeholder={t("Open my GitHub notifications and summarize anything that needs a reply.")}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </label>
          <label className="field">
            <span>{t("Name (optional)")}</span>
            <input value={draft.name} maxLength={120} placeholder={draft.prompt.trim().split("\n")[0] || t("Morning check")} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <div className="field">
            <span>{t("Repeat")}</span>
            <div className="mode-switch repeat-switch" role="radiogroup" aria-label={t("Repeat")}>
              {([["days", t("On days")], ["hours", t("Every few hours")], ["once", t("Once")]] as [Kind, string][]).map(([kind, label]) => (
                <button type="button" role="radio" key={kind} aria-checked={draft.kind === kind} className={draft.kind === kind ? "selected" : ""} onClick={() => setDraft({ ...draft, kind })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {draft.kind === "days" && (
            <div className="schedule-when">
              <div className="day-chips" role="group" aria-label={t("Days")}>
                {WEEK.map((day) => {
                  const on = draft.days.includes(day);
                  return (
                    <button type="button" key={day} aria-pressed={on} aria-label={weekday(day, "short")} className={on ? "selected" : ""}
                      onClick={() => setDraft({ ...draft, days: on ? draft.days.filter((item) => item !== day) : [...draft.days, day] })}>
                      {weekday(day, "narrow")}
                    </button>
                  );
                })}
              </div>
              <label className="field inline-field">
                <span>{t("At")}</span>
                <input type="time" required value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} />
              </label>
            </div>
          )}
          {draft.kind === "hours" && (
            <div className="schedule-when">
              <label className="field inline-field">
                <span>{t("Every")}</span>
                <input type="number" min={1} max={168} required value={draft.hours} onChange={(event) => setDraft({ ...draft, hours: Math.max(1, Math.min(168, Number(event.target.value) || 1)) })} />
                <span>{t("hours, starting")}</span>
              </label>
              <input type="datetime-local" aria-label={t("Starting")} required value={draft.start} onChange={(event) => setDraft({ ...draft, start: event.target.value })} />
            </div>
          )}
          {draft.kind === "once" && (
            <div className="schedule-when">
              <input type="datetime-local" aria-label={t("Date and time")} required value={draft.at} onChange={(event) => setDraft({ ...draft, at: event.target.value })} />
            </div>
          )}
          <div className="schedule-editor-actions">
            <button type="button" className="button secondary" onClick={() => { setDraft(null); setError(""); }}>
              {t("Cancel")}
            </button>
            <button type="submit" className="button primary" disabled={working === "save" || !draft.prompt.trim()}>
              {working === "save" && <LoaderCircle className="spin" size={14} />}
              {draft.id ? t("Save") : t("Schedule")}
            </button>
          </div>
        </form>
      )}

      {!schedules.length && !draft && (
        <div className="schedules-empty">
          <CalendarClock size={22} aria-hidden="true" />
          <p>{t("Nothing scheduled. Add a task Rove should run by itself, like a daily check of a dashboard or your inbox.")}</p>
        </div>
      )}
      <ul className="schedule-list">
        {schedules.map((schedule) => (
          <li key={schedule.id} className={`schedule-card${schedule.enabled ? "" : " off"}`}>
            <div className="schedule-main">
              <strong>{name(schedule)}</strong>
              <span className="schedule-repeat">{describe(schedule.repeat)}</span>
              {schedule.enabled && schedule.nextAt !== undefined && schedule.repeat.kind !== "once" && (
                <span className="schedule-next">{t("Next: {when}", { when: when(schedule.nextAt) })}</span>
              )}
              {lastRun(schedule)}
            </div>
            <div className="schedule-actions">
              <label className="tool-toggle" title={schedule.enabled ? t("Turn off") : t("Turn on")}>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={t("{name} is on", { name: name(schedule) })}
                  checked={schedule.enabled}
                  disabled={!!working}
                  onChange={(event) => void call(schedule.id, () => save({ id: schedule.id, name: schedule.name, prompt: schedule.prompt, repeat: schedule.repeat, enabled: event.target.checked }))}
                />
                <span className="switch" aria-hidden="true" />
              </label>
              <div className="schedule-buttons">
                <button type="button" className="icon-button" aria-label={t("Run now")} title={t("Run now")} disabled={!!working}
                  onClick={() => void call(schedule.id, async () => {
                    const { runId } = await api<{ runId?: string }>("/api/schedules/run", { method: "POST", body: json({ id: schedule.id }) });
                    if (runId) openRun(runId);
                  })}>
                  {working === schedule.id ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
                </button>
                <button type="button" className="icon-button" aria-label={t("Edit")} title={t("Edit")} onClick={() => { setError(""); setDraft(draftOf(schedule)); }}>
                  <Pencil size={15} />
                </button>
                <button type="button" className="icon-button danger" aria-label={t("Delete")} title={t("Delete")} disabled={!!working}
                  onClick={() => { if (confirm(t("Delete the scheduled task \"{name}\"?", { name: name(schedule) }))) void call(schedule.id, () => api("/api/schedules", { method: "DELETE", body: json({ id: schedule.id }) })); }}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      </div>
    </section>
  );
}
