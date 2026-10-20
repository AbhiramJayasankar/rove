import type { Settings, ToolDefinition } from "../shared/types";
import { readBounded } from "./tools";

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

export async function complete(
  settings: Settings,
  apiKey: string,
  messages: any[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): Promise<{ message: any; usage?: any }> {
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
        stream: false,
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      redirect: "error",
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw new Error(
      redact(
        `Model request failed: ${error instanceof Error ? error.message : String(error)}. Check the endpoint and local model server.`,
        apiKey,
      ),
    );
  }
  const raw = await readBounded(response);
  if (!response.ok)
    throw new Error(
      redact(
        `Model endpoint returned HTTP ${response.status}: ${raw.slice(0, 3000)}`,
        apiKey,
      ),
    );
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      "Model endpoint returned invalid JSON. Use an OpenAI-compatible Chat Completions endpoint.",
    );
  }
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
      ...(message.refusal != null ? { refusal: message.refusal } : {}),
    },
    ...(data.usage ? { usage: data.usage } : {}),
  };
}

export async function testModel(
  settings: Settings,
  apiKey: string,
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
