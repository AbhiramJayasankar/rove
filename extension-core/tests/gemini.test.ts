import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, GEMINI_STUDIO_BASE_URL, VERTEX_EXPRESS_BASE_URL } from "../../shared/defaults";
import { complete, ModelEndpointError } from "../model";
import { ModelCatalogue } from "../catalogue";
import { GeminiAnswer, geminiGenerationConfig, toGeminiRequest, vertexStreamUrl } from "../gemini";
import type { Settings, ToolDefinition } from "../../shared/types";

afterEach(() => vi.unstubAllGlobals());
const tool: ToolDefinition = {
  name: "browser_click",
  description: "Click.",
  risk: "write",
  parameters: { type: "object", properties: { ref: { type: "string" } }, additionalProperties: false },
};
const sse = (...chunks: unknown[]) =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const settings = (baseUrl: string, model: string): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), baseUrl, model });

describe("Gemini request format for Vertex AI", () => {
  it("moves the system message out, keeps images, and pairs tool results with their calls", () => {
    const request = toGeminiRequest(
      [
        { role: "system", content: "Be Rove." },
        { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        {
          role: "assistant",
          content: "Clicking.",
          tool_calls: [
            { id: "a", type: "function", function: { name: "browser_click", arguments: '{"ref":"e1"}' }, extra_content: { google: { thought_signature: "sig-1" } } },
            { id: "b", type: "function", function: { name: "browser_snapshot", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "a", content: '{"clicked":true}' },
        { role: "tool", tool_call_id: "b", content: "plain text" },
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } }] },
      ],
      [tool],
    );
    expect(request.systemInstruction).toEqual({ parts: [{ text: "Be Rove." }] });
    expect(request.contents).toEqual([
      { role: "user", parts: [{ text: "Look" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
      {
        role: "model",
        parts: [
          { text: "Clicking." },
          { functionCall: { name: "browser_click", args: { ref: "e1" } }, thoughtSignature: "sig-1" },
          { functionCall: { name: "browser_snapshot", args: {} } },
        ],
      },
      // Tool results and the screenshot after them form one user turn.
      {
        role: "user",
        parts: [
          { functionResponse: { name: "browser_click", response: { clicked: true } } },
          { functionResponse: { name: "browser_snapshot", response: { result: "plain text" } } },
          { inlineData: { mimeType: "image/jpeg", data: "BBBB" } },
        ],
      },
    ]);
    expect(request.tools).toEqual([{ functionDeclarations: [{ name: "browser_click", description: "Click.", parametersJsonSchema: tool.parameters }] }]);
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  });
  it("marks a first call that came without a thought signature so Gemini accepts the history", () => {
    const request = toGeminiRequest([{ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "browser_tabs", arguments: "{}" } }] }], []);
    expect(request.contents[0].parts[0].thoughtSignature).toBe("skip_thought_signature_validator");
  });
  it("maps Rove's output limit and reasoning level to generationConfig", () => {
    expect(geminiGenerationConfig("gemini-3.8-flash", { max_tokens: 4096, reasoning_effort: "low" })).toEqual({ maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "low" } });
    expect(geminiGenerationConfig("gemini-2.5-flash", { max_tokens: 100, reasoning_effort: "high" })).toEqual({ maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 24576 } });
    expect(geminiGenerationConfig("gemini-2.5-flash", { max_tokens: 100 })).toEqual({ maxOutputTokens: 100 });
  });
  it("builds the streaming URL from the express-mode base URL", () => {
    expect(vertexStreamUrl(VERTEX_EXPRESS_BASE_URL, "gemini-3.8-flash")).toBe(
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    );
    expect(vertexStreamUrl(VERTEX_EXPRESS_BASE_URL + "/models/", "models/gemini-2.5-pro")).toContain("/publishers/google/models/gemini-2.5-pro:streamGenerateContent");
    expect(() => vertexStreamUrl(VERTEX_EXPRESS_BASE_URL, "../evil")).toThrow();
  });
  it("reads text, thoughts, calls with signatures and usage from the answer", () => {
    const answer = new GeminiAnswer();
    const deltas: unknown[] = [];
    answer.add({ responseId: "r1", candidates: [{ content: { parts: [{ text: "Hm", thought: true }, { text: "Hel" }] } }] }, (d) => deltas.push(d));
    answer.add({ candidates: [{ content: { parts: [{ text: "lo" }, { functionCall: { name: "browser_click", args: { ref: "e2" } }, thoughtSignature: "sig-2" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 3, totalTokenCount: 17 } }, (d) => deltas.push(d));
    const message = answer.message();
    expect(message).toMatchObject({ role: "assistant", content: "Hello", reasoning_content: "Hm" });
    expect(message.tool_calls).toEqual([{ id: expect.stringMatching(/^call_/), type: "function", function: { name: "browser_click", arguments: '{"ref":"e2"}' }, extra_content: { google: { thought_signature: "sig-2" } } }]);
    expect(answer.usage).toEqual({ prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 });
    expect(deltas).toEqual([{ reasoning: "Hm" }, { content: "Hel" }, { content: "lo" }]);
  });
  it("says why Gemini gave no answer", () => {
    const answer = new GeminiAnswer();
    answer.add({ promptFeedback: { blockReason: "SAFETY" } });
    expect(() => answer.message()).toThrow("Gemini returned no answer (SAFETY)");
  });
});

describe("Vertex AI requests through complete()", () => {
  it("posts Gemini's format with the key in x-goog-api-key and returns a Chat Completions message", async () => {
    const fetcher = vi.fn(async () => sse(
      { candidates: [{ content: { parts: [{ functionCall: { name: "browser_click", args: { ref: "e9" } }, thoughtSignature: "sig-9" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }, responseId: "resp" },
    ));
    vi.stubGlobal("fetch", fetcher);
    const result = await complete(settings(VERTEX_EXPRESS_BASE_URL, "gemini-3.8-flash"), "vertex-key", [{ role: "system", content: "S" }, { role: "user", content: "Go" }], [tool], new AbortController().signal);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("vertex-key");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    const body = JSON.parse(String(init.body));
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "Go" }] }]);
    expect(body.generationConfig).toEqual({ maxOutputTokens: DEFAULT_SETTINGS.maxOutputTokens });
    expect(body).not.toHaveProperty("messages");
    expect(result.message.tool_calls[0]).toMatchObject({ function: { name: "browser_click", arguments: '{"ref":"e9"}' }, extra_content: { google: { thought_signature: "sig-9" } } });
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(result.requestId).toBe("resp");
  });
  it("reports Google's wrapped error, recognizes a context overflow, and hides the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ error: { code: 400, status: "INVALID_ARGUMENT", message: "The input token count (2000000) exceeds the maximum number of tokens allowed (1048576). key=vertex-key" } }]), { status: 400 })));
    const error = await complete(settings(VERTEX_EXPRESS_BASE_URL, "gemini-2.5-pro"), "vertex-key", [{ role: "user", content: "x" }], [], new AbortController().signal).catch((e) => e);
    expect(error).toBeInstanceOf(ModelEndpointError);
    expect(error.contextExceeded).toBe(true);
    expect(error.contextLimit).toBe(1048576);
    expect(error.message).not.toContain("vertex-key");
  });
});

describe("Google AI Studio through the OpenAI-compatible endpoint", () => {
  it("keeps the thought signature Gemini attaches to a streamed tool call", async () => {
    const stream = [
      { id: "c", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "browser_click", arguments: "" }, extra_content: { google: { thought_signature: "sig-s" } } }] } }] },
      { id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"ref":"e1"}' } }] }, finish_reason: "tool_calls" }] },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })));
    const result = await complete(settings(GEMINI_STUDIO_BASE_URL, "gemini-3.8-flash"), "studio-key", [{ role: "user", content: "Go" }], [tool], new AbortController().signal);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer studio-key");
    expect(result.message.tool_calls).toEqual([{ id: "call-1", type: "function", function: { name: "browser_click", arguments: '{"ref":"e1"}' }, extra_content: { google: { thought_signature: "sig-s" } } }]);
  });
});

describe("Gemini model lists", () => {
  const memory = () => {
    const data: Record<string, unknown> = {};
    return { get: async () => data, set: async (value: Record<string, unknown>) => void Object.assign(data, value) };
  };
  it("offers Vertex's documented models without a request, since express mode cannot list them", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const models = await new ModelCatalogue(memory()).list(settings(VERTEX_EXPRESS_BASE_URL, ""), "vertex-key");
    expect(fetcher).not.toHaveBeenCalled();
    expect(models.map((model) => model.id)).toContain("gemini-2.5-flash");
    const flash = models.find((model) => model.id === "gemini-3.8-flash")!;
    expect(flash).toMatchObject({ contextWindow: 1048576, supportsTools: true, supportsVision: true, reasoningFormat: "reasoning_effort", reasoningEfforts: ["low", "medium", "high"] });
  });
  it("reads AI Studio's native list for token limits and drops non-chat models", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ models: [
      { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "countTokens"], thinking: true },
      { name: "models/gemini-3.6-flash", displayName: "Gemini 3.6 Flash", inputTokenLimit: 1000000, outputTokenLimit: 32768, supportedGenerationMethods: ["generateContent"], thinking: true },
      { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] },
    ] })));
    vi.stubGlobal("fetch", fetcher);
    const models = await new ModelCatalogue(memory()).list(settings(GEMINI_STUDIO_BASE_URL, ""), "studio-key");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("studio-key");
    expect(models.map((model) => model.id)).toEqual(["gemini-3.8-flash", "gemini-3.6-flash"]);
    expect(models[1]).toMatchObject({ name: "Gemini 3.6 Flash", contextWindow: 1000000, maxOutputTokens: 32768, reasoningEfforts: ["minimal", "low", "medium", "high"] });
  });
});
