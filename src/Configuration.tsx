import { useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import changelog from "../CHANGELOG.md?raw";
import {
  Check,
  Cpu,
  Eye,
  EyeOff,
  LoaderCircle,
  Minus,
  Plus,
  RotateCcw,
  ScrollText,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { AppState, Settings } from "../shared/types";
import { DEFAULT_PROMPT } from "../shared/defaults";
import ModelChecklist from "./ModelChecklist";
import ShortcutsEditor from "./ShortcutsEditor";
import SiteRules from "./SiteRules";
import { useShortcutsEditor } from "./shortcuts";
import { useModelVisibility } from "./modelVisibility";
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
  const visibility = useModelVisibility(state.activeProviderId);
  const shortcuts = useShortcutsEditor();
  const [toolSearch, setToolSearch] = useState("");
  const whatsNew = useRef<HTMLDialogElement>(null);
  const tabs: [Page, string, typeof Cpu][] = [
    ["settings", "Model", Cpu],
    ["instructions", "Instructions", ScrollText],
    ["tools", "Tools", Wrench],
  ];
  const enabledCount = state.tools.length - draft.disabledTools.length;
  const tools = state.tools.filter((tool) =>
    (tool.name + tool.description)
      .toLowerCase()
      .includes(toolSearch.toLowerCase()),
  );
  const groups = (["read", "write", "danger"] as const)
    .map((risk) => ({ risk, items: tools.filter((tool) => tool.risk === risk) }))
    .filter((group) => group.items.length);
  return (
    <section className="settings-page">
      <div className="settings-nav">
        <nav
          aria-label="Settings sections"
          className="settings-tabs"
          style={{ "--tab-index": tabs.findIndex(([id]) => id === page) } as React.CSSProperties}
        >
          <span className="settings-tabs-thumb" aria-hidden="true" />
          {tabs.map(([id, label, Icon]) => (
            <button
              aria-current={page === id ? "page" : undefined}
              className={page === id ? "selected" : ""}
              key={id}
              onClick={() => setPage(id)}
            >
              <Icon size={15} aria-hidden="true" />
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
            <h2 className="settings-title">Language model</h2>
            <div className="panel provider-panel">
              <div className="provider-picker-row">
                <ChoiceMenu label="Configure provider" value={state.activeProviderId} options={[
                  ...state.providers.map(provider => ({ value: provider.id, label: provider.name })),
                  { value: "add:openrouter", label: "+ Add OpenRouter" },
                  { value: "add:custom", label: "+ Add compatible provider" },
                ]} onChange={id => void changeProvider(id)} disabled={!!pending || !!state.activeRunId} />
                <button type="button" className="icon-button" aria-label="Remove provider" title="Remove provider" disabled={!!pending || !!state.activeRunId || state.providers.length < 2} onClick={() => void changeProvider("remove")}><Trash2 size={15} /></button>
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
            </div>
            <div className="panel model-panel">
              <div className="field model-connection-field">
                <span>Models in chat</span>
                <ModelChecklist
                  providerId={state.activeProviderId}
                  connection={{
                    baseUrl: draft.baseUrl,
                    ...(keyChanged ? { apiKey } : {}),
                  }}
                  model={draft.model}
                  visibility={visibility}
                  onFirstPick={(model) => {
                    update("model", model);
                    update("reasoningEffort", "default");
                  }}
                />
              </div>
              <div className="tool-round-limit">
                <label htmlFor="step-limit">Step limit</label>
                <div className="stepper">
                  <button type="button" className="icon-button" aria-label="Fewer steps" disabled={!!state.activeRunId || draft.maxSteps <= 1} onClick={() => update("maxSteps", Math.max(1, draft.maxSteps - 1))}><Minus size={14} /></button>
                  <input
                    id="step-limit"
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
                  <button type="button" className="icon-button" aria-label="More steps" disabled={!!state.activeRunId || draft.maxSteps >= 200} onClick={() => update("maxSteps", Math.min(200, draft.maxSteps + 1))}><Plus size={14} /></button>
                </div>
              </div>
            </div>
            <VoiceSettings voice={voice} />
            <p className="about-line">
              Rove {__APP_VERSION__}
              <button type="button" className="text-button" onClick={() => whatsNew.current?.showModal()}>
                What&apos;s new
              </button>
            </p>
            <dialog
              ref={whatsNew}
              className="history-dialog changelog-dialog"
              aria-label="What's new"
              onClick={(event) => {
                if (event.target === event.currentTarget) whatsNew.current?.close();
              }}
            >
              <div className="dialog-heading">
                <h2>What&apos;s new</h2>
                <button className="icon-button" aria-label="Close what's new" onClick={() => whatsNew.current?.close()}>
                  <X size={18} />
                </button>
              </div>
              <div className="markdown changelog-body">
                <Markdown remarkPlugins={[remarkGfm]}>{changelog}</Markdown>
              </div>
            </dialog>
          </section>
        ) : page === "instructions" ? (
          <section className="instructions-settings">
            <div className="settings-heading">
              <h2 className="settings-title">System instructions</h2>
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
            <div className="panel editor-panel">
              <textarea
                aria-label="System instructions"
                className="instructions-editor"
                value={draft.systemPrompt}
                onChange={(e) => update("systemPrompt", e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="settings-heading">
              <h2 className="settings-title">Standing instructions</h2>
            </div>
            <div className="panel memory-panel">
              <textarea
                aria-label="Standing instructions"
                className="instructions-editor memory-editor"
                placeholder="Things Rove should always know or follow, in every chat."
                value={draft.memory}
                onChange={(e) => update("memory", e.target.value)}
                spellCheck={false}
              />
            </div>
            <ShortcutsEditor editor={shortcuts} />
          </section>
        ) : (
          <section className="tools-settings">
            <div className="settings-heading">
              <h2 className="settings-title">Browser tools</h2>
              <span className="tool-count" aria-label={`${enabledCount} of ${state.tools.length} enabled`}>
                <strong>{enabledCount}</strong>/{state.tools.length}
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
            {groups.map(({ risk, items }) => (
              <div className="tool-group" key={risk}>
                <h3 className={`tool-group-title ${risk}`}>
                  {risk === "read" ? "Look" : risk === "write" ? "Act" : "Dangerous"}
                </h3>
                <div className="panel tools-list">
                  {items.map((tool) => (
                    <div className="tool-row" key={tool.name}>
                      <div className="tool-definition">
                        <details>
                          <summary>
                            <strong>{toolTitle(tool.name, {})}</strong>
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
              </div>
            ))}
            <SiteRules rules={draft.siteRules} onChange={(rules) => update("siteRules", rules)} />
          </section>
        )}
      </div>
      <footer className="settings-footer">
        <button
          className="button primary"
          disabled={!!pending || !!state.activeRunId}
          onClick={() => saveSettings(async () => { await voice.save(); await visibility.save(); await shortcuts.save(); })}
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
