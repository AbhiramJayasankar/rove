import type { ToolDefinition } from "../shared/types";
import { readBounded } from "./tools";
export { GEMINI_STUDIO_BASE_URL, VERTEX_EXPRESS_BASE_URL } from "../shared/defaults";


const hostOf = (baseUrl: string) => {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
};
export const isVertexExpress = (baseUrl: string) => hostOf(baseUrl) === "aiplatform.googleapis.com";
export const isGeminiStudio = (baseUrl: string) => hostOf(baseUrl) === "generativelanguage.googleapis.com";

/** Thinking levels each model accepts, from Google's thinking guide (reviewed 2026-11-19). */
const THINKING_LEVELS: Record<string, string[]> = {
  "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
  "gemini-4-neon": ["low", "medium", "high", "xhigh"],
  "gemini-4-carbon": ["low", "medium", "high"],
  "gemini-4-argon": ["low", "medium", "high"],
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.6-flash": ["minimal", "low", "medium", "high"],
  "gemini-3.5-flash-lite": ["minimal", "low", "medium", "high"],
  "gemini-3.1-pro-preview": ["low", "medium", "high"],
  "gemini-3.1-flash-lite": ["minimal", "low", "medium", "high"],
  "gemini-3-flash-preview": ["minimal", "low", "medium", "high"],
  "gemini-3-pro-preview": ["low", "high"],
};
export function thinkingLevels(id: string): string[] {
  return THINKING_LEVELS[id] ?? ["low", "medium", "high"];
}
/** Gemini 2.5 models take a token budget instead of a level. */
const usesBudget = (id: string) => /^gemini-2\.5-/.test(id);
const BUDGETS: Record<string, number> = { minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768 };

/** Vertex express mode has no model list, so Rove offers the Gemini models Vertex documents
 * (reviewed 2026-11-19). Text and tool-calling models only. */
const VERTEX_MODELS: [string, string][] = [
  ["gemini-4-hydrogen", "Gemini 4 Hydrogen"],
  ["gemini-4-carbon", "Gemini 4 Carbon"],
  ["gemini-4-argon", "Gemini 4 Argon"],
  ["gemini-3.8-flash", "Gemini 3.8 Flash"],
  ["gemini-3.7-flash", "Gemini 3.7 Flash"],
  ["gemini-3.6-flash", "Gemini 3.6 Flash"],
  ["gemini-3.5-flash", "Gemini 3.5 Flash"],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite"],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro (preview)"],
  ["gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite"],
  ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ["gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"],
];

function catalogueEntry(id: string, name: string, context: number, output: number, thinking: boolean) {
  return {
    id,
    name,
    owned_by: "google",
    context_length: context,
    max_output_tokens: output,
    input_modalities: ["text", "image"],
    supported_parameters: ["tools", "tool_choice", "max_tokens", ...(thinking ? ["reasoning_effort"] : [])],
    ...(thinking ? { reasoning_efforts: thinkingLevels(id) } : {}),
  };
}

/** Raw catalogue entries for Google's endpoints, or null for every other endpoint. */
export async function geminiModelEntries(
  baseUrl: string,
  key: string,
  signal?: AbortSignal,
): Promise<Record<string, any>[] | null> {
  if (isVertexExpress(baseUrl))
    return VERTEX_MODELS.map(([id, name]) => catalogueEntry(id, name, 1048576, 65536, true));
  if (!isGeminiStudio(baseUrl)) return null;
  // The OpenAI-compatible list has only IDs; the native list has token limits and thinking support.
  let response: Response;
  try {
    response = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: key ? { "x-goog-api-key": key } : {},
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Model catalogue request failed: ${key ? message.split(key).join("[REDACTED]") : message}`);
  }
  if (!response.ok) throw new Error(`Model catalogue returned HTTP ${response.status}.${response.status === 400 || response.status === 403 ? " Check the Google AI Studio API key." : ""}`);
  const data = JSON.parse(await readBounded(response, 8_000_000));
  const models: any[] = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((model) => typeof model?.name === "string" && /^models\/gemini/.test(model.name) && model.supportedGenerationMethods?.includes("generateContent"))
    .filter((model) => !/(?:-tts|-image|embedding|-live|robotics)/.test(model.name))
    .map((model) => {
      const id = model.name.replace(/^models\//, "");
      return catalogueEntry(id, model.displayName || id, Number(model.inputTokenLimit) || 1048576, Number(model.outputTokenLimit) || 65536, model.thinking !== false);
    });
}

// --- Vertex AI express mode: Gemini's own request format -----------------------------------------

/** Accepted in place of a thought signature on a function call Rove did not receive from Gemini
 * (for example a call made by another provider earlier in the chat). */
const SKIP_SIGNATURE = "skip_thought_signature_validator";

const parseJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

function userParts(content: any): any[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: any): any[] => {
    if (part?.type === "text" && typeof part.text === "string") return [{ text: part.text }];
    const url = part?.type === "image_url" ? String(part.image_url?.url ?? "") : "";
    const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (data) return [{ inlineData: { mimeType: data[1], data: data[2] } }];
    return url ? [{ text: `[image: ${url}]` }] : [];
  });
}

/** Chat Completions messages to Gemini contents. Consecutive turns of one role are merged. */
export function toGeminiRequest(messages: any[], tools: ToolDefinition[]) {
  const system: string[] = [];
  const contents: { role: "user" | "model"; parts: any[] }[] = [];
  const names = new Map<string, string>();
  const push = (role: "user" | "model", parts: any[]) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content === "string") system.push(message.content);
      else system.push(...userParts(message.content).map((part) => part.text).filter(Boolean));
    } else if (message.role === "assistant") {
      const parts: any[] = [];
      if (typeof message.content === "string" && message.content) parts.push({ text: message.content });
      (message.tool_calls ?? []).forEach((call: any, index: number) => {
        names.set(call.id, call.function?.name);
        const signature = call.extra_content?.google?.thought_signature;
        parts.push({
          functionCall: { name: call.function?.name, args: parseJson(call.function?.arguments || "{}") ?? {} },
          // Gemini checks the signature on the first call of each turn.
          ...(signature ? { thoughtSignature: signature } : index === 0 ? { thoughtSignature: SKIP_SIGNATURE } : {}),
        });
      });
      push("model", parts);
    } else if (message.role === "tool") {
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      const parsed = parseJson(text);
      push("user", [{
        functionResponse: {
          name: names.get(message.tool_call_id) || "tool",
          response: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed ?? text },
        },
      }]);
    } else push("user", userParts(message.content));
  }
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } } : {}),
    ...(tools.length
      ? {
          tools: [{ functionDeclarations: tools.map(({ name, description, parameters }) => ({ name, description, parametersJsonSchema: parameters })) }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        }
      : {}),
  };
}

/** Rove's request options (max_tokens, reasoning_effort) in Gemini's generationConfig. */
export function geminiGenerationConfig(model: string, options: Record<string, unknown>) {
  const config: Record<string, unknown> = {};
  const max = Number(options.max_tokens ?? options.max_completion_tokens);
  if (Number.isFinite(max) && max > 0) config.maxOutputTokens = max;
  const effort = typeof options.reasoning_effort === "string" ? options.reasoning_effort : undefined;
  if (effort && effort !== "default")
    config.thinkingConfig = usesBudget(model)
      ? { thinkingBudget: effort === "none" ? 0 : BUDGETS[effort] ?? 8192 }
      : { thinkingLevel: effort };
  return config;
}

/** Fold one streamed (or whole) generateContent response into the assistant message being built. */
export class GeminiAnswer {
  text = "";
  thoughts = "";
  calls: any[] = [];
  usage: any;
  id?: string;
  finish?: string;
  blocked?: string;
  add(chunk: any, onDelta?: (delta: { content?: string; reasoning?: string }) => void) {
    if (chunk?.error) throw Object.assign(new Error(chunk.error.message || "Gemini request failed."), { gemini: chunk });
    this.id = chunk?.responseId || this.id;
    if (chunk?.usageMetadata) {
      const u = chunk.usageMetadata;
      const completion = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0);
      this.usage = { prompt_tokens: Number(u.promptTokenCount) || 0, completion_tokens: completion, total_tokens: Number(u.totalTokenCount) || 0 };
    }
    if (chunk?.promptFeedback?.blockReason) this.blocked = chunk.promptFeedback.blockReason;
    const candidate = chunk?.candidates?.[0];
    if (candidate?.finishReason) this.finish = candidate.finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) {
        this.calls.push({
          id: part.functionCall.id || `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
          type: "function",
          function: { name: String(part.functionCall.name ?? ""), arguments: JSON.stringify(part.functionCall.args ?? {}) },
          ...(part.thoughtSignature ? { extra_content: { google: { thought_signature: part.thoughtSignature } } } : {}),
        });
      } else if (typeof part.text === "string" && part.text) {
        if (part.thought) {
          this.thoughts += part.text;
          onDelta?.({ reasoning: part.text });
        } else {
          this.text += part.text;
          onDelta?.({ content: part.text });
        }
      }
    }
  }
  message() {
    if (this.finish === "MAX_TOKENS" && !this.calls.length)
      throw new Error("The model reached its available output limit. Try a shorter task or another model.");
    if (!this.text && !this.calls.length) {
      const reason = this.blocked || (this.finish && this.finish !== "STOP" ? this.finish : "");
      throw new Error(reason ? `Gemini returned no answer (${reason}).` : "Model response contains no assistant message or tool calls.");
    }
    return {
      role: "assistant",
      content: this.text || null,
      ...(this.calls.length ? { tool_calls: this.calls } : {}),
      ...(this.thoughts ? { reasoning_content: this.thoughts } : {}),
    };
  }
}

export function vertexStreamUrl(baseUrl: string, model: string): string {
  const url = new URL(baseUrl.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Use the Vertex AI base URL without credentials or query parameters.");
  const id = model.replace(/^(?:models|publishers\/google\/models)\//, "");
  if (!/^[a-z0-9][a-z0-9.\-_]*$/i.test(id)) throw new Error("This model ID cannot be sent to Vertex AI.");
  url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/models$/, "")}/models/${id}:streamGenerateContent`;
  url.search = "?alt=sse";
  return url.href;
}
