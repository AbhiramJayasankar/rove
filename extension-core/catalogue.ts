import type { ModelInfo, ModelOverride, Settings } from "../shared/types";
import { completionUrl } from "./model";
import { readBounded } from "./tools";
import { documentedCapabilities } from "./provider-capabilities";
import { resolvedReasoningEffort } from "../shared/capabilities";

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
  const documented = documentedCapabilities(raw.id, source);
  // OpenRouter publishes a nested object: { mandatory, supported_efforts, default_effort, default_enabled }.
  const nested =
    raw.reasoning && typeof raw.reasoning === "object" && !Array.isArray(raw.reasoning)
      ? (raw.reasoning as Record<string, any>)
      : undefined;
  const nestedEfforts = strings(nested?.supported_efforts)?.filter(Boolean);
  const efforts = (nestedEfforts?.length ? nestedEfforts : undefined) ?? strings(
    raw.reasoning_efforts ??
      raw.supported_reasoning_efforts ??
      raw.effort?.supported_levels ??
      raw.capabilities?.reasoning?.efforts ??
      raw.capabilities?.reasoning?.levels ??
      raw.parameters?.reasoning_effort?.enum ??
      raw.parameters?.reasoning?.properties?.effort?.enum,
  );
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
  const reasoningFormat = nested
    ? "reasoning"
    : parameters?.includes("reasoning") &&
    !parameters?.includes("reasoning_effort")
      ? "reasoning"
      : parameters?.includes("reasoning_effort") || efforts
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
    ...documented,
    id: raw.id,
    name: raw.label || raw.name || raw.id,
    owner: raw.owned_by || raw.provider,
    contextWindow:
      positive(
        raw.context_length,
        raw.context_window,
        // llama.cpp reports the loaded context as meta.n_ctx.
        raw.meta?.n_ctx,
        raw.max_model_len,
        raw.top_provider?.context_length,
        raw.limits?.context_length,
      ) ?? documented.contextWindow,
    maxInputTokens: positive(
      raw.max_input_tokens,
      raw.limits?.max_input_tokens,
    ),
    maxOutputTokens:
      positive(
        raw.max_output_tokens,
        raw.max_completion_tokens,
        raw.top_provider?.max_completion_tokens,
        raw.limits?.max_output_tokens,
      ) ?? documented.maxOutputTokens,
    supportsTools: boolean(
      raw.tool_call,
      raw.function_call,
      raw.supports_tools,
      raw.capabilities?.tools,
      parameters
        ? parameters.includes("tools") || parameters.includes("tool_choice")
        : undefined,
    ),
    supportsVision:
      boolean(
        raw.supports_vision,
        raw.capabilities?.vision,
        input ? input.includes("image") : undefined,
      ) ?? documented.supportsVision,
    inputModalities: input,
    outputModalities: output,
    supportedParameters: parameters,
    reasoningFormat: reasoningFormat ?? documented.reasoningFormat,
    reasoningEfforts: efforts ?? documented.reasoningEfforts,
    reasoningToggle:
      boolean(
        raw.capabilities?.reasoning?.toggle,
        // A reasoning object with no effort tiers that can be switched off is a plain on/off control.
        nested && !nestedEfforts?.length && nested.mandatory === false ? true : undefined,
        parameters?.some((p) => p === "thinking" || p === "thinking.type")
          ? true
          : undefined,
      ) ?? documented.reasoningToggle,
    outputTokenParameter: parameters?.includes("max_completion_tokens")
      ? "max_completion_tokens"
      : parameters?.includes("max_tokens")
        ? "max_tokens"
        : documented.outputTokenParameter,
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
  const contextWindow = model?.contextWindow || 32768;
  const maxOutputTokens = Math.min(
    model?.maxOutputTokens || 16384,
    Math.max(256, contextWindow - 2048),
  );
  return {
    ...settings,
    contextMode: "auto",
    reasoningFormat: "auto",
    reasoningEffort: resolvedReasoningEffort(settings, model),
    stream: true,
    contextWindow,
    maxOutputTokens,
    maxImages: Math.min(
      settings.maxImages,
      model?.workingMaxImages ?? settings.maxImages,
    ),
    vision: model?.supportsVision !== false,
  };
}

export interface CatalogueStorage {
  get(key: string | string[]): Promise<Record<string, any>>;
  set(items: Record<string, unknown>): Promise<void>;
}
type Profile = {
  workingInputBudget?: number;
  workingMaxImages?: number;
  updatedAt: string;
};

/** llama.cpp tells /v1/models nothing about images or thinking, but /props does. */
export async function probeLlamaServer(
  modelsUrl: string,
  key: string,
  signal?: AbortSignal,
): Promise<Partial<ModelInfo> | null> {
  try {
    const response = await fetch(modelsUrl.replace(/\/(?:v1\/)?models$/, "/props"), {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.any([AbortSignal.timeout(4000), ...(signal ? [signal] : [])]),
      redirect: "error",
    });
    if (!response.ok) return null;
    const props = JSON.parse(await readBounded(response, 2_000_000));
    if (!props || typeof props !== "object" || !props.build_info) return null;
    const template = String(props.chat_template || "");
    const thinks = /enable_thinking|reasoning_effort|<think>|thinking/i.test(template);
    return {
      supportsVision: props.modalities?.vision === true,
      // llama.cpp reads reasoning_effort for every template; "none" turns thinking off.
      ...(thinks
        ? { reasoningFormat: "reasoning_effort" as const, reasoningEfforts: ["none", "high"], capabilitySources: [modelsUrl.replace(/\/(?:v1\/)?models$/, "/props")] }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Browser-only catalogue. Initialize once; flush queued learned limits before teardown. */
export class ModelCatalogue {
  private cache = new Map<string, { at: number; endpoint: string; models: ModelInfo[] }>();
  private profiles: Record<string, Profile> = {};
  private overrides: Record<string, ModelOverride> = {};
  private initialization?: Promise<void>;
  private pendingWrite: Promise<void> = Promise.resolve();
  private credential?: { endpoint: string; key: string; hash: string };
  private identitySequence = 0;
  private storage?: CatalogueStorage;
  constructor(
    storage?: CatalogueStorage,
    private readonly storageKey = "relay.modelProfiles.v1",
    private readonly overrideKey = "rove.modelOverrides.v1",
  ) {
    this.storage = storage ?? (globalThis as any).chrome?.storage?.local;
  }
  init(): Promise<void> {
    return (this.initialization ??= (async () => {
      if (!this.storage) return;
      const saved = await this.storage.get([this.storageKey, this.overrideKey]);
      const overrides = saved[this.overrideKey];
      if (overrides && typeof overrides === "object" && !Array.isArray(overrides))
        this.overrides = overrides as Record<string, ModelOverride>;
      const stored = saved[this.storageKey];
      if (!stored || typeof stored !== "object" || Array.isArray(stored))
        return;
      for (const [id, value] of Object.entries(stored)) {
        if (!value || typeof value !== "object") continue;
        const profile = value as Profile;
        this.profiles[id] = {
          ...(Number.isFinite(profile.workingInputBudget) &&
          profile.workingInputBudget! > 0
            ? { workingInputBudget: Math.floor(profile.workingInputBudget!) }
            : {}),
          ...(Number.isFinite(profile.workingMaxImages) &&
          profile.workingMaxImages! >= 0
            ? { workingMaxImages: Math.floor(profile.workingMaxImages!) }
            : {}),
          updatedAt:
            typeof profile.updatedAt === "string"
              ? profile.updatedAt
              : new Date().toISOString(),
        };
      }
    })());
  }
  private async key(settings: Settings, key: string): Promise<string> {
    if (
      this.credential?.endpoint === settings.baseUrl &&
      this.credential.key === key
    )
      return this.credential.hash;
    const sequence = ++this.identitySequence;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${settings.baseUrl}\0${key}`),
    );
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (sequence === this.identitySequence)
      this.credential = { endpoint: settings.baseUrl, key, hash };
    return hash;
  }
  private overrideId(endpoint: string, model: string): string {
    return `${endpoint.replace(/\/+$/, "")}\0${model}`;
  }
  private decorate(model: ModelInfo, cacheKey: string, endpoint: string): ModelInfo {
    const decorated: ModelInfo = { ...model, ...this.profiles[`${cacheKey}:${model.id}`] };
    const override = this.overrides[this.overrideId(endpoint, model.id)];
    if (!override) return decorated;
    return {
      ...decorated,
      override,
      endpointVision: decorated.supportsVision,
      ...(override.images ? { supportsVision: override.images === "on" } : {}),
      ...(override.reasoning?.length ? { customReasoning: override.reasoning } : {}),
    };
  }
  /** Save, or with null clear, the user's choices for one model on one endpoint. */
  async setOverride(endpoint: string, model: string, override: ModelOverride | null): Promise<void> {
    await this.init();
    const id = this.overrideId(endpoint, model);
    if (override && (override.images || override.reasoning?.length)) this.overrides[id] = override;
    else delete this.overrides[id];
    if (this.storage) await this.storage.set({ [this.overrideKey]: structuredClone(this.overrides) });
  }
  /** Synchronous after list/resolve has registered this endpoint+credential identity. */
  peek(settings: Settings, key: string): ModelInfo | null {
    const credential = this.credential;
    if (
      !credential ||
      credential.endpoint !== settings.baseUrl ||
      credential.key !== key
    )
      return null;
    const model = this.cache
      .get(credential.hash)
      ?.models.find((model) => model.id === settings.model);
    return model ? this.decorate(model, credential.hash, settings.baseUrl) : null;
  }
  async list(
    settings: Settings,
    key: string,
    refresh = false,
    signal?: AbortSignal,
  ): Promise<ModelInfo[]> {
    await this.init();
    signal?.throwIfAborted();
    const cacheKey = await this.key(settings, key);
    const cached = this.cache.get(cacheKey);
    if (!refresh && cached && Date.now() - cached.at < 60000)
      return cached.models.map((model) => this.decorate(model, cacheKey, settings.baseUrl));
    const url = completionUrl(settings.baseUrl).replace(
      /\/chat\/completions$/,
      "/models",
    );
    let response: Response;
    try {
      response = await fetch(url, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(signal ? [signal] : []),
        ]),
        redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Model catalogue request failed: ${key ? message.split(key).join("[REDACTED]") : message}`,
      );
    }
    if (!response.ok)
      throw new Error(`Model catalogue returned HTTP ${response.status}.`);
    const data = JSON.parse(await readBounded(response, 8_000_000));
    const entries = Array.isArray(data) ? data : data.data || data.models;
    if (!Array.isArray(entries))
      throw new Error("The endpoint did not return a model catalogue.");
    const valid = entries.filter((entry: any) => entry && typeof entry.id === "string");
    let models = valid.map((entry: any) => normalizeModel(entry, url));
    // A llama.cpp server describes its loaded model in /props; fill only what /v1/models left unsaid.
    if (valid.some((entry: any) => entry.owned_by === "llamacpp")) {
      const props = await probeLlamaServer(url, key, signal);
      if (props)
        models = models.map((model, index) =>
          valid[index].owned_by === "llamacpp"
            ? { ...model, ...Object.fromEntries(Object.entries(props).filter(([field]) => (model as any)[field] === undefined)) }
            : model,
        );
    }
    this.cache.set(cacheKey, { at: Date.now(), endpoint: settings.baseUrl, models });
    return models.map((model) => this.decorate(model, cacheKey, settings.baseUrl));
  }
  async resolve(
    settings: Settings,
    key: string,
    signal?: AbortSignal,
  ): Promise<ModelInfo | null> {
    return (
      (await this.list(settings, key, false, signal)).find(
        (model) => model.id === settings.model,
      ) || null
    );
  }
  private queueProfile(
    settings: Settings,
    key: string,
    update: (id: string) => void,
  ): void {
    const snapshot = { ...settings };
    this.pendingWrite = this.pendingWrite
      .catch(() => {})
      .then(async () => {
        await this.init();
        const id = `${await this.key(snapshot, key)}:${snapshot.model}`;
        update(id);
        if (this.storage)
          await this.storage.set({
            [this.storageKey]: structuredClone(this.profiles),
          });
      });
    // The caller observes storage failures through flush(), without an unhandled
    // rejection if the worker is between commands when persistence completes.
    void this.pendingWrite.catch(() => {});
  }
  learn(
    settings: Settings,
    key: string,
    workingInputBudget?: number,
    workingMaxImages?: number,
  ): void {
    this.queueProfile(settings, key, (id) => {
      const old = this.profiles[id];
      this.profiles[id] = {
        ...old,
        ...(workingInputBudget != null &&
        Number.isFinite(workingInputBudget) &&
        workingInputBudget > 0
          ? {
              workingInputBudget: Math.floor(
                Math.min(
                  old?.workingInputBudget ?? Infinity,
                  workingInputBudget,
                ),
              ),
            }
          : {}),
        ...(workingMaxImages != null &&
        Number.isFinite(workingMaxImages) &&
        workingMaxImages >= 0
          ? {
              workingMaxImages: Math.floor(
                Math.min(old?.workingMaxImages ?? Infinity, workingMaxImages),
              ),
            }
          : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  }
  reset(settings: Settings, key: string): void {
    this.queueProfile(settings, key, (id) => {
      delete this.profiles[id];
    });
  }
  async flush(): Promise<void> {
    await this.init();
    await this.pendingWrite;
  }
}
