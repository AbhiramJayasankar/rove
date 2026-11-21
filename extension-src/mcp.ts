/** Connects Rove to its MCP server (mcp/rove-mcp.mjs), which MCP clients such as Claude Code start.
 *  The server listens on 127.0.0.1; Rove connects out to it, checks its token, and answers its tool
 *  calls. An open WebSocket with regular messages keeps the service worker running. */
export const MCP_PORT = 47821;
const SCAN_MS = 10_000;
const PING_MS = 20_000;
export const MCP_ALARM = "rove-mcp-scan";

export type McpClient = { name: string; version?: string };
export type McpActivity = { client: string; tool: string; at: number; ok: boolean; error?: string };
export type McpStatus = { connected: boolean; clients: string[]; activity: McpActivity[] };
export type McpDeps = {
  enabled(): boolean;
  /** The server's port: MCP_PORT unless changed (ROVE_MCP_PORT on the server side must match). */
  port(): number;
  token(): string;
  tools(): unknown[];
  call(tool: string, args: Record<string, unknown>, client: McpClient): Promise<unknown>;
  changed(status: McpStatus): void;
};

export class McpBridge {
  private socket?: WebSocket;
  private connecting = false;
  private scanTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private clients = new Map<string, McpClient>();
  private activity: McpActivity[] = [];
  private lastTools = "";
  constructor(private deps: McpDeps) {}

  status(): McpStatus {
    return { connected: !!this.socket, clients: [...new Set([...this.clients.values()].map((client) => client.name))], activity: this.activity };
  }

  /** Turn the connection on or off to match settings; call after settings change and at start-up. */
  async refresh(reconnect = false) {
    if (reconnect) this.disconnect();
    if (this.deps.enabled()) {
      await chrome.alarms.create(MCP_ALARM, { periodInMinutes: 0.5 });
      this.scan();
    } else {
      await chrome.alarms.clear(MCP_ALARM);
      clearTimeout(this.scanTimer);
      this.scanTimer = undefined;
      this.disconnect();
    }
  }

  /** Tools changed (a setting turned a tool on or off): tell the server. */
  toolsChanged() {
    const tools = JSON.stringify(this.deps.tools());
    if (tools === this.lastTools) return;
    this.lastTools = tools;
    this.socket?.send(JSON.stringify({ type: "tools", tools: this.deps.tools() }));
  }

  scan() {
    clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    if (!this.deps.enabled() || this.socket || this.connecting) return;
    this.connecting = true;
    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${this.deps.port()}/extension`);
    } catch {
      this.connecting = false;
      return this.later();
    }
    let accepted = false;
    const giveUp = setTimeout(() => socket.close(), 5000);
    socket.onmessage = (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!accepted) {
        clearTimeout(giveUp);
        // Anything on this port that cannot show the token from Rove's settings is not our server.
        if (message?.type !== "hello" || message.server !== "rove-mcp" || !this.deps.token() || message.token !== this.deps.token()) {
          socket.close();
          return;
        }
        accepted = true;
        this.connecting = false;
        this.socket = socket;
        if (message.client?.name) this.clients.set(String(message.client.name), { name: String(message.client.name), version: message.client.version });
        this.lastTools = JSON.stringify(this.deps.tools());
        socket.send(JSON.stringify({ type: "ready", version: chrome.runtime.getManifest().version, tools: this.deps.tools() }));
        this.pingTimer = setInterval(() => socket.send(JSON.stringify({ type: "ping" })), PING_MS);
        this.deps.changed(this.status());
        return;
      }
      if (message?.type === "client" && message.client?.name) {
        this.clients.set(String(message.client.name), { name: String(message.client.name), version: message.client.version });
        this.deps.changed(this.status());
      } else if (message?.type === "call" && typeof message.id === "string") void this.answer(socket, message);
    };
    socket.onclose = () => {
      clearTimeout(giveUp);
      if (this.socket === socket) {
        this.socket = undefined;
        clearInterval(this.pingTimer);
        this.clients.clear();
        this.deps.changed(this.status());
      }
      if (!accepted) this.connecting = false;
      this.later();
    };
    socket.onerror = () => {};
  }

  private later() {
    if (this.deps.enabled() && !this.scanTimer) this.scanTimer = setTimeout(() => this.scan(), SCAN_MS);
  }

  private disconnect() {
    clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.clients.clear();
    socket?.close();
    this.deps.changed(this.status());
  }

  private async answer(socket: WebSocket, message: { id: string; tool: string; args?: Record<string, unknown>; client?: McpClient }) {
    const client = { name: String(message.client?.name || "MCP client"), version: message.client?.version };
    if (!this.clients.has(client.name)) {
      this.clients.set(client.name, client);
    }
    const entry: McpActivity = { client: client.name, tool: String(message.tool), at: Date.now(), ok: true };
    let reply: Record<string, unknown>;
    try {
      const result = await this.deps.call(String(message.tool), message.args && typeof message.args === "object" ? message.args : {}, client);
      reply = { type: "result", id: message.id, ok: true, result };
    } catch (error) {
      entry.ok = false;
      entry.error = error instanceof Error ? error.message : String(error);
      reply = { type: "result", id: message.id, ok: false, error: entry.error };
    }
    this.activity = [entry, ...this.activity].slice(0, 20);
    this.deps.changed(this.status());
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
  }
}
