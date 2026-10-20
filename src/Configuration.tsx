import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  Check,
  Clipboard,
  Code2,
  Eye,
  FileText,
  LoaderCircle,
  Plug,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type { AppState, CustomTool, Settings } from "../shared/types";
import { DEFAULT_PROMPT } from "../shared/defaults";
import { api, json, type Action, type Page, type Pairing } from "./ui";
const customExample: CustomTool[] = [
  {
    name: "page_heading",
    description: "Read the current page heading.",
    enabled: true,
    approval: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: {
      type: "javascript",
      code: 'return { heading: document.querySelector("h1")?.textContent ?? "No heading" };',
    },
  },
];
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
  const [showKey, setShowKey] = useState(false);
  const connected = state.bridge.connected;
  return (
    <div className="settings-page">
      <button className="back-link" onClick={() => setPage("workbench")}>
        <ArrowLeft size={15} />
        Back to workbench
      </button>
      <div className="settings-heading">
        <div>
          <h1>
            {
              {
                connection: "Connect your Chrome.",
                settings: "Your model. Your choice.",
                instructions: "Give your agent direction.",
                tools: "Decide what Relay can do.",
              }[page]
            }
          </h1>
          <p>
            {
              {
                connection: "A local bridge to the browser you already use.",
                settings:
                  "Connect any endpoint that supports OpenAI chat completions and tool calling.",
                instructions:
                  "These instructions guide every new task. Make them your own.",
                tools:
                  "Enable browser capabilities and define your own tools with explicit schemas.",
              }[page]
            }
          </p>
        </div>
        {page !== "connection" && (
          <button
            className="button primary"
            disabled={!!pending}
            onClick={saveSettings}
          >
            {pending === "save" ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}
            Save changes
          </button>
        )}
      </div>
      {page === "connection" ? (
        <div className="connection-layout">
          <div className="configuration-panel">
            <div className="connection-status">
              <span
                className={`connection-symbol ${connected ? "connected" : ""}`}
              >
                {connected ? <Check size={24} /> : <Plug size={24} />}
              </span>
              <div>
                <h2>
                  {connected ? "Chrome is connected" : "Connect the extension"}
                </h2>
                <p>
                  {connected
                    ? `${state.bridge.tabs.length} tabs are available to Relay.`
                    : "The extension connects your browser to the local Relay server."}
                </p>
              </div>
              <span
                className={`status-pill ${connected ? "completed" : "stopped"}`}
              >
                {connected ? "Online" : "Not connected"}
              </span>
            </div>
            <ol className="setup-steps">
              <li>
                <span className="step-number">1</span>
                <div>
                  <h3>Load the Chrome extension</h3>
                  <p>
                    Open{" "}
                    <button
                      className="inline-code"
                      onClick={() => copy("chrome://extensions")}
                    >
                      chrome://extensions <Clipboard size={12} />
                    </button>
                    , enable <strong>Developer mode</strong>, then choose{" "}
                    <strong>Load unpacked</strong>. Select this folder:
                  </p>
                  <div className="copy-field">
                    <code>
                      {pairing?.extensionPath || "Loading extension path…"}
                    </code>
                    <button
                      className="icon-button"
                      aria-label="Copy extension folder"
                      disabled={!pairing}
                      onClick={() => copy(pairing!.extensionPath)}
                    >
                      <Clipboard size={16} />
                    </button>
                  </div>
                </div>
              </li>
              <li>
                <span className="step-number">2</span>
                <div>
                  <h3>Pair with this workspace</h3>
                  <p>
                    Open the Relay extension in Chrome. Enter the local server
                    address and pairing token below.
                  </p>
                  <label className="field-label">Server address</label>
                  <div className="copy-field">
                    <code>{pairing?.serverUrl || "Loading…"}</code>
                    <button
                      className="icon-button"
                      aria-label="Copy server address"
                      disabled={!pairing}
                      onClick={() => copy(pairing!.serverUrl)}
                    >
                      <Clipboard size={16} />
                    </button>
                  </div>
                  <label className="field-label">Pairing token</label>
                  <div className="copy-field token-field">
                    <code>{pairing?.token || "Loading…"}</code>
                    <button
                      className="icon-button"
                      aria-label="Copy pairing token"
                      disabled={!pairing}
                      onClick={() => copy(pairing!.token)}
                    >
                      <Clipboard size={16} />
                    </button>
                  </div>
                  <button
                    className="text-button rotate-button"
                    disabled={!!pending}
                    onClick={() =>
                      action("pairing", async () => {
                        setPairing(
                          await api<Pairing>("/api/pairing/rotate", {
                            method: "POST",
                          }),
                        );
                        notice(
                          "New pairing token created. Pair your Chrome extension again.",
                        );
                      })
                    }
                  >
                    <RefreshCw size={13} />
                    Generate a new token
                  </button>
                </div>
              </li>
              <li>
                <span className="step-number">3</span>
                <div>
                  <h3>Choose a tab and start a task</h3>
                  <p>
                    Keep the extension connected. Return to the workbench,
                    choose a normal webpage, and tell Relay what you want done.
                  </p>
                  <button
                    className="button secondary"
                    onClick={() => setPage("workbench")}
                  >
                    Open workbench
                    <ArrowRight size={15} />
                  </button>
                </div>
              </li>
            </ol>
          </div>
          <aside className="settings-aside">
            <ShieldCheck size={28} />
            <h3>Your sessions stay yours.</h3>
            <p>
              The extension works in your existing Chrome profile, with your
              open tabs and signed-in sessions.
            </p>
            <p>
              Chrome's protected pages, its settings, and native dialogs need
              your direct interaction.
            </p>
            <div className="aside-rule" />
            <h4>Keep the server local</h4>
            <p>
              Your pairing token authorizes browser access. Treat it as a secret
              and share it only with your own extension.
            </p>
          </aside>
        </div>
      ) : page === "settings" ? (
        <div className="configuration-panel">
          <div className="form-section">
            <h2>
              <SlidersHorizontal size={19} />
              Model connection
            </h2>
            <div className="form-grid">
              <label className="field full">
                <span>API base URL</span>
                <input
                  type="url"
                  value={draft.baseUrl}
                  onChange={(e) => update("baseUrl", e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
                <small>
                  Use the base URL ending in /v1 when required by your provider.
                </small>
              </label>
              <label className="field">
                <span>Model</span>
                <input
                  value={draft.model}
                  onChange={(e) => update("model", e.target.value)}
                  placeholder="Your provider's model ID"
                />
                <small>The model must support tool calling.</small>
              </label>
              <label className="field">
                <span>
                  API key{" "}
                  <span className="optional">
                    {state.hasApiKey
                      ? "Saved for this server session"
                      : "Optional for local endpoints"}
                  </span>
                </span>
                <div className="password-field">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      state.hasApiKey
                        ? "Enter a replacement key"
                        : "Enter API key"
                    }
                    autoComplete="off"
                  />
                  <button
                    className="icon-button"
                    aria-label={showKey ? "Hide API key" : "Show API key"}
                    onClick={() => setShowKey(!showKey)}
                  >
                    <Eye size={16} />
                  </button>
                </div>
                <small>
                  Held in server memory. Re-enter after a server restart.
                </small>
                {state.hasApiKey && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setApiKey("");
                      notice("API key will be cleared when you save changes.");
                    }}
                  >
                    Clear stored key
                  </button>
                )}
              </label>
            </div>
            <button
              className="button secondary"
              disabled={!!pending || !draft.baseUrl || !draft.model}
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
                  if (!result.ok) throw new Error(result.message);
                  notice(result.message || "Model connection verified.");
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
          </div>
          <div className="form-section">
            <h2>
              <ShieldCheck size={19} />
              Run behavior
            </h2>
            <div className="form-grid">
              <label className="field">
                <span>Action approvals</span>
                <select
                  value={draft.approvalMode}
                  onChange={(e) =>
                    update(
                      "approvalMode",
                      e.target.value as Settings["approvalMode"],
                    )
                  }
                >
                  <option value="risky">Ask before sensitive actions</option>
                  <option value="always">Ask before every action</option>
                  <option value="never">Run without approval prompts</option>
                </select>
                <small>Review actions inline in the task activity.</small>
              </label>
              <label className="field">
                <span>Maximum steps per task</span>
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={draft.maxSteps}
                  onChange={(e) => update("maxSteps", Number(e.target.value))}
                />
                <small>A limit on model turns, including tool use.</small>
              </label>
            </div>
            <label className="toggle-row">
              <span>
                <strong>Include browser screenshots in model context</strong>
                <small>
                  Enable when your chosen model accepts image inputs.
                </small>
              </span>
              <input
                type="checkbox"
                checked={draft.vision}
                onChange={(e) => update("vision", e.target.checked)}
              />
              <span className="switch" aria-hidden="true" />
            </label>
          </div>
        </div>
      ) : page === "instructions" ? (
        <div className="configuration-panel instructions-panel">
          <div className="editor-toolbar">
            <span>
              <FileText size={16} />
              System instructions
            </span>
            <button
              className="text-button"
              onClick={() => update("systemPrompt", DEFAULT_PROMPT)}
            >
              <RefreshCw size={14} />
              Restore default
            </button>
          </div>
          <textarea
            className="instructions-editor"
            aria-label="Agent system instructions"
            value={draft.systemPrompt}
            onChange={(e) => update("systemPrompt", e.target.value)}
            spellCheck={false}
          />
          <div className="editor-note">
            <ShieldCheck size={16} />
            <p>
              Describe what the agent should do, when it should ask you, and how
              it should verify results. Webpage content is untrusted input.
              These instructions are sent to your model with each new task.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="configuration-panel tool-catalog">
            <div className="catalog-heading">
              <div>
                <h2>Browser tools</h2>
                <p>
                  {
                    state.tools.filter(
                      (tool) => !draft.disabledTools.includes(tool.name),
                    ).length
                  }{" "}
                  of {state.tools.length} tools enabled
                </p>
              </div>
              <button
                className="text-button"
                onClick={() => update("disabledTools", [])}
              >
                Enable all
              </button>
            </div>
            {state.tools.map((tool) => (
              <div className="tool-row" key={tool.name}>
                <label className="tool-toggle">
                  <input
                    type="checkbox"
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
                  <span>
                    <strong>{tool.name}</strong>
                    <small>{tool.description}</small>
                  </span>
                </label>
                <span className={`risk-tag ${tool.risk}`}>
                  {tool.risk === "read"
                    ? "Read"
                    : tool.risk === "write"
                      ? "Interact"
                      : "Sensitive"}
                </span>
                <details className="tool-schema">
                  <summary aria-label={`Schema for ${tool.name}`}>
                    <Braces size={16} />
                  </summary>
                  <pre>{json(tool.parameters)}</pre>
                </details>
              </div>
            ))}
          </div>
          <div className="configuration-panel custom-tools">
            <div className="editor-toolbar">
              <span>
                <Code2 size={17} />
                Custom tools
              </span>
              <button
                className="text-button"
                onClick={() => setCustomText(json(customExample))}
              >
                Insert example
              </button>
            </div>
            <p className="custom-description">
              Define tools as a JSON array. JavaScript tools run in the current
              page; HTTP tools call your chosen endpoint. Set{" "}
              <code>approval: true</code> to require your approval.
            </p>
            <textarea
              className="json-editor"
              aria-label="Custom tool definitions JSON"
              spellCheck={false}
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
            />
            <div className="editor-note">
              <Braces size={16} />
              <p>
                Each tool needs a name, description, JSON Schema parameters,
                enabled and approval flags, and a handler. Use the example as a
                starting point. Saving validates the definition.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
