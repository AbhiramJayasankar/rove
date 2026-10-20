import type { ModelInfo } from "../shared/types";

/** Documented fallbacks only where /models omits fields. Endpoint metadata always wins.
 * Reviewed 2026-10-20. Keep gateway limits separate from upstream model limits.
 */
export function documentedCapabilities(
  id: string,
  source: string,
): Partial<ModelInfo> {
  let host: string;
  try {
    host = new URL(source).hostname;
  } catch {
    return {};
  }
  if (host === "tokenharbor.ai") {
    const models: Record<
      string,
      { context: number; images: boolean; family: "mimo" | "deepseek" }
    > = {
      "mimo-v2.5:free": { context: 1048576, images: true, family: "mimo" },
      "mimo-v2.6-flash:free": {
        context: 1048576,
        images: true,
        family: "mimo",
      },
      "deepseek-v4-flash:free": {
        context: 1000000,
        images: false,
        family: "deepseek",
      },
      "deepseek-v4.1-flash:free": {
        context: 1048576,
        images: true,
        family: "deepseek",
      },
    };
    const model = models[id];
    if (!model) return {};
    const upstream =
      model.family === "mimo"
        ? "https://mimo.mi.com/docs/en-US/api/chat/openai-api"
        : "https://api-docs.deepseek.com/guides/thinking_mode/";
    return {
      contextWindow: model.context,
      maxOutputTokens: 128000,
      supportsVision: model.images,
      reasoningFormat:
        model.family === "mimo" ? "thinking" : "reasoning_effort",
      ...(model.family === "deepseek"
        ? {
            reasoningEfforts: ["low", "high", "max"],
            reasoningToggle: true,
            reasoningAliases: {
              minimal: "low",
              medium: "high",
              xhigh: "high",
              ultra: "max",
            },
          }
        : {}),
      capabilitySources: [`https://tokenharbor.ai/models/${id}`, upstream],
    };
  }
  // These protocols apply to these official endpoints, not arbitrary models with similar IDs.
  if (host === "api.deepseek.com")
    return {
      reasoningToggle: true,
      reasoningAliases: {
        minimal: "low",
        medium: "high",
        xhigh: "high",
        ultra: "max",
      },
    };
  if (
    host === "api.xiaomimimo.com" &&
    [
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
      "mimo-v2.6-pro-ultraspeed",
      "mimo-v2.5-pro",
      "mimo-v2.5",
    ].includes(id)
  )
    return {
      reasoningFormat: "thinking",
      outputTokenParameter: "max_completion_tokens",
      capabilitySources: ["https://mimo.mi.com/docs/en-US/api/chat/openai-api"],
    };
  return {};
}
