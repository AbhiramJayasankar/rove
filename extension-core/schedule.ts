/** Scheduled tasks: a prompt Rove runs by itself at set times, in a new tab, while Chrome is open.
 *  Times are the computer's local time. */
export type ScheduleRepeat =
  /** Once, at `at`. */
  | { kind: "once"; at: number }
  /** At `time` (HH:MM) on each of `days` (0 = Sunday). All seven days is every day. */
  | { kind: "days"; time: string; days: number[] }
  /** Every `hours` hours, counted from `start`. */
  | { kind: "hours"; hours: number; start: number };

export type ScheduleOutcome = "running" | "completed" | "failed" | "stopped" | "awaiting_approval" | "awaiting_user" | "skipped";
export type Schedule = {
  id: string;
  /** Short name shown in the list; the prompt's first line when empty. */
  name: string;
  prompt: string;
  repeat: ScheduleRepeat;
  enabled: boolean;
  createdAt: number;
  /** When it runs next; absent when it will not run again (a past one-off, or turned off). */
  nextAt?: number;
  lastRun?: { runId?: string; at: number; outcome: ScheduleOutcome; note?: string };
};

export const MAX_SCHEDULES = 50;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function parseTime(time: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`Invalid time "${time}". Use HH:MM.`);
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (hours > 23 || minutes > 59) throw new Error(`Invalid time "${time}". Use HH:MM.`);
  return [hours, minutes];
}

/** The first time strictly after `after` that the schedule runs, or undefined when it never runs again. */
export function nextRunAfter(repeat: ScheduleRepeat, after: number): number | undefined {
  if (repeat.kind === "once") return repeat.at > after ? repeat.at : undefined;
  if (repeat.kind === "hours") {
    const every = Math.max(1, Math.min(168, Math.round(repeat.hours))) * HOUR;
    if (repeat.start > after) return repeat.start;
    return repeat.start + (Math.floor((after - repeat.start) / every) + 1) * every;
  }
  const days = [...new Set(repeat.days)].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (!days.length) return undefined;
  const [hours, minutes] = parseTime(repeat.time);
  const base = new Date(after);
  // Look at most eight days ahead; local dates handle daylight-saving changes.
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hours, minutes, 0, 0);
    if (candidate.getTime() > after && days.includes(candidate.getDay())) return candidate.getTime();
  }
  return undefined;
}

export function scheduleName(schedule: Pick<Schedule, "name" | "prompt">): string {
  const name = schedule.name.trim() || schedule.prompt.trim().split("\n")[0];
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}
