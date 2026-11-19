import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, LoaderCircle } from "lucide-react";
import type { AppState, Settings } from "../shared/types";
import ChoiceMenu from "./ChoiceMenu";
import { api, json } from "./ui";
import { useT } from "./i18n";

type Provider = Exclude<Settings["webSearch"], "off">;
const PROVIDERS: Record<Provider, { name: string; keyPage: string; note: string }> = {
  exa: { name: "Exa", keyPage: "https://dashboard.exa.ai/api-keys", note: "Neural search with page highlights." },
  tavily: { name: "Tavily", keyPage: "https://app.tavily.com/home", note: "Search built for agents, with short page extracts." },
  parallel: { name: "Parallel", keyPage: "https://platform.parallel.ai/settings", note: "Search that returns ranked excerpts for a goal." },
};

/** The search key being typed. It is saved before the settings that choose the provider, so a
 * provider and its first key can be saved together with one press of Save. */
export function useSearchKey(draft: Settings) {
  const provider = draft.webSearch === "off" ? undefined : draft.webSearch;
  const [key, setKey] = useState("");
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    setKey("");
    setChanged(false);
  }, [provider]);
  async function save() {
    if (!provider || !changed) return;
    await api("/api/search-key", { method: "PUT", body: json({ provider, apiKey: key }) });
    setKey("");
    setChanged(false);
  }
  return { provider, key, setKey: (value: string) => { setKey(value); setChanged(true); }, changed, save, dirty: changed };
}

export default function WebSearchSettings({
  state,
  draft,
  update,
  search,
}: {
  state: AppState;
  draft: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  search: ReturnType<typeof useSearchKey>;
}) {
  const t = useT();
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { provider } = search;
  const info = provider ? PROVIDERS[provider] : undefined;
  const saved = !!(provider && state.searchKeys?.[provider]);
  useEffect(() => setResult(null), [provider]);
  async function test() {
    if (!provider) return;
    setTesting(true);
    setResult(null);
    try {
      const answer = await api<{ message: string }>("/api/search/test", {
        method: "POST",
        body: json({ provider, ...(search.changed && search.key.trim() ? { apiKey: search.key } : {}) }),
      });
      setResult({ ok: true, text: answer.message });
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  }
  return (
    <>
      <div className="settings-heading">
        <h2 className="settings-title">{t("Web search")}</h2>
      </div>
      <div className="panel search-panel">
        <div className="field">
          <span>{t("Search API")}</span>
          <ChoiceMenu
            label={t("Search API")}
            value={draft.webSearch}
            options={[
              { value: "off", label: t("Off"), description: t("The model searches by opening a search engine in a tab.") },
              ...(Object.entries(PROVIDERS) as [Provider, (typeof PROVIDERS)[Provider]][]).map(([value, item]) => ({
                value,
                label: item.name,
                description: t(item.note),
              })),
            ]}
            onChange={(value) => update("webSearch", value as Settings["webSearch"])}
          />
        </div>
        {info && provider && (
          <>
            <div className="field">
              <label htmlFor="search-key">
                {t("{name} API key", { name: info.name })}{" "}
                {saved && !search.changed && (
                  <span className="field-state">
                    <Check size={12} /> {t("Saved")}
                  </span>
                )}
              </label>
              <div className="password-field">
                <input
                  id="search-key"
                  type={show ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  value={search.key}
                  onChange={(event) => search.setKey(event.target.value)}
                  placeholder={saved ? t("Saved key · enter to replace") : t("Enter API key")}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={show ? t("Hide API key") : t("Show API key")}
                  onClick={() => setShow(!show)}
                >
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <div className="field-footer">
                <span>
                  {t("Rove adds a web_search tool. Queries go only to {name}.", { name: info.name })}{" "}
                  <a href={info.keyPage} target="_blank" rel="noreferrer">
                    {t("Get a key")}
                  </a>
                </span>
                {saved && !search.changed && (
                  <button type="button" className="text-button" onClick={() => search.setKey("")}>
                    {t("Clear key")}
                  </button>
                )}
              </div>
            </div>
            <div className="search-test">
              <button
                type="button"
                className="button secondary"
                disabled={testing || (!saved && !search.key.trim())}
                onClick={() => void test()}
              >
                {testing ? <LoaderCircle className="spin" size={14} /> : null}
                {t("Test search")}
              </button>
              {result && (
                <span role="status" className={result.ok ? "search-test-ok" : "search-test-error"}>
                  {result.ok && <Check size={13} aria-hidden="true" />} {result.text}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
