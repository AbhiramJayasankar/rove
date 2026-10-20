import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import { reasoningOptions, resolvedReasoningEffort } from "../../shared/capabilities";
import type { ModelInfo } from "../../shared/types";
import { ModelCatalogue, effectiveSettings } from "../catalogue";
import { generationOptions, parseReasoningBody } from "../model";
import { getTools } from "../tools";

const settings = { ...DEFAULT_SETTINGS, baseUrl: "http://127.0.0.1:8080/v1", model: "ling" };
const storage = () => {
  const data: Record<string, any> = {};
  return {
    get: async (keys: string | string[]) => Object.fromEntries([keys].flat().map((key) => [key, structuredClone(data[key])])),
    set: async (values: Record<string, unknown>) => void Object.assign(data, structuredClone(values)),
  };
};
function llamaServer(props: Record<string, unknown> | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).endsWith("/props")) return props ? new Response(JSON.stringify(props)) : new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({ data: [{ id: "ling", owned_by: "llamacpp", meta: { n_ctx: 262144 } }] }),
      );
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe("llama.cpp detection", () => {
  it("reads context, image support and a thinking switch from the server", async () => {
    llamaServer({ build_info: "b1", modalities: { vision: false }, chat_template: "{% if enable_thinking %}<think>{% endif %}" });
    const [model] = await new ModelCatalogue(storage()).list(settings, "");
    expect(model.contextWindow).toBe(262144);
    expect(model.supportsVision).toBe(false);
    expect(model.reasoningFormat).toBe("reasoning_effort");
    expect(reasoningOptions(settings, model).map((option) => option.value)).toEqual(["none", "high"]);
    expect(generationOptions({ ...settings, reasoningEffort: "none" }, model)).toMatchObject({ reasoning_effort: "none" });
  });
  it("stays quiet when the server has no /props", async () => {
    llamaServer(null);
    const [model] = await new ModelCatalogue(storage()).list(settings, "");
    expect(model.contextWindow).toBe(262144);
    expect(model.supportsVision).toBeUndefined();
  });
});

describe("several providers", () => {
  it("still knows the active model after listing another provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new Response(
          JSON.stringify({
            data: String(url).startsWith("https://router.example")
              ? [{ id: "other", supported_parameters: ["tools"] }]
              : [{ id: "ling", supported_parameters: ["tools", "reasoning_effort"], reasoning_efforts: ["low", "high"] }],
          }),
        ),
      ),
    );
    const catalogue = new ModelCatalogue(storage());
    const other = { ...settings, baseUrl: "https://router.example/v1", model: "other" };
    await Promise.all([catalogue.list(settings, "local"), catalogue.list(other, "remote")]);
    expect(catalogue.peek(settings, "local")?.reasoningEfforts).toEqual(["low", "high"]);
    expect(catalogue.peek(other, "remote")?.id).toBe("other");
    expect(catalogue.peek(settings, "wrong-key")).toBeNull();
    expect(catalogue.find("https://router.example/v1", "other")?.id).toBe("other");
  });
});

describe("per-model overrides", () => {
  it("force images off, survive a key change, and clear", async () => {
    llamaServer({ build_info: "b1", modalities: { vision: true } });
    const catalogue = new ModelCatalogue(storage());
    await catalogue.setOverride(settings.baseUrl + "/", "ling", { images: "off" });
    const [model] = await catalogue.list(settings, "key-one");
    expect(model.supportsVision).toBe(false);
    expect(model.endpointVision).toBe(true);
    expect(effectiveSettings(settings, model).vision).toBe(false);
    const [rekeyed] = await catalogue.list(settings, "key-two");
    expect(rekeyed.supportsVision).toBe(false);
    await catalogue.setOverride(settings.baseUrl, "ling", null);
    const [cleared] = await catalogue.list(settings, "key-two", true);
    expect(cleared.supportsVision).toBe(true);
    expect(cleared.override).toBeUndefined();
  });
  it("hides screenshots from a model that gets no images", () => {
    expect(getTools({ ...settings, vision: false }).some((tool) => tool.name === "browser_screenshot")).toBe(false);
    expect(getTools({ ...settings, vision: true }).some((tool) => tool.name === "browser_screenshot")).toBe(true);
  });
  it("replaces the reasoning control with the user's own levels", () => {
    const model: ModelInfo = {
      id: "ling", name: "ling", free: true, metadata: {}, source: "", fetchedAt: "",
      reasoningFormat: "reasoning_effort", reasoningEfforts: ["none", "high"],
      customReasoning: [
        { value: "off", label: "Off", body: '{"chat_template_kwargs":{"enable_thinking":false}}' },
        { value: "on", label: "On", body: '{"chat_template_kwargs":{"enable_thinking":true},"thinking_budget_tokens":2048}' },
      ],
    };
    expect(reasoningOptions(settings, model)).toEqual([{ value: "off", label: "Off" }, { value: "on", label: "On" }]);
    expect(resolvedReasoningEffort({ ...settings, reasoningEffort: "default" }, model)).toBe("on");
    expect(generationOptions({ ...settings, reasoningEffort: "off" }, model)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    const on = generationOptions({ ...settings, reasoningEffort: "on" }, model);
    expect(on).toMatchObject({ chat_template_kwargs: { enable_thinking: true }, thinking_budget_tokens: 2048 });
    expect(on).not.toHaveProperty("reasoning_effort");
  });
  it("rejects request bodies that are not objects or that touch the agent's own fields", () => {
    expect(() => parseReasoningBody("not json")).toThrow("valid JSON");
    expect(() => parseReasoningBody("[1]")).toThrow("JSON object");
    expect(() => parseReasoningBody('{"messages":[]}')).toThrow("cannot set messages");
    expect(parseReasoningBody("")).toEqual({});
  });
});
