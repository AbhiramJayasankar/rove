import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import { normalizeModel, effectiveSettings } from "../catalogue";
import { generationOptions } from "../model";
import {
  reasoningOptions,
  resolvedReasoningEffort,
} from "../../shared/capabilities";
import { normalizeSettings } from "../../extension-src/validation";

describe("automatic model controls", () => {
  it("uses endpoint effort enums and model maxima instead of legacy manual limits", () => {
    const info = normalizeModel(
      {
        id: "new-model",
        name: "New model",
        context_window: 1048576,
        max_output_tokens: 131072,
        effort: { supported_levels: ["low", "medium", "high", "xhigh", "max"] },
        supported_parameters: ["reasoning_effort", "tools"],
        input_modalities: ["text", "image"],
      },
      "https://example.test/v1/models",
    );
    const legacy = {
      ...DEFAULT_SETTINGS,
      contextWindow: 4096,
      maxOutputTokens: 1024,
      vision: false,
      stream: false,
    };
    const settings = effectiveSettings(legacy, info);
    expect(settings).toMatchObject({
      contextWindow: 1048576,
      maxOutputTokens: 131072,
      vision: true,
      stream: true,
      reasoningEffort: "max",
      contextMode: "auto",
    });
    expect(
      reasoningOptions(settings, info).map((option) => option.label),
    ).toEqual(["Low", "Medium", "High", "X high", "Max"]);
    expect(generationOptions(settings, info)).toMatchObject({
      max_tokens: 131072,
      reasoning_effort: "max",
    });
    expect(
      resolvedReasoningEffort({ ...settings, reasoningEffort: "low" }, info),
    ).toBe("low");
  });
  it("uses documented gateway limits only for exact known endpoints and IDs, with endpoint fields taking precedence", () => {
    const info = normalizeModel(
      { id: "deepseek-v4.1-flash:free", label: "DeepSeek V4.1 Flash (Free)" },
      "https://tokenharbor.ai/v1/models",
    );
    expect(info).toMatchObject({
      contextWindow: 1048576,
      maxOutputTokens: 128000,
      supportsVision: true,
      reasoningEfforts: ["low", "high", "max"],
    });
    expect(info.capabilitySources?.length).toBe(2);
    expect(
      generationOptions(effectiveSettings(DEFAULT_SETTINGS, info), info),
    ).toMatchObject({
      reasoning_effort: "max",
      thinking: { type: "enabled" },
      max_tokens: 128000,
    });
    expect(
      generationOptions({ ...DEFAULT_SETTINGS, reasoningEffort: "none" }, info),
    ).toEqual({ max_tokens: 16384, thinking: { type: "disabled" } });
    const overridden = normalizeModel(
      {
        id: info.id,
        max_output_tokens: 20000,
        reasoning_efforts: ["low", "high"],
        input_modalities: ["text"],
      },
      info.source,
    );
    expect(overridden.maxOutputTokens).toBe(20000);
    expect(overridden.supportsVision).toBe(false);
    expect(overridden.reasoningEfforts).toEqual(["low", "high"]);
    expect(
      normalizeModel({ id: info.id }, "https://other-provider.test/models")
        .reasoningFormat,
    ).toBeUndefined();
  });
  it("does not advertise distinct MiMo intensity tiers absent endpoint support", () => {
    const info = normalizeModel(
      { id: "mimo-v2.6-flash:free" },
      "https://tokenharbor.ai/v1/models",
    );
    expect(
      reasoningOptions(DEFAULT_SETTINGS, info).map((option) => option.label),
    ).toEqual(["Thinking off", "Thinking on"]);
    expect(
      generationOptions(effectiveSettings(DEFAULT_SETTINGS, info), info),
    ).toMatchObject({ thinking: { type: "enabled" } });
    const advertised = normalizeModel(
      {
        id: info.id,
        supported_parameters: ["reasoning"],
        reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
      info.source,
    );
    expect(
      reasoningOptions(DEFAULT_SETTINGS, advertised).map(
        (option) => option.value,
      ),
    ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(
      generationOptions(
        effectiveSettings(DEFAULT_SETTINGS, advertised),
        advertised,
      ),
    ).toMatchObject({ reasoning: { effort: "max" } });
  });
  it("shows the documented reasoning control for each free TokenHarbor model", () => {
    const labels = (id: string) =>
      reasoningOptions(
        DEFAULT_SETTINGS,
        normalizeModel({ id }, "https://tokenharbor.ai/v1/models"),
      ).map((option) => option.label);
    expect(labels("mimo-v2.5:free")).toEqual(["Thinking off", "Thinking on"]);
    expect(labels("mimo-v2.6-flash:free")).toEqual(["Thinking off", "Thinking on"]);
    expect(labels("deepseek-v4-flash:free")).toEqual(["Off", "Low", "High", "Max"]);
    expect(labels("deepseek-v4.1-flash:free")).toEqual(["Off", "Low", "High", "Max"]);
  });
  it("shows distinct DeepSeek levels while keeping aliases compatible internally", () => {
    const info = normalizeModel(
      { id: "deepseek-v4.1-flash:free" },
      "https://tokenharbor.ai/v1/models",
    );
    const options = reasoningOptions(DEFAULT_SETTINGS, info);
    expect(options.map((option) => option.value)).toEqual([
      "none",
      "low",
      "high",
      "max",
    ]);
    expect(
      resolvedReasoningEffort(
        { ...DEFAULT_SETTINGS, reasoningEffort: "medium" },
        info,
      ),
    ).toBe("high");
    expect(
      generationOptions({ ...DEFAULT_SETTINGS, reasoningEffort: "xhigh" }, info)
        .reasoning_effort,
    ).toBe("high");
    expect(resolvedReasoningEffort(DEFAULT_SETTINGS, info)).toBe("max");
  });
  it("migrates removed controls and custom definitions without exposing them", () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      contextMode: "manual",
      reasoningFormat: "thinking",
      stream: false,
      vision: false,
      customTools: [{ name: "legacy" }],
    });
    expect(settings).toMatchObject({
      contextMode: "auto",
      reasoningFormat: "auto",
      stream: true,
      vision: true,
    });
    expect(settings).not.toHaveProperty("customTools");
  });
});
