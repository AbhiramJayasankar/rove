import type { ModelInfo, RunEvent } from "./types";
const number = (value: unknown): number | undefined =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0
    ? Number(value)
    : undefined;
function requestCost(usage: any, model?: ModelInfo | null): number | undefined {
  const reported = number(usage?.cost);
  if (reported != null) return reported;
  if (model?.free) return 0;
  const pricing = model?.pricing;
  if (!pricing) return;
  const input = number(usage?.prompt_tokens ?? usage?.input_tokens),
    output = number(usage?.completion_tokens ?? usage?.output_tokens);
  if (input == null || output == null) return;
  const prompt =
    number(pricing.prompt) ??
    (number(pricing.input_usd_per_1m) != null
      ? Number(pricing.input_usd_per_1m) / 1_000_000
      : undefined);
  const completion =
    number(pricing.completion) ??
    (number(pricing.output_usd_per_1m) != null
      ? Number(pricing.output_usd_per_1m) / 1_000_000
      : undefined);
  if (prompt == null || completion == null) return;
  const cached = Math.min(
    input,
    number(
      usage.prompt_tokens_details?.cached_tokens ??
        usage.input_tokens_details?.cached_tokens,
    ) || 0,
  );
  const cacheRate =
    number(pricing.input_cache_read) ??
    number(pricing.cached_prompt) ??
    (number(pricing.cached_input_usd_per_1m) != null
      ? Number(pricing.cached_input_usd_per_1m) / 1_000_000
      : prompt);
  const writes = Math.min(
    input - cached,
    number(usage.prompt_tokens_details?.cache_write_tokens) || 0,
  );
  const writeRate = number(pricing.input_cache_write) ?? prompt;
  return (
    (input - cached - writes) * prompt +
    cached * cacheRate +
    writes * writeRate +
    output * completion
  );
}
export function chatUsage(events: RunEvent[], fallback?: ModelInfo | null) {
  let model = fallback,
    input = 0,
    output = 0,
    cached = 0,
    reasoning = 0,
    cost = 0,
    responses = 0,
    inputReports = 0,
    outputReports = 0,
    costReports = 0;
  for (const event of events) {
    if (event.type === "model_metadata") model = event.data.model || null;
    if (event.type !== "model_response") continue;
    responses++;
    const usage = event.data.usage;
    const inTokens = number(usage?.prompt_tokens ?? usage?.input_tokens),
      outTokens = number(usage?.completion_tokens ?? usage?.output_tokens);
    if (inTokens != null) {
      input += inTokens;
      inputReports++;
    }
    if (outTokens != null) {
      output += outTokens;
      outputReports++;
    }
    cached +=
      number(
        usage?.prompt_tokens_details?.cached_tokens ??
          usage?.input_tokens_details?.cached_tokens,
      ) || 0;
    reasoning +=
      number(
        usage?.completion_tokens_details?.reasoning_tokens ??
          usage?.output_tokens_details?.reasoning_tokens,
      ) || 0;
    const estimate = requestCost(usage, model);
    if (estimate != null) {
      cost += estimate;
      costReports++;
    }
  }
  const context = events.findLast(
    (event) => event.type === "context_usage",
  )?.data;
  const lastResponse = events.findLast(
    (event) => event.type === "model_response",
  );
  const current =
    lastResponse &&
    (!context ||
      lastResponse.id >
        events.findLast((event) => event.type === "context_usage")!.id)
      ? number(
          lastResponse.data.usage?.prompt_tokens ??
            lastResponse.data.usage?.input_tokens,
        )
      : undefined;
  const used = current ?? number(context?.estimatedTokens) ?? 0;
  const requests = Math.max(
    responses,
    events.filter((event) => event.type === "model_request").length,
  );
  return {
    input,
    output,
    cached,
    reasoning,
    cost: costReports === requests ? cost : undefined,
    requests,
    responses,
    inputReports,
    outputReports,
    current: used,
    estimated: current == null,
    contextWindow:
      number(context?.contextWindow) ??
      model?.contextWindow ??
      fallback?.contextWindow ??
      32768,
    inputBudget: number(context?.inputBudget),
    outputBudget: number(context?.reservedOutputTokens),
  };
}
