import { describe, expect, it } from "vitest";
import { runReport } from "../report";
import type { RunRecord } from "../../shared/types";

const event = (id: number, time: string, type: string, data: Record<string, any>) => ({ id, time, type, data });

describe("run report for connected apps", () => {
  it("adds up time, model, steps, tools, tokens, cost and pages from a run's events", () => {
    const run: RunRecord = {
      id: "r1", prompt: "Open two animals", status: "completed",
      createdAt: "2026-11-20T17:34:40.000Z", updatedAt: "2026-11-20T17:35:12.000Z",
      events: [
        event(1, "2026-11-20T17:34:40.000Z", "user_message", { content: "Open two animals" }),
        event(2, "2026-11-20T17:34:40.100Z", "run_configuration", { settings: { baseUrl: "https://tokenharbor.ai/v1", model: "mimo-v2.6-flash:free" } }),
        event(3, "2026-11-20T17:34:40.200Z", "model_metadata", { model: { id: "mimo", free: true } }),
        event(4, "2026-11-20T17:34:41.000Z", "model_request", {}),
        event(5, "2026-11-20T17:34:45.000Z", "model_response", { usage: { prompt_tokens: 3000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1000 } } }),
        event(6, "2026-11-20T17:34:45.100Z", "tool_call", { name: "browser_navigate", args: {} }),
        event(7, "2026-11-20T17:34:47.000Z", "tool_result", { name: "browser_navigate", result: JSON.stringify({ tabId: 5, url: "https://en.wikipedia.org/wiki/Red_fox", title: "Red fox" }) }),
        event(8, "2026-11-20T17:34:47.100Z", "tool_call", { name: "browser_navigate", args: {} }),
        event(9, "2026-11-20T17:34:49.000Z", "tool_result", { name: "browser_navigate", result: null, error: "timed out" }),
        event(10, "2026-11-20T17:34:50.000Z", "model_request", {}),
        event(11, "2026-11-20T17:35:11.000Z", "model_response", { usage: { prompt_tokens: 3500, completion_tokens: 120 } }),
        event(12, "2026-11-20T17:35:12.000Z", "status", { status: "completed" }),
      ],
    };
    expect(runReport(run)).toEqual({
      startedAt: "2026-11-20T17:34:40.000Z",
      finishedAt: "2026-11-20T17:35:12.000Z",
      durationSeconds: 32,
      model: "mimo-v2.6-flash:free",
      provider: "tokenharbor.ai",
      steps: 2,
      modelRequests: 2,
      tools: { browser_navigate: 2 },
      failedToolCalls: 1,
      tokens: { input: 6500, output: 200, cached: 1000, reasoning: 0, complete: true },
      costUsd: 0,
      pages: [{ tabId: 5, url: "https://en.wikipedia.org/wiki/Red_fox", title: "Red fox" }],
    });
  });
  it("leaves out what the run does not record", () => {
    const report = runReport({ id: "r2", prompt: "x", status: "running", createdAt: new Date(Date.now() - 5000).toISOString(), updatedAt: "", events: [] });
    expect(report.finishedAt).toBeUndefined();
    expect(report.model).toBeUndefined();
    expect(report.costUsd).toBeUndefined();
    expect(report.durationSeconds).toBeGreaterThanOrEqual(4.9);
    expect(report.tokens.complete).toBe(true);
  });
});
