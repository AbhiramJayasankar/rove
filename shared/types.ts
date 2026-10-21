export type JsonSchema = Record<string, unknown>;
/** One step of a user-defined reasoning control. `body` is a JSON object merged into the request. */
export interface ReasoningLevel {
  value: string;
  label: string;
  body: string;
}
/** Per-model choices that replace or refine what the endpoint advertises. */
export interface ModelOverride {
  /** "on" always sends images, "off" never does; absent follows the endpoint. */
  images?: "on" | "off";
  /** Levels, lowest first, replacing the endpoint's reasoning control. */
  reasoning?: ReasoningLevel[];
}
export interface ModelInfo {
  providerId?: string;
  providerName?: string;
  id: string;
  name: string;
  owner?: string;
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  /** What the endpoint said before any user override was applied. */
  endpointVision?: boolean;
  override?: ModelOverride;
  customReasoning?: ReasoningLevel[];
  inputModalities?: string[];
  outputModalities?: string[];
  supportedParameters?: string[];
  reasoningFormat?:
    | "reasoning_effort"
    | "thinking"
    | "enable_thinking"
    | "reasoning";
  reasoningEfforts?: string[];
  reasoningAliases?: Record<string, string>;
  reasoningToggle?: boolean;
  capabilitySources?: string[];
  outputTokenParameter?: "max_tokens" | "max_completion_tokens";
  free: boolean;
  pricing?: Record<string, unknown>;
  metadata: Record<string, any>;
  source: string;
  fetchedAt: string;
  workingInputBudget?: number;
  workingMaxImages?: number;
}
export interface Settings {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  /** Standing notes appended to the instructions of every task. */
  memory: string;
  /** Per-site overrides of the approval mode. A rule for a host also covers its subdomains. */
  siteRules: { pattern: string; action: "allow" | "ask" | "block" }[];
  maxSteps: number;
  contextWindow: number;
  contextMode: "auto";
  maxOutputTokens: number;
  maxImages: number;
  reasoningEffort: string;
  reasoningFormat: "auto";
  stream: boolean;
  modelTimeoutSeconds: number;
  approvalMode: "always" | "risky" | "never";
  vision: boolean;
  disabledTools: string[];
  /** Open and drive tabs without switching to them, so the user can keep working elsewhere. */
  backgroundTabs: boolean;
  /** Collect the tabs Rove opens in one Chrome tab group per task. */
  groupTabs: boolean;
  /** Carry on if the user closes Chrome's "started debugging this browser" bar; Rove reconnects on its next action. */
  keepGoingOnBarClose: boolean;
}
export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active?: boolean;
  /** Relative to the requesting task; manual callers see any active lease as busy. */
  busyWithAnotherTask?: boolean;
}
export interface BridgeStatus {
  connected: boolean;
  browser?: string;
  tabs: TabInfo[];
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: "read" | "write" | "danger";
}
export type RunStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "stopped";
export type MessageAttachment = {
  name: string;
  mime: string;
  size: number;
} & (
  | { kind: "image"; dataUrl: string }
  | { kind: "text"; text: string }
);
export interface RunEvent {
  id: number;
  time: string;
  type: string;
  data: Record<string, any>;
}
export interface RunRecord {
  revision?: number;
  /** Set on summaries, which omit events: the newest stored event, so clients can detect gaps. */
  lastEventId?: number;
  id: string;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  events: RunEvent[];
}
export interface Approval {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}
export interface AppState {
  providers: { id: string; name: string; baseUrl: string; model: string; hasApiKey: boolean }[];
  activeProviderId: string;
  modelInfo?: ModelInfo | null;
  settings: Settings;
  hasApiKey: boolean;
  bridge: BridgeStatus;
  runs: RunRecord[];
  activeRunId: string | null;
  activeRunIds: string[];
  tools: ToolDefinition[];
}
export interface BrowserTransport {
  execute(
    action: string,
    args: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<any>;
  status(): BridgeStatus;
}
