import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ModelInfo, Settings } from "../shared/types";
import { completionUrl } from "./model";
import { readBounded } from "./tools";

const positive = (...values: unknown[]): number | undefined => {
  const numbers = values.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return numbers.length ? Math.floor(Math.min(...numbers)) : undefined;
};
const boolean = (...values: unknown[]): boolean | undefined =>
  values.find((v) => typeof v === "boolean") as boolean | undefined;
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string") : undefined;

export function normalizeModel(
  raw: Record<string, any>,
  source: string,
): ModelInfo {
  const parameters = strings(
    raw.supported_parameters ??
      raw.supportedParameters ??
      raw.capabilities?.supported_parameters,
  );
  const input = strings(
    raw.architecture?.input_modalities ??
      raw.input_modalities ??
      raw.modalities?.input,
  );
  const output = strings(
    raw.architecture?.output_modalities ??
      raw.output_modalities ??
      raw.modalities?.output,
  );
  const reasoningFormat = parameters?.includes("reasoning_effort")
    ? "reasoning_effort"
    : parameters?.some((p) => p === "thinking" || p === "thinking.type")
      ? "thinking"
      : parameters?.includes("enable_thinking")
        ? "enable_thinking"
        : parameters?.includes("reasoning")
          ? "reasoning"
          : undefined;
  const pricing =
    raw.pricing && typeof raw.pricing === "object" ? raw.pricing : undefined;
  const inputPrice =
    pricing?.prompt ?? pricing?.input_usd_per_1m ?? pricing?.input;
  const outputPrice =
    pricing?.completion ?? pricing?.output_usd_per_1m ?? pricing?.output;
  return {
    id: raw.id,
    name: raw.label || raw.name || raw.id,
    owner: raw.owned_by || raw.provider,
    contextWindow: positive(
      raw.context_length,
      raw.context_window,
      raw.max_model_len,
      raw.top_provider?.context_length,
      raw.limits?.context_length,
    ),
    maxInputTokens: positive(
      raw.max_input_tokens,
      raw.limits?.max_input_tokens,
    ),
    maxOutputTokens: positive(
      raw.max_output_tokens,
      raw.max_completion_tokens,
      raw.top_provider?.max_completion_tokens,
      raw.limits?.max_output_tokens,
    ),
    supportsTools: boolean(
      raw.tool_call,
      raw.function_call,
      raw.supports_tools,
      raw.capabilities?.tools,
      parameters
        ? parameters.includes("tools") || parameters.includes("tool_choice")
        : undefined,
    ),
    supportsVision: boolean(
      raw.supports_vision,
      raw.capabilities?.vision,
      input ? input.includes("image") : undefined,
    ),
    inputModalities: input,
    outputModalities: output,
    supportedParameters: parameters,
    reasoningFormat,
    reasoningEfforts: strings(
      raw.reasoning_efforts ??
        raw.supported_reasoning_efforts ??
        raw.capabilities?.reasoning?.efforts,
    ),
    outputTokenParameter: parameters?.includes("max_completion_tokens")
      ? "max_completion_tokens"
      : parameters?.includes("max_tokens")
        ? "max_tokens"
        : undefined,
    free:
      typeof raw.free === "boolean"
        ? raw.free
        : inputPrice != null && outputPrice != null
          ? Number(inputPrice) === 0 && Number(outputPrice) === 0
          : /(?:^|[:/ -])free(?:$|[:/ -])/i.test(raw.id),
    pricing,
    metadata: raw,
    source,
    fetchedAt: new Date().toISOString(),
  };
}

export function effectiveSettings(
  settings: Settings,
  model?: ModelInfo | null,
): Settings {
  const contextWindow = Math.min(
    settings.contextMode === "manual"
      ? settings.contextWindow
      : model?.contextWindow || settings.contextWindow,
    model?.contextWindow || Infinity,
  );
  const maxOutputTokens = Math.min(
    settings.maxOutputTokens,
    model?.maxOutputTokens || Infinity,
    Math.max(256, Math.floor((contextWindow - 2048) / 2)),
  );
  return {
    ...settings,
    contextWindow,
    maxOutputTokens,
    maxImages: Math.min(
      settings.maxImages,
      model?.workingMaxImages ?? settings.maxImages,
    ),
    vision: settings.vision && model?.supportsVision !== false,
  };
}

export class ModelCatalogue {
  private cache = new Map<string, { at: number; models: ModelInfo[] }>();
  private profiles: Record<
    string,
    {
      workingInputBudget?: number;
      workingMaxImages?: number;
      updatedAt: string;
    }
  > = {};
  private profileFile?: string;
  constructor(dir?: string) {
    if (dir) {
      this.profileFile = path.join(dir, "model-profiles.json");
      try {
        this.profiles = JSON.parse(fs.readFileSync(this.profileFile, "utf8"));
      } catch {
        /* No learned limits yet. */
      }
    }
  }
  private key(settings: Settings, key: string) {
    return createHash("sha256")
      .update(`${settings.baseUrl}\0${key}`)
      .digest("hex");
  }
  private decorate(
    model: ModelInfo,
    settings: Settings,
    key: string,
  ): ModelInfo {
    return {
      ...model,
      ...this.profiles[`${this.key(settings, key)}:${model.id}`],
    };
  }
  peek(settings: Settings, key: string): ModelInfo | null {
    const m = this.cache
      .get(this.key(settings, key))
      ?.models.find((m) => m.id === settings.model);
    return m ? this.decorate(m, settings, key) : null;
  }
  async list(
    settings: Settings,
    key: string,
    refresh = false,
    signal?: AbortSignal,
  ): Promise<ModelInfo[]> {
    const cacheKey = this.key(settings, key),
      cached = this.cache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.at < 60000)
      return cached.models.map((m) => this.decorate(m, settings, key));
    const url = completionUrl(settings.baseUrl).replace(
      /\/chat\/completions$/,
      "/models",
    );
    const response = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.any([
        AbortSignal.timeout(15000),
        ...(signal ? [signal] : []),
      ]),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Model catalogue returned HTTP ${response.status}.`);
    const data = JSON.parse(await readBounded(response, 8_000_000));
    const entries = Array.isArray(data) ? data : data.data || data.models;
    if (!Array.isArray(entries))
      throw new Error("The endpoint did not return a model catalogue.");
    const models = entries
      .filter((m) => m && typeof m.id === "string")
      .map((m) => normalizeModel(m, url));
    this.cache.set(cacheKey, { at: Date.now(), models });
    return models.map((m) => this.decorate(m, settings, key));
  }
  async resolve(
    settings: Settings,
    key: string,
    signal?: AbortSignal,
  ): Promise<ModelInfo | null> {
    return (
      (await this.list(settings, key, false, signal)).find(
        (m) => m.id === settings.model,
      ) || null
    );
  }
  learn(
    settings: Settings,
    key: string,
    workingInputBudget?: number,
    workingMaxImages?: number,
  ) {
    const id = `${this.key(settings, key)}:${settings.model}`;
    const old = this.profiles[id]?.workingInputBudget;
    this.profiles[id] = {
      ...this.profiles[id],
      ...(workingInputBudget != null && Number.isFinite(workingInputBudget)
        ? {
            workingInputBudget: Math.floor(
              Math.min(old || Infinity, workingInputBudget),
            ),
          }
        : {}),
      ...(workingMaxImages != null
        ? {
            workingMaxImages: Math.min(
              this.profiles[id]?.workingMaxImages ?? Infinity,
              workingMaxImages,
            ),
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    if (this.profileFile)
      fs.writeFileSync(this.profileFile, JSON.stringify(this.profiles), {
        mode: 0o600,
      });
  }
  reset(settings: Settings, key: string) {
    delete this.profiles[`${this.key(settings, key)}:${settings.model}`];
    if (this.profileFile)
      fs.writeFileSync(this.profileFile, JSON.stringify(this.profiles), {
        mode: 0o600,
      });
  }
}
