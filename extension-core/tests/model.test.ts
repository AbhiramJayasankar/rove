import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import { normalizeModel } from "../catalogue";
import {
  complete,
  completionUrl,
  testModel,
  generationOptions,
  describeHttpError,
  ModelEndpointError,
} from "../model";

afterEach(() => vi.unstubAllGlobals());
const settings = {
  ...DEFAULT_SETTINGS,
  model: "local-model",
  baseUrl: "http://localhost:1234/v1",
};
const answer = (message: any = { content: "Connected" }) =>
  new Response(
    JSON.stringify({ choices: [{ message }], usage: { total_tokens: 12 } }),
    { status: 200 },
  );

describe("OpenAI-compatible models", () => {
  it("accepts a base URL or full completions endpoint without duplicating paths", () => {
    expect(completionUrl("http://localhost:1234/v1/")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(completionUrl("https://provider.test/custom/chat/completions")).toBe(
      "https://provider.test/custom/chat/completions",
    );
    expect(() => completionUrl("file:///tmp/model")).toThrow("HTTP");
    expect(() => completionUrl("https://user:secret@provider.test/v1")).toThrow(
      "credentials",
    );
  });

  it("supports keyless local servers, tools, and vision without provider-specific generation parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      answer({
        content: null,
        reasoning_content: "Need to inspect.",
        tool_calls: [
          {
            id: "call1",
            type: "function",
            function: { name: "inspect", arguments: "{}" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,YQ==" },
          },
        ],
      },
    ];
    const result = await complete(
      settings,
      "",
      messages,
      [
        {
          name: "inspect",
          description: "Inspect",
          parameters: { type: "object" },
          risk: "read",
        },
      ],
      new AbortController().signal,
    );
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:1234/v1/chat/completions");
    expect(request.headers.Authorization).toBeUndefined();
    const body = JSON.parse(request.body);
    expect(body.messages).toEqual(messages);
    expect(body.tools[0].function.name).toBe("inspect");
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_tokens).toBe(settings.maxOutputTokens);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(result.message.tool_calls[0].id).toBe("call1");
    expect(result.message.reasoning_content).toBe("Need to inspect.");
    expect(result.usage.total_tokens).toBe(12);
  });

  it("uses the reasoning protocol declared by model metadata", () => {
    const binary = normalizeModel(
      { id: "binary", supported_parameters: ["thinking"] },
      "fixture",
    );
    expect(
      generationOptions({ ...settings, reasoningEffort: "high" }, binary),
    ).toMatchObject({ thinking: { type: "enabled" } });
    expect(
      generationOptions({ ...settings, reasoningEffort: "none" }, binary),
    ).toMatchObject({ thinking: { type: "disabled" } });
    const levels = normalizeModel(
      {
        id: "levels",
        supported_parameters: ["reasoning_effort"],
        reasoning_efforts: ["low", "high"],
      },
      "fixture",
    );
    expect(
      generationOptions({ ...settings, reasoningEffort: "high" }, levels),
    ).toMatchObject({ reasoning_effort: "high" });
  });
  it("assembles fragmented streamed reasoning and tool calls before execution", async () => {
    const chunks = [
      {
        choices: [
          { index: 0, delta: { reasoning_content: "Inspect first. " } },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_content: "Then act.",
              tool_calls: [
                {
                  index: 0,
                  id: "call1",
                  type: "function",
                  function: { name: "browser_", arguments: '{\"tab' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { name: "snapshot", arguments: 'Id\":7}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 55 },
      },
    ];
    const bytes = new TextEncoder().encode(
      chunks.map((c) => "data: " + JSON.stringify(c) + "\r\n\r\n").join("") +
        "data: [DONE]\r\n\r\n",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < bytes.length; i += 11)
                c.enqueue(bytes.slice(i, i + 11));
              c.close();
            },
          }),
          {
            headers: {
              "Content-Type": "text/event-stream",
              "x-request-id": "request1",
            },
          },
        ),
      ),
    );
    const deltas: any[] = [];
    const result = await complete(
      settings,
      "",
      [],
      [],
      new AbortController().signal,
      (d) => deltas.push(d),
    );
    expect(result.message.reasoning_content).toBe("Inspect first. Then act.");
    expect(result.message.tool_calls[0].function).toEqual({
      name: "browser_snapshot",
      arguments: '{"tabId":7}',
    });
    expect(result.requestId).toBe("request1");
    expect(deltas.map((d) => d.reasoning || "").join("")).toBe(
      "Inspect first. Then act.",
    );
  });
  it("rejects an incomplete stream instead of executing partial arguments", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          ),
        ),
    );
    await expect(
      complete(settings, "", [], [], new AbortController().signal),
    ).rejects.toThrow("stream ended");
  });

  it("passes a key only in Authorization and redacts it from endpoint errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("Bad key secret-api-key", { status: 401 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      complete(
        settings,
        "secret-api-key",
        [],
        [],
        new AbortController().signal,
      ),
    ).rejects.toThrow("(HTTP 401): Bad key [REDACTED]");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer secret-api-key",
    );
  });

  it("rejects malformed tool calls and an HTML endpoint response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          answer({ content: null, tool_calls: [{ id: "oops" }] }),
        )
        .mockResolvedValueOnce(new Response("<html>Not an API</html>")),
    );
    await expect(
      complete(settings, "", [], [], new AbortController().signal),
    ).rejects.toThrow("malformed");
    await expect(
      complete(settings, "", [], [], new AbortController().signal),
    ).rejects.toThrow("invalid JSON");
  });

  it("verifies function calling in the connection test and rejects an unset model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        answer({
          content: null,
          tool_calls: [
            {
              id: "check",
              type: "function",
              function: {
                name: "rove_connection_check",
                arguments: '{"status":"ok"}',
              },
            },
          ],
        }),
      ),
    );
    expect(await testModel(settings, "")).toBe(
      "Connection and tool calling verified.",
    );
    await expect(testModel({ ...settings, model: "" }, "")).rejects.toThrow(
      "Choose a model",
    );
  });

  it("fails clearly when a model connects but cannot call tools", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(answer()));
    await expect(testModel(settings, "")).rejects.toThrow(
      "did not produce a valid function call",
    );
  });

  it("does not duplicate tool-call ids or names that a gateway repeats on every stream chunk", async () => {
    const chunk = (delta: any, finish?: string) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const body =
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "browser_snapshot", arguments: '{"que' } }] }) +
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "browser_snapshot", arguments: 'ry":"x"}' } }] }) +
      chunk({}, "tool_calls") +
      "data: [DONE]\n\n";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const { message } = await complete(settings, "", [{ role: "user", content: "x" }], [], new AbortController().signal);
    expect(message.tool_calls).toEqual([{ id: "call_1", type: "function", function: { name: "browser_snapshot", arguments: '{"query":"x"}' } }]);
  });
  it("lets a stream that keeps producing output run past the silence limit", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for (let i = 0; i < 5; i++) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ab" } }] })}

`));
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const { message } = await complete({ ...settings, modelTimeoutSeconds: 0.15 }, "", [{ role: "user", content: "x" }], [], new AbortController().signal);
    expect(message.content).toBe("ababababab");
  });
  it("reports a silent endpoint with a clear message", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))));
    await expect(complete({ ...settings, modelTimeoutSeconds: 0.05 }, "", [{ role: "user", content: "x" }], [], new AbortController().signal)).rejects.toThrow("sent nothing for");
  });
});

describe("model errors people can act on", () => {
  it("names the problem, keeps the provider's message, and drops JSON and HTML wrappers", () => {
    const json = (message: string) => JSON.stringify({ error: { message, type: "x" } });
    expect(describeHttpError(401, json("Incorrect API key provided."), JSON.parse(json("Incorrect API key provided."))))
      .toBe("The model provider rejected the request (HTTP 401): Incorrect API key provided. Check the API key for this provider in Settings.");
    expect(describeHttpError(429, json("Slow down."), JSON.parse(json("Slow down.")), "20"))
      .toBe("The model provider is limiting requests (HTTP 429): Slow down. Try again in 20 seconds.");
    expect(describeHttpError(502, "<html><head><style>p{}</style></head><body><h1>502 Bad Gateway</h1><p>cloudflare</p></body></html>"))
      .toBe("The model provider had a server error (HTTP 502): 502 Bad Gateway cloudflare Try again in a moment.");
    expect(describeHttpError(404, "")).toBe("The model provider could not find this endpoint or model (HTTP 404). Check the base URL and model in Settings.");
    expect(describeHttpError(418, "teapot")).toBe("Model endpoint returned HTTP 418: teapot");
  });
  it("still reads a context limit from the provider's message", () => {
    const body = { error: { message: "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.", code: "context_length_exceeded" } };
    const error = new ModelEndpointError(describeHttpError(400, JSON.stringify(body), body), 400, body.error.code, body);
    expect(error.contextExceeded).toBe(true);
    expect(error.contextLimit).toBe(8192);
  });
  it("explains a stream that drops mid-answer", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"Half"}}]}\n\n'));
        controller.error(new TypeError("network error"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } })));
    await expect(complete(settings, "", [{ role: "user", content: "hi" }], [], new AbortController().signal))
      .rejects.toThrow("The connection to the model dropped before the answer finished (network error).");
  });
});
