import type { ModelInfo, Settings, ToolDefinition } from "../shared/types";
import { readBounded } from "./tools";
import { resolvedReasoningEffort } from "../shared/capabilities";

export function completionUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "Use an HTTP(S) model endpoint without credentials in its URL.",
    );
  if (url.search || url.hash)
    throw new Error(
      "The model endpoint must not contain query parameters or a fragment.",
    );
  url.pathname = /\/chat\/completions\/?$/.test(url.pathname)
    ? url.pathname.replace(/\/$/, "")
    : `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url.href;
}
function redact(value: string, key: string): string {
  return key ? value.split(key).join("[REDACTED]") : value;
}

export class ModelEndpointError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: any,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ModelEndpointError";
  }
  get contextExceeded() {
    return this.status === 400 || this.status === 413
      ? /context[_ -]length|context[_ -]window|too[_ -]many[_ -]tokens|max(?:imum)?[_ -]context|prompt[_ -]too[_ -]long/i.test(
          `${this.code || ""} ${this.message}`,
        )
      : false;
  }
  get contextLimit(): number | undefined {
    const fields = [
      this.details?.max_context_length,
      this.details?.context_window,
      this.details?.context_length,
      this.details?.error?.max_context_length,
      this.details?.error?.context_window,
      this.details?.error?.context_length,
    ];
    const explicit = fields
      .map(Number)
      .find((n) => Number.isFinite(n) && n > 0);
    const match = this.message.match(
      /(?:maximum context length (?:is|of)|context (?:window|limit)(?: is|:| of)?)\s*([\d,]+)\s*tokens/i,
    );
    return (
      explicit || (match ? Number(match[1].replaceAll(",", "")) : undefined)
    );
  }
}

export function generationOptions(
  settings: Settings,
  model?: ModelInfo | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    [model?.outputTokenParameter || "max_tokens"]: settings.maxOutputTokens,
  };
  const selectedEffort =
    settings.reasoningEffort === "default"
      ? resolvedReasoningEffort(settings, model)
      : settings.reasoningEffort;
  const effort = model?.reasoningAliases?.[selectedEffort] || selectedEffort;
  if (effort !== "default") {
    const format = model?.reasoningFormat;
    if (!format)
      throw new Error(
        "The endpoint does not advertise a reasoning control for this model. Select the model again to restore automatic controls.",
      );
    if (format === "thinking")
      result.thinking = { type: effort === "none" ? "disabled" : "enabled" };
    else if (format === "enable_thinking")
      result.enable_thinking = effort !== "none";
    else if (format === "reasoning")
      result.reasoning =
        model?.reasoningToggle && !model.reasoningEfforts?.length
          ? { enabled: effort !== "none" }
          : { effort };
    else {
      if (model?.reasoningToggle)
        result.thinking = { type: effort === "none" ? "disabled" : "enabled" };
      if (!(model?.reasoningToggle && effort === "none"))
        result.reasoning_effort = effort;
    }
  }
  return result;
}

export type ModelDelta = { content?: string; reasoning?: string };

async function streamedCompletion(
  response: Response,
  onDelta?: (delta: ModelDelta) => void,
): Promise<any> {
  if (!response.body) throw new Error("The model returned an empty stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    bytes = 0,
    finished = false;
  const message: any = { role: "assistant", content: "" };
  const calls = new Map<number, any>();
  let usage: any, id: string | undefined;
  const consume = (block: string) => {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload) return;
    if (payload.trim() === "[DONE]") {
      finished = true;
      return;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new Error("The model returned malformed streaming JSON.");
    }
    if (chunk.error)
      throw new ModelEndpointError(
        chunk.error.message || "Model stream failed.",
        Number(chunk.error.status) || 400,
        chunk.error.code || chunk.error.type,
        chunk,
      );
    id = chunk.id || id;
    usage = chunk.usage || usage;
    const choice =
      chunk.choices?.find((c: any) => c.index === 0) || chunk.choices?.[0];
    if (choice?.finish_reason === "length")
      throw new Error(
        "The model reached its advertised output limit. Try a shorter task or another model.",
      );
    if (choice?.finish_reason) finished = true;
    const delta = choice?.delta;
    if (!delta) return;
    for (const key of [
      "content",
      "reasoning_content",
      "reasoning",
      "refusal",
    ]) {
      if (typeof delta[key] !== "string") continue;
      message[key] = (message[key] || "") + delta[key];
    }
    if (Array.isArray(delta.reasoning_details))
      message.reasoning_details = [
        ...(message.reasoning_details || []),
        ...delta.reasoning_details,
      ];
    for (const call of delta.tool_calls || []) {
      const index = call.index ?? 0;
      const current = calls.get(index) || {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (call.id) current.id += call.id;
      if (call.function?.name) current.function.name += call.function.name;
      if (call.function?.arguments)
        current.function.arguments += call.function.arguments;
      calls.set(index, current);
    }
    onDelta?.({
      content: delta.content,
      reasoning: delta.reasoning_content ?? delta.reasoning,
    });
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16_000_000) throw new Error("Model response exceeds 16 MB.");
      buffer += decoder.decode(value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, separator.index));
        buffer = buffer.slice(separator.index + separator[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!finished)
      throw new Error(
        "Model stream ended before completion. No partial tool calls were executed.",
      );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (calls.size)
    message.tool_calls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call);
  return { id, choices: [{ message }], usage };
}

export async function complete(
  settings: Settings,
  apiKey: string,
  messages: any[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  onDelta?: (delta: ModelDelta) => void,
  model?: ModelInfo | null,
): Promise<{ message: any; usage?: any; requestId?: string }> {
  if (!settings.model.trim())
    throw new Error("Choose a model in Settings before starting a run.");
  const endpoint = completionUrl(settings.baseUrl);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        stream: settings.stream,
        ...generationOptions(settings, model),
        ...(settings.stream &&
        (!model?.supportedParameters ||
          model.supportedParameters.includes("stream_options"))
          ? { stream_options: { include_usage: true } }
          : {}),
        ...(tools.length
          ? {
              tools: tools.map(({ name, description, parameters }) => ({
                type: "function",
                function: { name, description, parameters },
              })),
              tool_choice: "auto",
            }
          : {}),
      }),
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(settings.modelTimeoutSeconds * 1000),
      ]),
      redirect: "error",
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ModelEndpointError)
      throw new ModelEndpointError(
        redact(error.message, apiKey),
        error.status,
        error.code,
        JSON.parse(redact(JSON.stringify(error.details || {}), apiKey)),
        error.requestId,
      );
    throw new Error(
      redact(
        `Model request failed: ${error instanceof Error ? error.message : String(error)}. Check the endpoint and local model server.`,
        apiKey,
      ),
    );
  }
  if (!response.ok) {
    const raw = await readBounded(response);
    let details: any;
    try {
      details = JSON.parse(redact(raw, apiKey));
    } catch {
      /* Keep the bounded text error. */
    }
    throw new ModelEndpointError(
      redact(
        `Model endpoint returned HTTP ${response.status}: ${raw.slice(0, 3000)}`,
        apiKey,
      ),
      response.status,
      details?.error?.code || details?.error?.type || details?.code,
      details,
      response.headers.get("x-request-id") || undefined,
    );
  }
  let data: any;
  try {
    data = response.headers.get("content-type")?.includes("text/event-stream")
      ? await streamedCompletion(response, onDelta)
      : JSON.parse(await readBounded(response, 16_000_000));
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof ModelEndpointError)
      throw new ModelEndpointError(
        redact(error.message, apiKey),
        error.status,
        error.code,
        JSON.parse(redact(JSON.stringify(error.details || {}), apiKey)),
        error.requestId,
      );
    if (!(error instanceof SyntaxError))
      throw new Error(
        redact(error instanceof Error ? error.message : String(error), apiKey),
      );
    throw new Error(
      "Model endpoint returned invalid JSON. Use an OpenAI-compatible Chat Completions endpoint.",
    );
  }
  if (data.choices?.[0]?.finish_reason === "length")
    throw new Error(
      "The model reached its available output limit. Try a shorter task or another model.",
    );
  const message = data?.choices?.[0]?.message;
  if (
    !message ||
    typeof message !== "object" ||
    (message.content == null && !message.tool_calls?.length && !message.refusal)
  )
    throw new Error(
      "Model response contains no assistant message or tool calls.",
    );
  if (
    message.tool_calls &&
    (!Array.isArray(message.tool_calls) ||
      message.tool_calls.length > 32 ||
      message.tool_calls.some(
        (t: any) =>
          typeof t.id !== "string" ||
          t.type !== "function" ||
          typeof t.function?.name !== "string" ||
          typeof t.function.arguments !== "string",
      ))
  )
    throw new Error("Model returned malformed function tool calls.");
  return {
    message: {
      role: "assistant",
      content: message.content ?? message.refusal ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      // Thinking providers may require this exact reasoning to accompany the
      // assistant tool-call message on subsequent requests.
      ...(message.reasoning_content != null
        ? { reasoning_content: message.reasoning_content }
        : {}),
      ...(message.reasoning != null ? { reasoning: message.reasoning } : {}),
      ...(message.reasoning_details != null
        ? { reasoning_details: message.reasoning_details }
        : {}),
      ...(message.refusal != null ? { refusal: message.refusal } : {}),
    },
    ...(data.usage ? { usage: data.usage } : {}),
    requestId: response.headers.get("x-request-id") || data.id,
  };
}

export async function testModel(
  settings: Settings,
  apiKey: string,
  model?: ModelInfo | null,
): Promise<string> {
  const tools: ToolDefinition[] = [
    {
      name: "relay_connection_check",
      description:
        "Harmless local capability test. Call with status ok to verify function calling.",
      parameters: {
        type: "object",
        properties: { status: { type: "string", enum: ["ok"] } },
        required: ["status"],
        additionalProperties: false,
      },
      risk: "read",
    },
  ];
  const messages = [
    {
      role: "user",
      content:
        'Verify tool calling by calling relay_connection_check with status "ok". This is a harmless connection test. Do not answer with text.',
    },
  ];
  const { message } = await complete(
    settings,
    apiKey,
    messages,
    tools,
    AbortSignal.timeout(30000),
    undefined,
    model,
  );
  const check = message.tool_calls?.find(
    (t: any) => t.function.name === "relay_connection_check",
  );
  let args: any;
  try {
    args = check ? JSON.parse(check.function.arguments) : null;
  } catch {
    /* Report one actionable connection test error. */
  }
  if (!check || args?.status !== "ok")
    throw new Error(
      "The endpoint connected, but the model did not produce a valid function call. Choose a model with OpenAI-compatible tool calling.",
    );
  return "Connection and tool calling verified.";
}
