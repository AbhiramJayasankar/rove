import { useState } from "react";
import {
  Check,
  Eye,
  EyeOff,
  LoaderCircle,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { AppState, Settings } from "../shared/types";
import { DEFAULT_PROMPT } from "../shared/defaults";
import ModelPicker, { tokenCount } from "./ModelPicker";
import VoiceSettings, { useVoiceSettings } from "./VoiceSettings";
import ChoiceMenu from "./ChoiceMenu";
import { json, toolTitle, type Action, type Page } from "./ui";

type Props = {
  providerName: string;
  setProviderName: (name: string) => void;
  changeProvider: (id: string, model?: string) => Promise<void>;
  state: AppState;
  draft: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  page: Exclude<Page, "workbench">;
  setPage: (page: Page) => void;
  pending: string;
  action: Action;
  saveSettings: (saveVoice?: () => Promise<void>) => Promise<void>;
  apiKey: string;
  setApiKey: (value: string) => void;
  keyChanged: boolean;
  notice: (value: string) => void;
};
export default function Configuration({
  providerName,
  setProviderName,
  changeProvider,
  state,
  draft,
  update,
  page,
  setPage,
  pending,
  saveSettings,
  apiKey,
  setApiKey,
  keyChanged,
  notice,
}: Props) {
  const [showKey, setShowKey] = useState(false);
  const voice = useVoiceSettings();
  const [toolSearch, setToolSearch] = useState("");
  const info =
    state.settings.baseUrl === draft.baseUrl &&
    state.modelInfo?.id === draft.model
      ? state.modelInfo
      : null;
  const tabs: [Page, string][] = [
    ["settings", "Model"],
    ["instructions", "Instructions"],
    ["tools", "Tools"],
  ];
  const tools = state.tools.filter((tool) =>
    (tool.name + tool.description)
      .toLowerCase()
      .includes(toolSearch.toLowerCase()),
  );
  return (
    <section className="settings-page">
      <div className="settings-nav">
        <nav aria-label="Settings sections">
          {tabs.map(([id, label]) => (
            <button
              aria-current={page === id ? "page" : undefined}
              className={page === id ? "selected" : ""}
              key={id}
              onClick={() => setPage(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="settings-content">
        {state.activeRunId && (
          <div className="message">
            Stop the current task before saving settings.
          </div>
        )}
        {page === "settings" ? (
          <section className="connection-settings">
            <div className="settings-heading">
              <h1>Language model</h1>
            </div>
            <div className="connection-fields">
              <div className="field">
                <span>Provider</span>
                <div className="provider-picker-row">
                  <ChoiceMenu label="Configure provider" value={state.activeProviderId} options={[
                    ...state.providers.map(provider => ({ value: provider.id, label: provider.name })),
                    { value: "add:openrouter", label: "+ Add OpenRouter" },
                    { value: "add:custom", label: "+ Add compatible provider" },
                  ]} onChange={id => void changeProvider(id)} disabled={!!pending || !!state.activeRunId} />
                  <button type="button" className="icon-button" aria-label="Remove provider" title="Remove provider" disabled={!!pending || !!state.activeRunId || state.providers.length < 2} onClick={() => void changeProvider("remove")}><Trash2 size={15} /></button>
                </div>
              </div>
              <label className="field"><span>Provider name</span><input value={providerName} maxLength={80} onChange={event => setProviderName(event.target.value)} /></label>
              <label className="field">
                <span>API base URL</span>
                <input
                  type="url"
                  value={draft.baseUrl}
                  onChange={(e) => update("baseUrl", e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  spellCheck={false}
                />
              </label>
              <div className="field">
                <label htmlFor="provider-key">
                  API key{" "}
                  {state.hasApiKey && (
                    <span className="field-state">
                      <Check size={12} /> Saved
                    </span>
                  )}
                </label>
                <div className="password-field">
                  <input
                    id="provider-key"
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      state.hasApiKey
                        ? "Saved key · enter to replace"
                        : "Enter API key"
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <div className="field-footer">
                  <span>Saved in this Chrome profile across sessions.</span>
                  {state.hasApiKey && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setApiKey("");
                        notice("Save changes to clear the key.");
                      }}
                    >
                      Clear key
                    </button>
                  )}
                </div>
              </div>
              <div className="field model-connection-field">
                <span>Model</span>
                <ModelPicker
                  providerId={state.activeProviderId}
                  model={draft.model}
                  label={info?.name}
                  connection={{
                    baseUrl: draft.baseUrl,
                    ...(keyChanged ? { apiKey } : {}),
                  }}
                  onSelect={(model, _context, providerId) => {
                    if (providerId && providerId !== state.activeProviderId) { void changeProvider(providerId, model); return; }
                    update("model", model);
                    update("reasoningEffort", "default");
                  }}
                />
              </div>
            </div>
            {info && (
              <div className="connection-facts">
                {info.contextWindow && (
                  <span>
                    <strong>{tokenCount(info.contextWindow)}</strong> context
                  </span>
                )}
                {info.maxOutputTokens && (
                  <span>
                    <strong>{tokenCount(info.maxOutputTokens)}</strong> max
                    output
                  </span>
                )}
              </div>
            )}
            <label className="field tool-round-limit">
              <span>Step limit</span>
              <input
                type="number"
                min={1}
                max={200}
                step={1}
                value={draft.maxSteps}
                disabled={!!state.activeRunId}
                onChange={(event) =>
                  update("maxSteps", Math.max(1, Math.min(200, Math.trunc(event.target.valueAsNumber) || 1)))
                }
              />
            </label>
            <VoiceSettings voice={voice} />
          </section>
        ) : page === "instructions" ? (
          <section className="instructions-settings">
            <div className="settings-heading">
              <h1>System instructions</h1>
              <button
                type="button"
                className="icon-button"
                aria-label="Reset instructions"
                title="Reset instructions"
                onClick={() => update("systemPrompt", DEFAULT_PROMPT)}
              >
                <RotateCcw size={16} />
              </button>
            </div>
            <textarea
              aria-label="System instructions"
              className="instructions-editor"
              value={draft.systemPrompt}
              onChange={(e) => update("systemPrompt", e.target.value)}
              spellCheck={false}
            />
          </section>
        ) : (
          <section className="tools-settings">
            <div className="settings-heading">
              <h1>Browser tools</h1>
              <span className="tool-count">
                {state.tools.length - draft.disabledTools.length} /{" "}
                {state.tools.length}
              </span>
            </div>
            <input
              type="search"
              className="tool-search"
              aria-label="Search tools"
              placeholder="Find a tool…"
              value={toolSearch}
              onChange={(e) => setToolSearch(e.target.value)}
            />
            <div className="tools-list">
              {tools.map((tool) => (
                <div className="tool-row" key={tool.name}>
                  <div className="tool-definition">
                    <details>
                      <summary>
                        <strong>{toolTitle(tool.name, {})}</strong>
                        <span
                          className={
                            tool.risk === "danger"
                              ? "risk-tag danger"
                              : "risk-tag"
                          }
                        >
                          {tool.risk}
                        </span>
                      </summary>
                      <p>{tool.description}</p>
                      <pre>
                        {json({ name: tool.name, parameters: tool.parameters })}
                      </pre>
                    </details>
                  </div>
                  <label className="tool-toggle">
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={"Enable " + tool.name}
                      checked={!draft.disabledTools.includes(tool.name)}
                      onChange={(e) =>
                        update(
                          "disabledTools",
                          e.target.checked
                            ? draft.disabledTools.filter(
                                (name) => name !== tool.name,
                              )
                            : [...draft.disabledTools, tool.name],
                        )
                      }
                    />
                    <span className="switch" aria-hidden="true" />
                  </label>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
      <footer className="settings-footer">
        <button
          className="button primary"
          disabled={!!pending || !!state.activeRunId}
          onClick={() => saveSettings(voice.save)}
        >
          {pending === "save" ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <Check size={15} />
          )}
          Save changes
        </button>
      </footer>
    </section>
  );
}
