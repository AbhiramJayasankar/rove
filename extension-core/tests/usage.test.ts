import { describe, it, expect } from "vitest";
import { chatUsage } from "../../shared/usage";
import { normalizeModel } from "../catalogue";
import type { RunEvent } from "../../shared/types";
const event = (id: number, type: string, data: any): RunEvent => ({
  id,
  type,
  data,
  time: new Date().toISOString(),
});
describe("chat usage accounting", () => {
  it("totals every response across model changes and respects pricing units and cache rates", () => {
    const first = normalizeModel(
      {
        id: "a",
        pricing: {
          input_usd_per_1m: 2,
          output_usd_per_1m: 8,
          cached_input_usd_per_1m: 0.5,
        },
      },
      "fixture",
    );
    const second = normalizeModel(
      { id: "b", pricing: { prompt: 0.000001, completion: 0.000003 } },
      "fixture",
    );
    const summary = chatUsage([
      event(1, "model_metadata", { model: first }),
      event(2, "model_response", {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          prompt_tokens_details: { cached_tokens: 400 },
          completion_tokens_details: { reasoning_tokens: 50 },
        },
      }),
      event(3, "model_metadata", { model: second }),
      event(4, "context_usage", {
        contextWindow: 131072,
        estimatedTokens: 2000,
        inputBudget: 120000,
        reservedOutputTokens: 8192,
      }),
      event(5, "model_response", {
        usage: { prompt_tokens: 2000, completion_tokens: 200 },
      }),
    ]);
    expect(summary).toMatchObject({
      input: 3000,
      output: 300,
      cached: 400,
      reasoning: 50,
      responses: 2,
      current: 2000,
      estimated: false,
      contextWindow: 131072,
      inputBudget: 120000,
      outputBudget: 8192,
    });
    expect(summary.cost).toBeCloseTo(0.0048);
  });
  it("prefers provider-reported cost and keeps unknown pricing distinct from zero", () => {
    expect(
      chatUsage([
        event(1, "model_response", {
          usage: { cost: 0.42, prompt_tokens: 4, completion_tokens: 8 },
        }),
      ]).cost,
    ).toBe(0.42);
    const unknown = chatUsage([event(1, "model_response", {})]);
    expect(unknown.cost).toBeUndefined();
    expect(unknown.inputReports).toBe(0);
    expect(
      chatUsage(
        [event(1, "model_response", {})],
        normalizeModel({ id: "fixture:free" }, "fixture"),
      ).cost,
    ).toBe(0);
  });
  it("does not present interrupted requests as complete zero-cost usage", () => {
    const summary = chatUsage([
      event(1, "model_request", { step: 1 }),
      event(2, "model_delta", { content: "Partial output" }),
    ]);
    expect(summary).toMatchObject({
      requests: 1,
      responses: 0,
      inputReports: 0,
      outputReports: 0,
    });
    expect(summary.cost).toBeUndefined();
  });
  it("uses the current request estimate while streaming without counting output twice", () => {
    const summary = chatUsage([
      event(1, "model_response", {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      }),
      event(2, "context_usage", { estimatedTokens: 500, contextWindow: 10000 }),
    ]);
    expect(summary).toMatchObject({
      current: 500,
      estimated: true,
      output: 30,
      reasoning: 20,
    });
  });
});
