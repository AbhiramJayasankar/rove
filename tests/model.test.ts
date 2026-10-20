import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { complete, completionUrl, testModel } from "../server/model";

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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
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
    expect(body).not.toHaveProperty("max_tokens");
    expect(result.message.tool_calls[0].id).toBe("call1");
    expect(result.message.reasoning_content).toBe("Need to inspect.");
    expect(result.usage.total_tokens).toBe(12);
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
    ).rejects.toThrow("HTTP 401: Bad key [REDACTED]");
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
      vi
        .fn()
        .mockResolvedValue(
          answer({
            content: null,
            tool_calls: [
              {
                id: "check",
                type: "function",
                function: {
                  name: "relay_connection_check",
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
});
