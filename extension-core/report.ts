import type { RunRecord } from "../shared/types";
import { chatUsage } from "../shared/usage";

/** What a connected app learns about a Rove task besides its answer: time, model, steps, tokens,
 *  cost and the pages it worked on. Read from the run's own events. */
export type RunReport = {
  startedAt: string;
  finishedAt?: string;
  durationSeconds: number;
  model?: string;
  provider?: string;
  steps: number;
  modelRequests: number;
  tools: Record<string, number>;
  failedToolCalls: number;
  tokens: { input: number; output: number; cached: number; reasoning: number; complete: boolean };
  costUsd?: number;
  pages: { tabId?: number; url: string; title?: string }[];
};

const FINISHED = new Set(["completed", "failed", "stopped"]);

function parsed(value: unknown): any {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function runReport(run: RunRecord): RunReport {
  const events = run.events;
  const configuration = events.findLast((event) => event.type === "run_configuration")?.data;
  const lastStatus = events.findLast((event) => event.type === "status");
  const finished = FINISHED.has(run.status) && lastStatus ? lastStatus.time : undefined;
  const start = Date.parse(run.createdAt);
  const end = Date.parse(finished ?? new Date().toISOString());
  const tools: Record<string, number> = {};
  let failed = 0;
  const pages = new Map<string, { tabId?: number; url: string; title?: string }>();
  for (const event of events) {
    if (event.type === "tool_call" && typeof event.data.name === "string")
      tools[event.data.name] = (tools[event.data.name] ?? 0) + 1;
    if (event.type !== "tool_result") continue;
    if (event.data.error) failed++;
    const result = parsed(event.data.result);
    if (result && typeof result === "object" && typeof result.url === "string" && /^https?:|^file:/.test(result.url)) {
      const key = `${result.tabId ?? ""} ${result.url}`;
      pages.delete(key);
      pages.set(key, { ...(Number.isInteger(result.tabId) ? { tabId: result.tabId } : {}), url: result.url, ...(result.title ? { title: String(result.title) } : {}) });
    }
  }
  const usage = chatUsage(events);
  let provider: string | undefined;
  try {
    provider = configuration?.settings?.baseUrl ? new URL(configuration.settings.baseUrl).host : undefined;
  } catch {}
  return {
    startedAt: new Date(start).toISOString(),
    ...(finished ? { finishedAt: finished } : {}),
    durationSeconds: Math.max(0, Math.round((end - start) / 100) / 10),
    ...(configuration?.settings?.model ? { model: String(configuration.settings.model) } : {}),
    ...(provider ? { provider } : {}),
    steps: Object.values(tools).reduce((sum, count) => sum + count, 0),
    modelRequests: usage.requests,
    tools,
    failedToolCalls: failed,
    tokens: {
      input: usage.input,
      output: usage.output,
      cached: usage.cached,
      reasoning: usage.reasoning,
      // false when some responses did not report token counts.
      complete: usage.inputReports === usage.requests && usage.outputReports === usage.requests,
    },
    ...(usage.cost != null && usage.requests > 0 ? { costUsd: Math.round(usage.cost * 1e6) / 1e6 } : {}),
    // The last few pages, latest last.
    pages: [...pages.values()].slice(-8),
  };
}
