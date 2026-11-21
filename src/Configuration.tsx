import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import changelog from "../CHANGELOG.md?raw";
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  Cpu,
  Eye,
  EyeOff,
  LayoutGrid,
  LoaderCircle,
  Minus,
  Palette,
  Plug,
  Plus,
  RotateCcw,
  ScrollText,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { AppState, ModelInfo, Settings } from "../shared/types";
import { DEFAULT_PROMPT, MAX_STEP_LIMIT } from "../shared/defaults";
import WebSearchSettings, { useSearchKey } from "./WebSearchSettings";
import BackupSettings from "./BackupSettings";
import ModelChecklist from "./ModelChecklist";
import ModelPicker from "./ModelPicker";
import ModelAbilities from "./ModelAbilities";
import { ModelDetails } from "./ModelFacts";
import Tooltip from "./Tooltip";
import { ToolDetails, approvalNote, riskExplanation, riskLabel } from "./toolInfo";
import ShortcutsEditor from "./ShortcutsEditor";
import SiteRules from "./SiteRules";
import { useShortcutsEditor } from "./shortcuts";
import { useModelVisibility } from "./modelVisibility";
import VoiceSettings, { useVoiceSettings } from "./VoiceSettings";
import ChoiceMenu from "./ChoiceMenu";
import { LANGUAGE_NAMES, useLanguage, useT, type LanguagePreference } from "./i18n";
import { json, toolTitle, type Action, type Page, type SettingsPage, type SettingsSection } from "./ui";
import ThemeSettings from "./ThemeSettings";
import McpSettings from "./McpSettings";
import { paletteById } from "./palettes";
import type { Appearance } from "./theme";

type Props = {
  appearance: Appearance;
  providerName: string;
  setProviderName: (name: string) => void;
  changeProvider: (id: string, model?: string) => Promise<void>;
  state: AppState;
  draft: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  page: SettingsPage;
  setPage: (page: Page) => void;
  pending: string;
  action: Action;
  saveSettings: (saveVoice?: () => Promise<void>) => Promise<unknown>;
  apiKey: string;
  setApiKey: (value: string) => void;
  keyChanged: boolean;
  notice: (value: string) => void;
  /** Lets the app warn before leaving with unsaved prompts, voice or model-list changes, and save them. */
  reportUnsaved: (unsaved: boolean, save: () => Promise<void>) => void;
};

type Section = { id: SettingsSection; title: string; about: string; Icon: typeof Cpu };
/** Settings, grouped by what the user is deciding: what Rove thinks with, how it acts, what it
 *  connects to, and how it looks. Each section is its own page under the overview. */
const SECTIONS: Section[][] = [
  [
    { id: "model", title: "Model", about: "The AI provider and model Rove thinks with.", Icon: Cpu },
    { id: "instructions", title: "Instructions", about: "What Rove is told in every chat, and the prompts you reuse.", Icon: ScrollText },
  ],
  [
    { id: "browsing", title: "Browsing", about: "How Rove works in your tabs, and how long a task may run.", Icon: Compass },
    { id: "tools", title: "Tools and sites", about: "Which browser tools Rove may use, and rules for particular sites.", Icon: ShieldCheck },
  ],
  [
    { id: "search", title: "Search and voice", about: "Web search for up-to-date answers, and speech to text for dictating.", Icon: Search },
    { id: "apps", title: "Connected apps", about: "Let Claude Code and other MCP apps use Rove.", Icon: Plug },
  ],
  [
    { id: "appearance", title: "Appearance", about: "Theme, light or dark, and language.", Icon: Palette },
    { id: "backup", title: "Backup", about: "Move your setup to another Chrome profile, or keep a copy.", Icon: Archive },
  ],
];
const ALL_SECTIONS = SECTIONS.flat();
/** Saved settings each section edits, to mark sections with unsaved changes. */
const SECTION_KEYS: Partial<Record<SettingsSection, (keyof Settings)[]>> = {
  model: ["baseUrl", "model", "reasoningEffort", "contextWindow", "maxOutputTokens", "maxImages", "vision", "stream", "modelTimeoutSeconds"],
  instructions: ["systemPrompt", "memory"],
  browsing: ["maxSteps", "backgroundTabs", "groupTabs", "keepGoingOnBarClose"],
  tools: ["disabledTools", "siteRules"],
  search: ["webSearch"],
  apps: ["mcpEnabled", "mcpBrowserTools", "mcpRunTasks"],
};
const SEARCH_NAMES = { exa: "Exa", tavily: "Tavily", parallel: "Parallel" } as const;

/** Fills a translated template's {placeholders} with elements, so a sentence can hold links. */
function fill(template: string, parts: Record<string, ReactNode>) {
  return template.split(/(\{\w+\})/).map((piece, index) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={index}>{name && name in parts ? parts[name] : piece}</Fragment>;
  });
}
/** "anthropic/claude-sonnet-4" reads as "claude-sonnet-4". */
const shortModel = (id: string) => id.split("/").pop() || id;

export default function Configuration({
  appearance,
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
  reportUnsaved,
}: Props) {
  const t = useT();
  const { preference, setPreference } = useLanguage();
  const [showKey, setShowKey] = useState(false);
  const voice = useVoiceSettings();
  const visibility = useModelVisibility(state.activeProviderId);
  const shortcuts = useShortcutsEditor();
  const [listed, setListed] = useState<ModelInfo[]>([]);
  const search = useSearchKey(draft);
  const saveLocal = async () => { await voice.save(); await visibility.save(); await shortcuts.save(); await search.save(); };
  const localUnsaved = voice.dirty || visibility.touched || shortcuts.touched || search.dirty;
  useEffect(() => reportUnsaved(localUnsaved, saveLocal));
  useEffect(() => () => reportUnsaved(false, async () => {}), []);
  const [toolSearch, setToolSearch] = useState("");
  const whatsNew = useRef<HTMLDialogElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // A new section starts at its top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [page]);
  const selectedInfo =
    (state.modelInfo?.id === draft.model && state.settings.baseUrl === draft.baseUrl ? state.modelInfo : undefined) ??
    listed.find((info) => info.id === draft.model);
  // Any listed model can be inspected; the chat's own model is the starting point.
  const [inspected, setInspected] = useState("");
  useEffect(() => setInspected(""), [state.activeProviderId, draft.baseUrl]);
  const inspectedInfo = (inspected !== draft.model && listed.find((info) => info.id === inspected)) || selectedInfo;
  const keepListed = (saved: ModelInfo | null) => {
    if (saved)
      setListed((models) =>
        models.map((info) => (info.id === saved.id ? { ...saved, providerId: info.providerId, providerName: info.providerName } : info)),
      );
  };
  const enabledCount = state.tools.length - draft.disabledTools.length;
  const tools = state.tools.filter((tool) =>
    (tool.name + tool.description)
      .toLowerCase()
      .includes(toolSearch.toLowerCase()),
  );
  const groups = (["read", "write", "danger"] as const)
    .map((risk) => ({ risk, items: tools.filter((tool) => tool.risk === risk) }))
    .filter((group) => group.items.length);

  const savedProviderName = state.providers.find((provider) => provider.id === state.activeProviderId)?.name ?? "";
  const unsaved = (id: SettingsSection) => {
    const changed = (SECTION_KEYS[id] ?? []).some((key) => JSON.stringify(draft[key]) !== JSON.stringify(state.settings[key]));
    if (id === "model") return changed || keyChanged || visibility.touched || providerName !== savedProviderName;
    if (id === "instructions") return changed || shortcuts.touched;
    if (id === "search") return changed || search.dirty || voice.dirty;
    return changed;
  };

  // One short line per section, saying how it is set now.
  const modelName = draft.model ? (selectedInfo?.name || shortModel(draft.model)) : "";
  const ruleCount = draft.siteRules.length;
  const rulesText = ruleCount === 0 ? t("no site rules") : ruleCount === 1 ? t("1 site rule") : t("{n} site rules", { n: ruleCount });
  const promptCount = shortcuts.items.length;
  const promptsText = promptCount === 0 ? t("no saved prompts") : promptCount === 1 ? t("1 saved prompt") : t("{n} saved prompts", { n: promptCount });
  const toolsText = t("{n} of {total} tools", { n: enabledCount, total: state.tools.length });
  const modeText = appearance.preference === "system" ? t("matches Chrome") : appearance.mode === "dark" ? (appearance.black ? t("pitch black") : t("dark")) : t("light");
  const mcp = state.mcp;
  const summaries: Record<SettingsSection, string> = {
    model: draft.model ? t("{model} on {provider}", { model: modelName, provider: providerName || savedProviderName }) : t("No model connected yet"),
    instructions: t("{instructions}, {prompts}", {
      instructions: draft.systemPrompt === DEFAULT_PROMPT ? t("Default instructions") : t("Custom instructions"),
      prompts: promptsText,
    }),
    browsing: t("{steps}, {tabs}", {
      steps: draft.maxSteps === 0 ? t("No step limit") : t("Up to {n} steps", { n: draft.maxSteps }),
      tabs: draft.backgroundTabs ? t("in background tabs") : t("in the tab in front"),
    }),
    tools: t("{tools}, {rules}", { tools: toolsText, rules: rulesText }),
    search: t("{search}, {voice}", {
      search: draft.webSearch === "off" ? t("Web search off") : t("Search with {name}", { name: SEARCH_NAMES[draft.webSearch] }),
      voice: voice.value.backend === "web" ? t("dictation by Chrome") : t("dictation by your API"),
    }),
    apps: !state.settings.mcpEnabled
      ? t("Off")
      : mcp?.connected
        ? t("Connected: {apps}", { apps: mcp.clients.join(", ") || t("an MCP app") })
        : t("On, waiting for an app"),
    appearance: t("{theme}, {mode}", { theme: paletteById(appearance.palette).name, mode: modeText }),
    backup: t("Export or restore your setup"),
  };

  const go = (id: SettingsPage) => () => setPage(id);
  const link = (id: SettingsSection, text: string) => (
    <button type="button" className="readout-link" onClick={go(id)}>{text}</button>
  );
  const readout = (
    <p className="settings-readout">
      {draft.model
        ? fill(t("Rove thinks with {model} on {provider}."), { model: link("model", modelName), provider: link("model", providerName || savedProviderName) })
        : fill(t("Rove needs a model before it can work: {connect}."), { connect: link("model", t("connect one")) })}{" "}
      {fill(t("It works {tabs} and may use {tools}."), {
        tabs: link("browsing", draft.backgroundTabs ? t("in background tabs") : t("in the tab in front")),
        tools: link("tools", toolsText),
      })}
      {ruleCount > 0 && <>{" "}{fill(t("You set {rules}."), { rules: link("tools", rulesText) })}</>}
      {state.settings.mcpEnabled && mcp?.connected && <>{" "}{fill(t("{apps} can use it too."), { apps: link("apps", mcp.clients.join(", ") || t("an MCP app")) })}</>}
    </p>
  );

  const current = ALL_SECTIONS.find((section) => section.id === page);
  const toggleRows = (rows: readonly (readonly [keyof Settings, string, string])[]) =>
    rows.map(([key, title, note]) => (
      <div className="tool-row behavior-row" key={key}>
        <div className="behavior-text">
          <strong>{title}</strong>
          <small>{note}</small>
        </div>
        <label className="tool-toggle">
          <input
            type="checkbox"
            role="switch"
            aria-label={title}
            checked={draft[key] as boolean}
            onChange={(e) => update(key, e.target.checked as never)}
          />
          <span className="switch" aria-hidden="true" />
        </label>
      </div>
    ));

  function body(id: SettingsSection) {
    switch (id) {
      case "model":
        return (
          <>
            <h2 className="settings-title">{t("Provider")}</h2>
            <div className="panel provider-panel">
              <div className="provider-picker-row">
                <ChoiceMenu label={t("Configure provider")} value={state.activeProviderId} options={[
                  ...state.providers.map(provider => ({ value: provider.id, label: provider.name })),
                  { value: "add:openrouter", label: t("+ Add OpenRouter") },
                  { value: "add:gemini", label: t("+ Add Google AI Studio (Gemini)") },
                  { value: "add:vertex", label: t("+ Add Vertex AI (Gemini)") },
                  { value: "add:custom", label: t("+ Add compatible provider") },
                ]} onChange={id => void changeProvider(id)} disabled={!!pending || !!state.activeRunId} />
                <button type="button" className="icon-button" aria-label={t("Remove provider")} title={t("Remove provider")} disabled={!!pending || !!state.activeRunId || state.providers.length < 2} onClick={() => void changeProvider("remove")}><Trash2 size={15} /></button>
              </div>
              <label className="field"><span>{t("Provider name")}</span><input value={providerName} maxLength={80} onChange={event => setProviderName(event.target.value)} /></label>
              <label className="field">
                <span>{t("API base URL")}</span>
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
                  {t("API key")}{" "}
                  {state.hasApiKey && (
                    <span className="field-state">
                      <Check size={12} /> {t("Saved")}
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
                    placeholder={state.hasApiKey ? t("Saved key · enter to replace") : t("Enter API key")}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={showKey ? t("Hide API key") : t("Show API key")}
                    onClick={() => setShowKey(!showKey)}
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <div className="field-footer">
                  <span>{t("Saved in this Chrome profile across sessions.")}</span>
                  {state.hasApiKey && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        setApiKey("");
                        notice("Save changes to clear the key.");
                      }}
                    >
                      {t("Clear key")}
                    </button>
                  )}
                </div>
              </div>
            </div>
            <h2 className="settings-title">{t("Models")}</h2>
            <div className="panel model-panel">
              <div className="field model-connection-field">
                <span>{t("Models in chat")}</span>
                <ModelChecklist
                  providerId={state.activeProviderId}
                  connection={{
                    baseUrl: draft.baseUrl,
                    ...(keyChanged ? { apiKey } : {}),
                  }}
                  model={draft.model}
                  onModels={setListed}
                  visibility={visibility}
                  onFirstPick={(model) => {
                    update("model", model);
                    update("reasoningEffort", "default");
                  }}
                />
              </div>
              {listed.length > 1 && (
                <div className="model-inspect">
                  <span>{t("Details for")}</span>
                  <ModelPicker
                    model={inspectedInfo?.id ?? draft.model}
                    label={inspectedInfo?.name}
                    choices={listed}
                    ariaLabel={t("Model to inspect")}
                    placement="bottom"
                    onSelect={(id) => setInspected(id)}
                  />
                  {inspectedInfo && inspectedInfo.id !== draft.model && (
                    <button type="button" className="text-button" onClick={() => setInspected("")}>
                      {t("Show the chat model")}
                    </button>
                  )}
                </div>
              )}
              {inspectedInfo ? (
                <>
                  <ModelDetails model={inspectedInfo} />
                  <ModelAbilities model={inspectedInfo} endpoint={draft.baseUrl} onSaved={keepListed} />
                </>
              ) : (
                <p className="abilities-note model-abilities-empty">
                  {draft.model
                    ? t("Model abilities and details appear once the endpoint lists {model}.", { model: draft.model })
                    : t("Choose a model above to see its abilities and what the endpoint reports.")}
                </p>
              )}
            </div>
          </>
        );
      case "instructions":
        return (
          <>
            <div className="settings-heading">
              <h2 className="settings-title">{t("System instructions")}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label={t("Reset instructions")}
                title={t("Reset instructions")}
                onClick={() => update("systemPrompt", DEFAULT_PROMPT)}
              >
                <RotateCcw size={16} />
              </button>
            </div>
            <div className="panel editor-panel">
              <textarea
                aria-label={t("System instructions")}
                className="instructions-editor"
                value={draft.systemPrompt}
                onChange={(e) => update("systemPrompt", e.target.value)}
                spellCheck={false}
              />
            </div>
            <h2 className="settings-title">{t("Standing instructions")}</h2>
            <div className="panel memory-panel">
              <textarea
                aria-label={t("Standing instructions")}
                className="instructions-editor memory-editor"
                placeholder={t("Things Rove should always know or follow, in every chat.")}
                value={draft.memory}
                onChange={(e) => update("memory", e.target.value)}
                spellCheck={false}
              />
            </div>
            <ShortcutsEditor editor={shortcuts} />
          </>
        );
      case "browsing":
        return (
          <>
            <h2 className="settings-title">{t("Steps per task")}</h2>
            <div className="panel steps-panel">
              <div className="tool-round-limit">
                <label htmlFor="step-limit">{t("Step limit")}</label>
                <div className="stepper">
                  <button type="button" className="icon-button" aria-label={t("Fewer steps")} disabled={!!state.activeRunId || draft.maxSteps === 1} onClick={() => update("maxSteps", draft.maxSteps === 0 ? MAX_STEP_LIMIT : Math.max(1, draft.maxSteps - 1))}><Minus size={14} /></button>
                  <input
                    id="step-limit"
                    type="text"
                    inputMode="numeric"
                    aria-describedby="step-limit-note"
                    value={draft.maxSteps === 0 ? "∞" : String(draft.maxSteps)}
                    disabled={!!state.activeRunId}
                    onChange={(event) => {
                      const digits = event.target.value.replace(/\D/g, "");
                      if (!digits) return;
                      const steps = Number(digits);
                      // Past the highest number the limit turns off.
                      update("maxSteps", steps > MAX_STEP_LIMIT ? 0 : Math.max(1, steps));
                    }}
                  />
                  <button type="button" className="icon-button" aria-label={draft.maxSteps === MAX_STEP_LIMIT ? t("No step limit") : t("More steps")} disabled={!!state.activeRunId || draft.maxSteps === 0} onClick={() => update("maxSteps", draft.maxSteps >= MAX_STEP_LIMIT ? 0 : draft.maxSteps + 1)}><Plus size={14} /></button>
                </div>
              </div>
              <p className="step-limit-note" id="step-limit-note">
                {draft.maxSteps === 0
                  ? t("No limit: a task runs until it finishes or you stop it.")
                  : t("Up to {max} steps per task. Go past {max} to remove the limit.", { max: MAX_STEP_LIMIT })}
              </p>
            </div>
            <h2 className="settings-title">{t("Tabs")}</h2>
            <div className="panel behavior-panel">
              {toggleRows([
                ["backgroundTabs", t("Work in the background"), t("Rove opens and drives its tabs without switching to them, so you can keep using Chrome. Turn this off if a page only works while it is in front.")],
                ["groupTabs", t("Group Rove's tabs"), t("Tabs Rove opens go into one Chrome tab group per task, so you can see them and close them together.")],
                ["keepGoingOnBarClose", t("Keep going if I close Chrome's debugging bar"), t("An extension cannot hide that bar. If you close it, Rove reconnects at its next action and the bar returns. Turn this off to stop the task instead.")],
              ] as const)}
            </div>
          </>
        );
      case "tools":
        return (
          <>
            <div className="settings-heading">
              <h2 className="settings-title">{t("Browser tools")}</h2>
              <span className="tool-count-wrap">
                <span className="tool-count" aria-label={t("{n} of {total} enabled", { n: enabledCount, total: state.tools.length })}>
                  <strong>{enabledCount}</strong>/{state.tools.length}
                </span>
                <Tooltip label={t("About tool switches")}>
                  <p>{t("Tools the model can use. A tool you turn off is hidden from the model completely.")}</p>
                </Tooltip>
              </span>
            </div>
            <input
              type="search"
              className="tool-search"
              aria-label={t("Search tools")}
              placeholder={t("Find a tool…")}
              value={toolSearch}
              onChange={(e) => setToolSearch(e.target.value)}
            />
            {groups.map(({ risk, items }) => (
              <div className="tool-group" key={risk}>
                <h3 className={`tool-group-title ${risk}`}>
                  {riskLabel(risk, t)}
                  <Tooltip label={t("About {name}", { name: riskLabel(risk, t) })}>
                    <p>{riskExplanation(risk, t)}</p>
                    <p>{approvalNote(risk, t)}</p>
                  </Tooltip>
                </h3>
                <div className="panel tools-list">
                  {items.map((tool) => (
                    <div className="tool-row" key={tool.name}>
                      <div className="tool-definition">
                        <details>
                          <summary>
                            <strong>{toolTitle(tool.name, {}, t)}</strong>
                          </summary>
                          <p>{tool.description}</p>
                          <pre>{json({ name: tool.name, parameters: tool.parameters })}</pre>
                        </details>
                      </div>
                      <Tooltip label={t("About {name}", { name: toolTitle(tool.name, {}, t) })} width={320}>
                        <ToolDetails tool={tool} t={t} />
                      </Tooltip>
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
                                ? draft.disabledTools.filter((name) => name !== tool.name)
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
          </>
        );
      case "search":
        return (
          <>
            <WebSearchSettings state={state} draft={draft} update={update} search={search} />
            <VoiceSettings voice={voice} />
          </>
        );
      case "apps":
        return <McpSettings state={state} draft={draft} update={update} />;
      case "appearance":
        return (
          <>
            <ThemeSettings appearance={appearance} />
            <h2 className="settings-title">{t("Language")}</h2>
            <div className="panel language-panel">
              <div className="field language-field">
                <span>{t("Language of Rove's screens")}</span>
                <ChoiceMenu
                  label={t("Language")}
                  value={preference}
                  options={[
                    { value: "auto", label: t("Match Chrome") },
                    ...(Object.entries(LANGUAGE_NAMES) as [string, string][]).map(([value, label]) => ({ value, label })),
                  ]}
                  onChange={(value) => setPreference(value as LanguagePreference)}
                />
              </div>
            </div>
          </>
        );
      case "backup":
        return <BackupSettings busy={!!state.activeRunId} />;
    }
  }

  const sectionButton = (section: Section, variant: "rail" | "row") => {
    const dirty = unsaved(section.id);
    const summaryId = `settings-summary-${section.id}`;
    return (
      <button
        type="button"
        key={section.id}
        className={variant === "rail" ? "rail-item" : "settings-row"}
        aria-current={page === section.id ? "page" : undefined}
        aria-label={t(section.title)}
        aria-describedby={variant === "row" ? summaryId : undefined}
        onClick={go(section.id)}
      >
        <span className="row-icon" aria-hidden="true"><section.Icon size={variant === "rail" ? 15 : 17} /></span>
        <span className="row-text">
          <span className="row-title">{t(section.title)}</span>
          {variant === "row" && <span className="row-summary" id={summaryId}>{summaries[section.id]}</span>}
        </span>
        {dirty && <span className="row-dirty" title={t("Unsaved changes")} aria-label={t("Unsaved changes")} />}
        {variant === "row" && <ChevronRight className="row-chevron" size={16} aria-hidden="true" />}
      </button>
    );
  };

  return (
    <section className={`settings-page ${current ? "is-section" : "is-overview"}`}>
      <div className="settings-layout">
        <nav className="settings-rail" aria-label={t("Settings sections")}>
          <button type="button" className="rail-item rail-overview" aria-current={!current ? "page" : undefined} onClick={go("settings")}>
            <span className="row-icon" aria-hidden="true"><LayoutGrid size={15} /></span>
            <span className="row-text"><span className="row-title">{t("Overview")}</span></span>
          </button>
          {SECTIONS.map((group, index) => (
            <div className="rail-group" key={index}>{group.map((section) => sectionButton(section, "rail"))}</div>
          ))}
        </nav>
        <div className="settings-content" ref={scroller}>
          <div className="settings-view" key={page} data-section={current?.id ?? "overview"}>
            {state.activeRunId && (
              <div className="message">{t("Stop the running tasks before saving settings.")}</div>
            )}
            {current ? (
              <>
                <header className="section-head">
                  <button type="button" className="section-back" onClick={go("settings")}>
                    <ChevronLeft size={15} aria-hidden="true" />
                    {t("All settings")}
                  </button>
                  <h1 className="settings-display">{t(current.title)}</h1>
                  <p className="section-about">{t(current.about)}</p>
                </header>
                <div className="section-body">{body(current.id)}</div>
              </>
            ) : (
              <>
                <header className="overview-head">
                  <h1 className="settings-display">{t("Settings")}</h1>
                  {readout}
                </header>
                <div className="settings-groups">
                  {SECTIONS.map((group, index) => (
                    <div className="settings-group" key={index}>{group.map((section) => sectionButton(section, "row"))}</div>
                  ))}
                </div>
                <p className="about-line">
                  <span>Rove {__APP_VERSION__}</span>
                  <button type="button" className="text-button" onClick={() => whatsNew.current?.showModal()}>
                    {t("What's new")}
                  </button>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
      <dialog
        ref={whatsNew}
        className="history-dialog changelog-dialog"
        aria-label={t("What's new")}
        onClick={(event) => {
          if (event.target === event.currentTarget) whatsNew.current?.close();
        }}
      >
        <div className="dialog-heading">
          <h2>{t("What's new")}</h2>
          <button className="icon-button" aria-label={t("Close what's new")} onClick={() => whatsNew.current?.close()}>
            <X size={18} />
          </button>
        </div>
        <div className="markdown changelog-body">
          <Markdown remarkPlugins={[remarkGfm]}>{changelog}</Markdown>
        </div>
      </dialog>
      <footer className="settings-footer" hidden={!current && !ALL_SECTIONS.some((section) => unsaved(section.id))}>
        <button
          className="button primary"
          disabled={!!pending || !!state.activeRunId}
          onClick={() => saveSettings(saveLocal)}
        >
          {pending === "save" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
          {t("Save changes")}
        </button>
      </footer>
    </section>
  );
}
