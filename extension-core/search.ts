import { readBounded } from "./tools";

/** Web search APIs the web_search tool can use. Each key is sent only to its own fixed origin. */
export const SEARCH_PROVIDERS = {
  exa: { name: "Exa", endpoint: "https://api.exa.ai/search", keyPage: "https://dashboard.exa.ai/api-keys" },
  tavily: { name: "Tavily", endpoint: "https://api.tavily.com/search", keyPage: "https://app.tavily.com/home" },
  parallel: { name: "Parallel", endpoint: "https://api.parallel.ai/v1/search", keyPage: "https://platform.parallel.ai/settings" },
} as const;
export type SearchProvider = keyof typeof SEARCH_PROVIDERS;
export const SEARCH_PROVIDER_IDS = Object.keys(SEARCH_PROVIDERS) as SearchProvider[];

export interface SearchResult {
  title: string;
  url: string;
  published?: string;
  excerpt: string;
}
export interface SearchResponse {
  provider: string;
  query: string;
  results: SearchResult[];
}

/** Characters of excerpt kept per result: enough to judge a page, small enough for many searches per task. */
export const EXCERPT_CHARS = 1200;
const TIMEOUT_MS = 30000;

const clean = (text: unknown) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");
const cut = (text: string, limit = EXCERPT_CHARS) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);
const joined = (parts: unknown) =>
  Array.isArray(parts) ? parts.map(clean).filter(Boolean).join(" … ") : "";

function requestBody(provider: SearchProvider, query: string, count: number) {
  if (provider === "exa")
    return { query, numResults: count, type: "auto", contents: { highlights: { maxCharacters: EXCERPT_CHARS }, text: { maxCharacters: EXCERPT_CHARS } } };
  if (provider === "tavily")
    return { query, max_results: count, search_depth: "basic", include_answer: false, include_raw_content: false };
  return { objective: query, search_queries: [query], mode: "fast", max_chars_total: count * EXCERPT_CHARS, advanced_settings: { max_results: count } };
}

function authHeaders(provider: SearchProvider, key: string): Record<string, string> {
  return provider === "tavily" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key };
}

/** Each provider's result list, reduced to the same small shape. */
export function parseResults(provider: SearchProvider, data: any): SearchResult[] {
  const entries: any[] = Array.isArray(data?.results) ? data.results : [];
  return entries
    .filter((entry) => entry && typeof entry.url === "string")
    .map((entry) => {
      const excerpt =
        provider === "exa"
          ? joined(entry.highlights) || clean(entry.text) || clean(entry.summary)
          : provider === "tavily"
            ? clean(entry.content)
            : joined(entry.excerpts);
      const published = clean(entry.publishedDate ?? entry.published_date ?? entry.publish_date);
      return {
        title: cut(clean(entry.title) || entry.url, 200),
        url: entry.url,
        ...(published ? { published: published.slice(0, 10) } : {}),
        excerpt: cut(excerpt),
      };
    });
}

function describe(name: string, status: number, raw: string): string {
  let said = "";
  try {
    const details = JSON.parse(raw);
    said = [details?.error?.message, details?.error, details?.message, details?.detail?.error, details?.detail]
      .find((value) => typeof value === "string" && value.trim()) ?? "";
  } catch {
    said = /<\/?[a-z][\s\S]*>/i.test(raw) ? "" : raw;
  }
  said = said.replace(/\s+/g, " ").trim().slice(0, 300);
  const detail = said ? `: ${said}` : ".";
  if (status === 401 || status === 403) return `${name} rejected the search API key (HTTP ${status})${detail} Check the key in Settings > Tools.`;
  if (status === 402 || status === 432 || status === 433) return `${name} needs credits or a higher plan (HTTP ${status})${detail}`;
  if (status === 429) return `${name} is limiting searches (HTTP 429)${detail} Wait a moment and try again.`;
  if (status >= 500) return `${name} had a server error (HTTP ${status})${detail} Try again in a moment.`;
  return `${name} search failed (HTTP ${status})${detail}`;
}

export async function webSearch(
  provider: SearchProvider,
  key: string,
  args: { query: string; maxResults?: number },
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SearchResponse> {
  const info = SEARCH_PROVIDERS[provider];
  if (!info) throw new Error("Choose a web search provider in Settings > Tools.");
  if (!key) throw new Error(`Add a ${info.name} API key in Settings > Tools to use web search.`);
  const query = args.query.trim();
  if (!query) throw new Error("web_search needs a non-empty query.");
  const count = Math.max(1, Math.min(10, Math.trunc(args.maxResults ?? 5)));
  const redact = (text: string) => text.split(key).join("[redacted]");
  let response: Response;
  try {
    response = await fetcher(info.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(provider, key) },
      body: JSON.stringify(requestBody(provider, query, count)),
      signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]),
      redirect: "error",
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redact(`${info.name} search request failed: ${message}`));
  }
  const raw = await readBounded(response, 4_000_000);
  if (!response.ok) throw new Error(redact(describe(info.name, response.status, raw)));
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${info.name} returned a response that is not JSON.`);
  }
  return { provider: info.name, query, results: parseResults(provider, data).slice(0, count) };
}
