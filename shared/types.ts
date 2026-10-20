export type JsonSchema = Record<string, unknown>;
export interface CustomTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  enabled: boolean;
  approval: boolean;
  handler:
    | { type: "javascript"; code: string }
    | {
        type: "http";
        url: string;
        method: "GET" | "POST";
        headers?: Record<string, string>;
      };
}
export interface Settings {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  maxSteps: number;
  contextWindow: number;
  maxOutputTokens: number;
  maxImages: number;
  reasoningEffort: "default" | "none" | "low" | "medium" | "high";
  reasoningFormat: "auto" | "reasoning_effort" | "thinking";
  stream: boolean;
  modelTimeoutSeconds: number;
  approvalMode: "always" | "risky" | "never";
  vision: boolean;
  disabledTools: string[];
  customTools: CustomTool[];
}
export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active?: boolean;
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
  "running" | "awaiting_approval" | "completed" | "failed" | "stopped";
export interface RunEvent {
  id: number;
  time: string;
  type: string;
  data: Record<string, any>;
}
export interface RunRecord {
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
  settings: Settings;
  hasApiKey: boolean;
  bridge: BridgeStatus;
  runs: RunRecord[];
  activeRunId: string | null;
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
