import { useState } from "react";
import {
  Check,
  Clipboard,
  Eye,
  LoaderCircle,
  Plug,
  RefreshCw,
} from "lucide-react";
import type { AppState, CustomTool, Settings } from "../shared/types";
import ModelPicker from "./ModelPicker";
import { reasoningOptions } from "../shared/capabilities";
import { DEFAULT_PROMPT } from "../shared/defaults";
import { api, json, type Action, type Page, type Pairing } from "./ui";
type Props = {
  state: AppState;
  draft: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  page: Exclude<Page, "workbench">;
  setPage: (page: Page) => void;
  pending: string;
  action: Action;
  saveSettings: () => Promise<void>;
  apiKey: string;
  setApiKey: (value: string) => void;
  keyChanged: boolean;
  pairing: Pairing | null;
  setPairing: (value: Pairing) => void;
  customText: string;
  setCustomText: (value: string) => void;
  copy: (value: string) => void;
  notice: (value: string) => void;
};
export default function Configuration({
  state,
  draft,
  update,
  page,
  setPage,
  pending,
  action,
  saveSettings,
  apiKey,
  setApiKey,
  keyChanged,
  pairing,
  setPairing,
  customText,
  setCustomText,
  copy,
  notice,
}: Props) {
  const info = state.modelInfo?.id === draft.model ? state.modelInfo : null;
  const reasoningChoices = reasoningOptions(draft, info);
  const [showKey, setShowKey] = useState(false);
  const [toolSearch, setToolSearch] = useState("");
  const tabs: [Page, string][] = [
    ["settings", "Model"],
    ["instructions", "Instructions"],
    ["tools", "Tools"],
    ["connection", "Chrome"],
  ];
  const fieldCopy = (label: string, value: string) => (
    <div className="copy-field">
      <code>{value}</code>
      <button
        className="icon-button"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        onClick={() => copy(value)}
      >
        <Clipboard size={15} />
      </button>
    </div>
  );
  function addExample() {
    let tools: CustomTool[];
    try {
      tools = JSON.parse(customText);
      if (!Array.isArray(tools)) throw new Error();
    } catch {
      notice("Fix the JSON before adding a tool.");
      return;
    }
    let name = "page_heading";
    while (tools.some((t) => t.name === name)) name += "_new";
    tools.push({
      name,
      description: "Read the current page heading.",
      enabled: true,
      approval: false,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: {
        type: "javascript",
        code: 'return { heading: document.querySelector("h1")?.textContent };',
      },
    });
    setCustomText(json(tools));
  }
  return (
    <section className="settings-page">
      <div className="settings-nav">
        <nav aria-label="Settings sections">
          {tabs.map(([id, label]) => (
            <button
              aria-label={label}
              aria-current={page === id ? "page" : undefined}
              className={page === id ? "selected" : ""}
              key={id}
              onClick={() => setPage(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        {page !== "connection" && (
          <button
            className="button primary"
            disabled={!!pending || !!state.activeRunId}
            onClick={saveSettings}
          >
            {pending === "save" ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Check size={15} />
            )}
            Save changes
          </button>
        )}
      </div>
      <div className="settings-content">
        {state.activeRunId && page !== "connection" && (
          <div className="message">
            Stop the current task before saving settings.
          </div>
        )}
        {page === "settings" ? (
          <>
            <section className="settings-section">
              <h2>Model</h2>
              <div className="form-grid">
                <label className="field full">
                  <span>API base URL</span>
                  <input
                    type="url"
                    value={draft.baseUrl}
                    onChange={(e) => update("baseUrl", e.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <div className="field full">
                  <span>Model</span>
                  <ModelPicker
                    model={draft.model}
                    onSelect={(model) => {
                      update("model", model);
                      update("reasoningEffort", "default");
                    }}
                  />
                </div>
                <div className="field full">
                  <label htmlFor="provider-key">
                    API key
                    {state.hasApiKey && (
                      <span className="field-state">Configured</span>
                    )}
                  </label>
                  <div className="password-field">
                    <input
                      id="provider-key"
                      type={showKey ? "text" : "password"}
                      autoComplete="off"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={
                        state.hasApiKey ? "Enter a replacement key" : "API key"
                      }
                    />
                    <button
                      className="icon-button"
                      aria-label={showKey ? "Hide API key" : "Show API key"}
                      onClick={() => setShowKey(!showKey)}
                    >
                      <Eye size={16} />
                    </button>
                  </div>
                  <div className="field-footer">
                    <span>Kept in memory until the server restarts.</span>
                    {state.hasApiKey && (
                      <button
                        className="text-button"
                        onClick={() => {
                          setApiKey("");
                          notice("Key will be cleared when you save.");
                        }}
                      >
                        Clear key
                      </button>
                    )}
                  </div>
                </div>
              </div>
              {info && (
                <details className="model-metadata">
                  <summary>Endpoint capabilities</summary>
                  <dl>
                    <dt>Context</dt>
                    <dd>
                      {info.contextWindow?.toLocaleString() || "Not advertised"}
                    </dd>
                    <dt>Maximum output</dt>
                    <dd>
                      {info.maxOutputTokens?.toLocaleString() ||
                        "Not advertised"}
                    </dd>
                    <dt>Tool calling</dt>
                    <dd>
                      {info.supportsTools == null
                        ? "Not advertised"
                        : info.supportsTools
                          ? "Supported"
                          : "Unsupported"}
                    </dd>
                    <dt>Vision</dt>
                    <dd>
                      {info.supportsVision == null
                        ? "Not advertised"
                        : info.supportsVision
                          ? "Supported"
                          : "Unsupported"}
                    </dd>
                    <dt>Reasoning API</dt>
                    <dd>
                      {info.reasoningFormat ||
                        "Not advertised (use default or explicit override)"}
                    </dd>
                    {info.workingInputBudget && (
                      <>
                        <dt>Learned input budget</dt>
                        <dd>{info.workingInputBudget.toLocaleString()}</dd>
                      </>
                    )}
                    {info.workingMaxImages != null && (
                      <>
                        <dt>Learned screenshot budget</dt>
                        <dd>{info.workingMaxImages}</dd>
                      </>
                    )}
                  </dl>
                  {(info.workingInputBudget ||
                    info.workingMaxImages != null) && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        action("reset-model-profile", async () => {
                          await api("/api/model-profile/reset", {
                            method: "POST",
                          });
                          notice("Learned limits reset");
                        })
                      }
                    >
                      Reset learned limits
                    </button>
                  )}
                  <pre>{json(info.metadata)}</pre>
                </details>
              )}
              <button
                className="button secondary"
                disabled={!!pending || !draft.model || !draft.baseUrl}
                onClick={() =>
                  action("test", async () => {
                    const result = await api<{ ok: boolean; message: string }>(
                      "/api/model/test",
                      {
                        method: "POST",
                        body: json({
                          baseUrl: draft.baseUrl,
                          model: draft.model,
                          ...(keyChanged ? { apiKey } : {}),
                        }),
                      },
                    );
                    notice(result.message);
                  })
                }
              >
                {pending === "test" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Plug size={15} />
                )}
                Test connection
              </button>
            </section>
            <section className="settings-section">
              <h2>Execution</h2>
              <div className="form-grid">
                <label className="field">
                  <span>Context window (tokens)</span>
                  <select
                    aria-label="Context source"
                    value={draft.contextMode}
                    onChange={(e) =>
                      update(
                        "contextMode",
                        e.target.value as Settings["contextMode"],
                      )
                    }
                  >
                    <option value="auto">From endpoint metadata</option>
                    <option value="manual">Manual override</option>
                  </select>
                  <input
                    type="number"
                    disabled={draft.contextMode === "auto"}
                    min="4096"
                    max="4000000"
                    value={
                      draft.contextMode === "auto"
                        ? info?.contextWindow || draft.contextWindow
                        : draft.contextWindow
                    }
                    onChange={(e) =>
                      update("contextWindow", Number(e.target.value))
                    }
                  />
                </label>
                <label className="field">
                  <span>Maximum output tokens</span>
                  <input
                    type="number"
                    min="256"
                    max="256000"
                    value={draft.maxOutputTokens}
                    onChange={(e) =>
                      update("maxOutputTokens", Number(e.target.value))
                    }
                  />
                </label>
                <label className="field">
                  <span>Reasoning</span>
                  <select
                    value={draft.reasoningEffort}
                    onChange={(e) =>
                      update(
                        "reasoningEffort",
                        e.target.value as Settings["reasoningEffort"],
                      )
                    }
                  >
                    {reasoningChoices.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Reasoning API format</span>
                  <select
                    value={draft.reasoningFormat}
                    onChange={(e) =>
                      update(
                        "reasoningFormat",
                        e.target.value as Settings["reasoningFormat"],
                      )
                    }
                  >
                    <option value="auto">From endpoint metadata</option>
                    <option value="reasoning_effort">reasoning_effort</option>
                    <option value="thinking">thinking.type (on/off)</option>
                  </select>
                </label>
                <label className="field">
                  <span>Screenshots kept in model context</span>
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={draft.maxImages}
                    onChange={(e) =>
                      update("maxImages", Number(e.target.value))
                    }
                  />
                </label>
                <label className="field">
                  <span>Model timeout (seconds)</span>
                  <input
                    type="number"
                    min="15"
                    max="1800"
                    value={draft.modelTimeoutSeconds}
                    onChange={(e) =>
                      update("modelTimeoutSeconds", Number(e.target.value))
                    }
                  />
                </label>
                <label className="field">
                  <span>Approvals</span>
                  <select
                    value={draft.approvalMode}
                    onChange={(e) =>
                      update(
                        "approvalMode",
                        e.target.value as Settings["approvalMode"],
                      )
                    }
                  >
                    <option value="never">Auto-approve</option>
                    <option value="risky">Review interactions</option>
                    <option value="always">Review every tool</option>
                  </select>
                </label>
                <label className="field">
                  <span>Step limit</span>
                  <input
                    type="number"
                    min="1"
                    max="200"
                    value={draft.maxSteps}
                    onChange={(e) => update("maxSteps", Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="toggle-row">
                <span>Stream responses & reasoning</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={draft.stream}
                  onChange={(e) => update("stream", e.target.checked)}
                />
                <span className="switch" aria-hidden="true" />
              </label>
              <label className="toggle-row">
                <span>Send screenshots to model</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={draft.vision}
                  onChange={(e) => update("vision", e.target.checked)}
                />
                <span className="switch" aria-hidden="true" />
              </label>
            </section>
          </>
        ) : page === "instructions" ? (
          <section className="settings-section">
            <div className="section-heading">
              <h2>System instructions</h2>
              <button
                className="text-button"
                onClick={() => update("systemPrompt", DEFAULT_PROMPT)}
              >
                <RefreshCw size={13} />
                Reset
              </button>
            </div>
            <textarea
              className="instructions-editor"
              aria-label="Agent system instructions"
              spellCheck={false}
              value={draft.systemPrompt}
              onChange={(e) => update("systemPrompt", e.target.value)}
            />
          </section>
        ) : page === "tools" ? (
          <>
            <section className="settings-section">
              <div className="section-heading">
                <h2>Browser tools</h2>
                <button
                  className="text-button"
                  onClick={() => update("disabledTools", [])}
                >
                  Enable all
                </button>
              </div>
              <input
                className="tool-search"
                aria-label="Filter tools"
                placeholder="Filter tools…"
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
              />
              <div className="tool-list">
                {state.tools
                  .filter((t) =>
                    (t.name + " " + t.description)
                      .toLowerCase()
                      .includes(toolSearch.toLowerCase()),
                  )
                  .map((tool) => (
                    <div className="tool-row" key={tool.name}>
                      <label className="tool-toggle" title={tool.description}>
                        <input
                          type="checkbox"
                          aria-label={`Enable ${tool.name}`}
                          checked={!draft.disabledTools.includes(tool.name)}
                          onChange={(e) =>
                            update(
                              "disabledTools",
                              e.target.checked
                                ? draft.disabledTools.filter(
                                    (n) => n !== tool.name,
                                  )
                                : [...draft.disabledTools, tool.name],
                            )
                          }
                        />
                        <span className="switch" aria-hidden="true" />
                      </label>
                      <details className="tool-definition">
                        <summary>
                          <code>{tool.name}</code>
                          <span className={`risk-tag ${tool.risk}`}>
                            {tool.risk === "read"
                              ? "Read"
                              : tool.risk === "write"
                                ? "Interact"
                                : "Advanced"}
                          </span>
                        </summary>
                        <p>{tool.description}</p>
                        <pre>{json(tool.parameters)}</pre>
                      </details>
                    </div>
                  ))}
              </div>
            </section>
            <section className="settings-section">
              <div className="section-heading">
                <h2>Custom tools</h2>
                <button className="text-button" onClick={addExample}>
                  Add example
                </button>
              </div>
              <textarea
                className="json-editor"
                aria-label="Custom tool definitions JSON"
                spellCheck={false}
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
              />
              <details className="format-help">
                <summary>Tool format</summary>
                <p>
                  Define a name, description, parameters, enabled, approval, and
                  handler. JavaScript handlers run in the selected page with{" "}
                  <code>args</code>. HTTP handlers accept a URL, method, and
                  optional headers. Auto-approve skips tool approval prompts.
                </p>
              </details>
            </section>
          </>
        ) : (
          <section className="settings-section">
            <div className="section-heading">
              <h2>Chrome connection</h2>
              <span className="connection-state">
                <i
                  className={`status-dot ${state.bridge.connected ? "completed" : "offline"}`}
                />
                {state.bridge.connected ? "Connected" : "Disconnected"}
              </span>
            </div>
            {state.bridge.connected && (
              <p className="connection-count">
                {state.bridge.tabs.length} tabs
              </p>
            )}
            <details
              className="connection-setup"
              open={!state.bridge.connected}
            >
              <summary>
                {state.bridge.connected
                  ? "Pair another browser"
                  : "Install and pair"}
              </summary>
              <ol className="setup-steps">
                <li>
                  <strong>Load extension</strong>
                  <p>
                    Open{" "}
                    <button
                      className="inline-code"
                      onClick={() => copy("chrome://extensions")}
                    >
                      chrome://extensions
                    </button>
                    . Turn on Developer mode, click Load unpacked, and select:
                  </p>
                  {fieldCopy(
                    "extension folder",
                    pairing?.extensionPath || "Loading…",
                  )}
                </li>
                <li>
                  <strong>Connect to Relay</strong>
                  <p>Open the Relay extension and paste these values.</p>
                  <label>Server address</label>
                  {fieldCopy(
                    "server address",
                    pairing?.serverUrl || "Loading…",
                  )}
                  <label>Pairing token</label>
                  <div className="copy-field">
                    <input
                      type="password"
                      aria-label="Pairing token"
                      readOnly
                      value={pairing?.token || ""}
                    />
                    <button
                      className="icon-button"
                      aria-label="Copy pairing token"
                      onClick={() => pairing && copy(pairing.token)}
                    >
                      <Clipboard size={15} />
                    </button>
                  </div>
                  <button
                    className="text-button"
                    disabled={!!pending || !!state.activeRunId}
                    onClick={() =>
                      action("pairing", async () => {
                        setPairing(
                          await api<Pairing>("/api/pairing/rotate", {
                            method: "POST",
                          }),
                        );
                        notice("Token replaced. Pair the extension again.");
                      })
                    }
                  >
                    Replace token
                  </button>
                </li>
              </ol>
            </details>
          </section>
        )}
      </div>
    </section>
  );
}
