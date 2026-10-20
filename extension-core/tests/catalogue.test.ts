import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelCatalogue,
  normalizeModel,
  effectiveSettings,
} from "../catalogue";
import { generationOptions, ModelEndpointError } from "../model";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import { reasoningOptions, resolvedReasoningEffort } from "../../shared/capabilities";
afterEach(() => vi.unstubAllGlobals());
describe("endpoint model metadata", () => {
  it("uses labels, prices, tools, modalities and the most restrictive limits", () => {
    const info = normalizeModel(
      {
        id: "unfamiliar-model",
        label: "Friendly model",
        context_length: 1048576,
        top_provider: { context_length: 262144, max_completion_tokens: 8192 },
        tool_call: true,
        architecture: {
          input_modalities: ["text"],
          output_modalities: ["text"],
        },
        supported_parameters: [
          "tools",
          "reasoning_effort",
          "max_completion_tokens",
        ],
        reasoning_efforts: ["low", "high"],
        pricing: { input_usd_per_1m: 0, output_usd_per_1m: 0 },
      },
      "endpoint/models",
    );
    expect(info).toMatchObject({
      name: "Friendly model",
      contextWindow: 262144,
      maxOutputTokens: 8192,
      supportsTools: true,
      supportsVision: false,
      free: true,
      reasoningFormat: "reasoning_effort",
      outputTokenParameter: "max_completion_tokens",
    });
    const settings = effectiveSettings(
      {
        ...DEFAULT_SETTINGS,
        contextWindow: 9999999,
        maxOutputTokens: 32000,
        vision: true,
      },
      info,
    );
    expect(settings).toMatchObject({
      contextWindow: 262144,
      maxOutputTokens: 8192,
      vision: false,
    });
    expect(
      generationOptions({ ...settings, reasoningEffort: "high" }, info),
    ).toEqual({ max_completion_tokens: 8192, reasoning_effort: "high" });
  });
  it("reads OpenRouter's nested reasoning object for effort tiers", () => {
    const info = normalizeModel(
      {
        id: "vendor/tiered:free",
        context_length: 200000,
        supported_parameters: ["tools", "reasoning", "reasoning_effort", "include_reasoning"],
        reasoning: { mandatory: false, supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"], default_effort: "high" },
      },
      "https://openrouter.ai/api/v1/models",
    );
    expect(info.reasoningFormat).toBe("reasoning");
    expect(reasoningOptions(DEFAULT_SETTINGS, info).map((o) => o.value)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(resolvedReasoningEffort(DEFAULT_SETTINGS, info)).toBe("max");
    expect(generationOptions({ ...DEFAULT_SETTINGS, reasoningEffort: "xhigh" }, info)).toMatchObject({ reasoning: { effort: "xhigh" } });
  });
  it("shows an on/off control for optional reasoning without tiers, and nothing for mandatory or absent reasoning", () => {
    const toggle = normalizeModel(
      { id: "vendor/toggle", supported_parameters: ["reasoning"], reasoning: { mandatory: false, default_enabled: true } },
      "https://openrouter.ai/api/v1/models",
    );
    expect(reasoningOptions(DEFAULT_SETTINGS, toggle).map((o) => o.label)).toEqual(["Thinking off", "Thinking on"]);
    expect(generationOptions({ ...DEFAULT_SETTINGS, reasoningEffort: "none" }, toggle)).toMatchObject({ reasoning: { enabled: false } });
    expect(generationOptions({ ...DEFAULT_SETTINGS, reasoningEffort: "high" }, toggle)).toMatchObject({ reasoning: { enabled: true } });
    const mandatory = normalizeModel(
      { id: "vendor/always", supported_parameters: ["reasoning"], reasoning: { mandatory: true } },
      "https://openrouter.ai/api/v1/models",
    );
    expect(reasoningOptions(DEFAULT_SETTINGS, mandatory)).toHaveLength(1);
    const none = normalizeModel({ id: "vendor/plain", supported_parameters: ["tools"] }, "https://openrouter.ai/api/v1/models");
    expect(reasoningOptions(DEFAULT_SETTINGS, none)).toHaveLength(1);
  });
  it("does not invent capabilities from an unknown model ID", () => {
    const info = normalizeModel(
      { id: "mimo-future:free", context_length: 1000000, tool_call: true },
      "endpoint/models",
    );
    expect(info.reasoningFormat).toBeUndefined();
    expect(info.supportsVision).toBeUndefined();
    expect(info.maxOutputTokens).toBeUndefined();
    expect(() =>
      generationOptions(
        { ...DEFAULT_SETTINGS, model: info.id, reasoningEffort: "high" },
        info,
      ),
    ).toThrow("does not advertise");
    expect(generationOptions(DEFAULT_SETTINGS, info)).not.toHaveProperty(
      "reasoning_effort",
    );
  });
  it("recognizes structured context rejections without treating authentication errors as retryable", () => {
    const error = new ModelEndpointError(
      "Context window exceeded",
      400,
      "context_length_exceeded",
      { error: { max_context_length: 65536 } },
    );
    expect(error.contextExceeded).toBe(true);
    expect(error.contextLimit).toBe(65536);
    expect(
      new ModelEndpointError("context window", 401, "invalid_api_key")
        .contextExceeded,
    ).toBe(false);
  });
});
