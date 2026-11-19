import { afterEach, describe, expect, it, vi } from "vitest";
import { EXCERPT_CHARS, parseResults, webSearch } from "../search";
import { getTools } from "../tools";
import { DEFAULT_SETTINGS } from "../../shared/defaults";

afterEach(() => vi.unstubAllGlobals());
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function sent(fetcher: ReturnType<typeof vi.fn>) {
  const [url, init] = fetcher.mock.calls[0];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body), redirect: init.redirect };
}

describe("web search providers", () => {
  it("sends Exa its key in x-api-key and asks for highlights", async () => {
    const fetcher = vi.fn(async () => reply({ results: [] }));
    await webSearch("exa", "exa-key", { query: " rove agent ", maxResults: 4 }, undefined, fetcher);
    const request = sent(fetcher);
    expect(request.url).toBe("https://api.exa.ai/search");
    expect(request.headers["x-api-key"]).toBe("exa-key");
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.redirect).toBe("error");
    expect(request.body).toEqual({
      query: "rove agent", numResults: 4, type: "auto",
      contents: { highlights: { maxCharacters: EXCERPT_CHARS }, text: { maxCharacters: EXCERPT_CHARS } },
    });
  });
  it("sends Tavily a bearer key and basic depth", async () => {
    const fetcher = vi.fn(async () => reply({ results: [] }));
    await webSearch("tavily", "tvly-key", { query: "news" }, undefined, fetcher);
    const request = sent(fetcher);
    expect(request.url).toBe("https://api.tavily.com/search");
    expect(request.headers.Authorization).toBe("Bearer tvly-key");
    expect(request.body).toEqual({ query: "news", max_results: 5, search_depth: "basic", include_answer: false, include_raw_content: false });
  });
  it("sends Parallel the query as objective and search query, with a total excerpt budget", async () => {
    const fetcher = vi.fn(async () => reply({ search_id: "s", results: [] }));
    await webSearch("parallel", "par-key", { query: "launch", maxResults: 12 }, undefined, fetcher);
    const request = sent(fetcher);
    expect(request.url).toBe("https://api.parallel.ai/v1/search");
    expect(request.headers["x-api-key"]).toBe("par-key");
    // At most 10 results, whatever the model asks for.
    expect(request.body).toEqual({ objective: "launch", search_queries: ["launch"], mode: "fast", max_chars_total: 10 * EXCERPT_CHARS, advanced_settings: { max_results: 10 } });
  });
  it("reduces each provider's results to title, URL, date and a bounded excerpt", () => {
    const long = "word ".repeat(600);
    expect(parseResults("exa", { results: [{ title: "A", url: "https://a.test", highlights: ["one", " two "], publishedDate: "2026-11-01T10:00:00.000Z" }, { url: "https://b.test", text: long }, { title: "no url" }] })).toEqual([
      { title: "A", url: "https://a.test", published: "2026-11-01", excerpt: "one … two" },
      { title: "https://b.test", url: "https://b.test", excerpt: expect.stringMatching(/…$/) },
    ]);
    expect(parseResults("exa", { results: [{ url: "https://b.test", text: long }] })[0].excerpt.length).toBe(EXCERPT_CHARS);
    expect(parseResults("tavily", { results: [{ title: "T", url: "https://t.test", content: "snippet", published_date: "2026-10-02" }] })).toEqual([
      { title: "T", url: "https://t.test", published: "2026-10-02", excerpt: "snippet" },
    ]);
    expect(parseResults("parallel", { results: [{ title: null, url: "https://p.test", excerpts: ["# Heading", "body"], publish_date: "2026-09-09" }] })).toEqual([
      { title: "https://p.test", url: "https://p.test", published: "2026-09-09", excerpt: "# Heading … body" },
    ]);
  });
  it("explains a rejected key and never repeats it", async () => {
    const fetcher = vi.fn(async () => reply({ error: "Invalid API key: secret-key-9" }, 401));
    const error = await webSearch("exa", "secret-key-9", { query: "x" }, undefined, fetcher).catch((e) => e);
    expect(error.message).toContain("Exa rejected the search API key (HTTP 401)");
    expect(error.message).toContain("Settings > Tools");
    expect(error.message).not.toContain("secret-key-9");
  });
  it("names credit and rate limits", async () => {
    for (const [status, text] of [[432, "needs credits"], [429, "limiting searches"], [503, "server error"]] as const) {
      const error = await webSearch("tavily", "k1", { query: "x" }, undefined, vi.fn(async () => reply({ detail: { error: "no" } }, status))).catch((e) => e);
      expect(error.message).toContain(text);
    }
  });
  it("refuses to search without a key, before any request", async () => {
    const fetcher = vi.fn();
    await expect(webSearch("parallel", "", { query: "x" }, undefined, fetcher)).rejects.toThrow("Add a Parallel API key");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("web_search tool", () => {
  it("is offered only when a search API is chosen", () => {
    const names = (webSearch: any) => getTools({ ...DEFAULT_SETTINGS, webSearch }).map((tool) => tool.name);
    expect(names("off")).not.toContain("web_search");
    expect(names("tavily")).toContain("web_search");
    expect(getTools({ ...DEFAULT_SETTINGS, webSearch: "tavily", disabledTools: ["web_search"] }).map((tool) => tool.name)).not.toContain("web_search");
  });
});
