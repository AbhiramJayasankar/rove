import { EventEmitter } from "node:events";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { BrowserTransport, BridgeStatus, TabInfo } from "../shared/types";

export class ChromeBridge extends EventEmitter implements BrowserTransport {
  private socket: WebSocket | null = null;
  private info: BridgeStatus = { connected: false, tabs: [] };
  private pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      cleanup: () => void;
    }
  >();
  private wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
  });
  constructor(server: Server, getToken: () => string) {
    super();
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      // Leave Vite's HMR upgrade listener to handle its own path.
      if (url.pathname !== "/bridge") return;
      const host = (req.headers.host || "").split(":")[0];
      const origin = req.headers.origin || "";
      const supplied = Buffer.from(url.searchParams.get("token") || "");
      const expected = Buffer.from(getToken());
      if (
        !["127.0.0.1", "localhost"].includes(host) ||
        !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });
  }
  private attach(ws: WebSocket) {
    this.disconnect("Chrome connection replaced.");
    this.socket = ws;
    ws.on("message", (raw) => {
      if (this.socket !== ws) return;
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (message.type === "hello" || message.type === "tabs") {
          const tabs: TabInfo[] = Array.isArray(message.tabs)
            ? message.tabs
                .filter(
                  (t: any) =>
                    Number.isInteger(t.id) &&
                    typeof t.url === "string" &&
                    typeof t.title === "string",
                )
                .slice(0, 500)
            : [];
          this.info = {
            connected: true,
            browser:
              typeof message.browser === "string"
                ? message.browser.slice(0, 120)
                : this.info.browser || "Chrome",
            tabs,
          };
          this.emit("status", this.status());
        } else if (
          message.type === "result" &&
          typeof message.id === "string"
        ) {
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            pending.cleanup();
            message.error
              ? pending.reject(new Error(String(message.error)))
              : pending.resolve(message.result);
          }
        } else if (message.type === "browser_event") {
          this.emit("notice", message);
        }
      } catch {
        /* Untrusted malformed messages cannot crash the server. */
      }
    });
    ws.on("close", () => {
      if (this.socket === ws)
        this.disconnect("Chrome disconnected. Reconnect the Relay extension.");
    });
    ws.on("error", () => {
      if (this.socket === ws)
        this.disconnect(
          "Chrome connection failed. Reconnect the Relay extension.",
        );
    });
  }
  status(): BridgeStatus {
    return structuredClone(this.info);
  }
  disconnect(reason = "Chrome disconnected.") {
    const old = this.socket;
    this.socket = null;
    if (old) old.close();
    this.info = { connected: false, tabs: [] };
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.emit("status", this.status());
  }
  execute(
    action: string,
    args: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error("Run stopped."));
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.info.connected)
      return Promise.reject(
        new Error("Chrome is not connected. Pair the Relay extension first."),
      );
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const abort = () => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.cleanup();
          reject(
            new Error(
              "Run stopped. An already-dispatched browser action may finish.",
            ),
          );
        }
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(
          new Error(
            `Chrome did not finish ${action} within 45 seconds. Check the browser before retrying.`,
          ),
        );
      }, 45000);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      socket.send(
        JSON.stringify({ type: "command", id, action, args }),
        (error) => {
          if (error) {
            this.pending.delete(id);
            cleanup();
            reject(error);
          }
        },
      );
    });
  }
}
