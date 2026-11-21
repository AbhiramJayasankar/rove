#!/usr/bin/env node
// Rove MCP server. An MCP client (Claude Code, Codex, Cursor, ...) starts this script over stdio;
// Rove's Chrome extension connects to it on 127.0.0.1 and carries out the tool calls.
// No dependencies: Node 22 or newer.
//
//   claude mcp add rove -e ROVE_TOKEN=<token from Rove> -- node "<Rove folder>/mcp/rove-mcp.mjs"
//
// Several MCP clients can run at once. The first one listens on the port and relays for the others,
// which connect to it; when it exits, one of the others takes over.
import http from "node:http";
import crypto from "node:crypto";

const VERSION = "1";
const PORT = Number(process.env.ROVE_MCP_PORT) || 47821;
const TOKEN = process.env.ROVE_TOKEN || "";
const EXTENSION_ORIGIN = `chrome-extension://${process.env.ROVE_EXTENSION_ID || "mklgbmacaelcomgamkccjncffojpfekb"}`;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CALL_TIMEOUT_MS = 15 * 60_000;
const CONNECT_WAIT_MS = 40_000;
const log = (...parts) => process.stderr.write(`[rove-mcp] ${parts.join(" ")}\n`);

// ---------- MCP over stdio ----------
let clientInfo = { name: "MCP client", version: "" };
let clientKnown = false; // set once the MCP client says who it is
let toolsListed = false;
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
const OFFLINE_TOOLS = [{
  name: "rove_status",
  description: "Check whether Rove (the Chrome extension) is connected. Rove's browser tools appear once it is.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}];
let tools = null; // from the extension

async function onMessage(message) {
  const { id, method, params } = message;
  if (method === undefined) return; // a response to something we never send
  try {
    if (method === "initialize") {
      clientInfo = { ...clientInfo, ...(params?.clientInfo ?? {}) };
      clientKnown = true;
      relay.announce();
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "rove", title: "Rove", version: VERSION },
        instructions:
          "Rove drives the user's own Chrome, in their signed-in tabs. Use browser_* tools to act in a tab yourself " +
          "(open one with browser_navigate and newTab:true, read it with browser_snapshot, then pass its tabId), or " +
          "rove_run_task to hand a whole task to Rove's own model; it returns the answer and a report with time, model, steps, tokens and cost. " +
          "The user's Rove site rules apply to every call: blocked sites are refused, and sites set to Ask are refused until the user allows them. " +
          "Rove's approval setting applies only to tasks handed to rove_run_task; your direct browser_* calls are approved through your own app's permissions.",
      });
    }
    if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") {
      toolsListed = true;
      if (!tools) await relay.waitForExtension(3000);
      return reply(id, { tools: tools ?? OFFLINE_TOOLS });
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "rove_status")
        return reply(id, text(relay.connected() ? "Rove is connected." : notConnected(), !relay.connected()));
      if (!(await relay.waitForExtension(CONNECT_WAIT_MS))) return reply(id, text(notConnected(), true));
      const result = await relay.call(name, args);
      return reply(id, toContent(result));
    }
    if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    if (id !== undefined) reply(id, text(error instanceof Error ? error.message : String(error), true));
  }
}
function notConnected() {
  return "Rove is not connected. Open Chrome, and in Rove turn on Settings > Tools > Connected apps " +
    (TOKEN ? "(check that ROVE_TOKEN matches the token shown there)." : "and copy the setup command, which includes ROVE_TOKEN.");
}
function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}
/** The extension answers {ok, result} or {ok:false, error}; screenshots come back as images. */
function toContent(answer) {
  if (!answer.ok) return text(answer.error || "Rove reported an error.", true);
  const content = [];
  const strip = (value) => {
    if (typeof value === "string" && /^data:image\/(png|jpe?g|webp);base64,/.test(value)) {
      const [, mime, data] = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(value) ?? [];
      if (mime) content.push({ type: "image", mimeType: mime === "image/jpg" ? "image/jpeg" : mime, data });
      return "[image attached]";
    }
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)]));
    return value;
  };
  const body = strip(answer.result);
  content.unshift({ type: "text", text: typeof body === "string" ? body : JSON.stringify(body, null, 1) });
  return { content };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(null, -32700, "Parse error");
      continue;
    }
    void onMessage(message);
  }
});
process.stdin.on("end", () => process.exit(0));

// ---------- WebSocket (RFC 6455), just what Rove needs ----------
function accept(request, socket) {
  const key = request.headers["sec-websocket-key"];
  const digest = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`);
  return wrap(socket, false);
}
/** A minimal text-frame socket over a raw TCP socket. Clients mask their frames; servers do not. */
function wrap(socket, mask) {
  const handlers = { message: () => {}, close: () => {} };
  let pending = Buffer.alloc(0);
  let fragments = [];
  let closed = false;
  const frame = (opcode, payload) => {
    const length = payload.length;
    const header = length < 126 ? Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | length])
      : length < 65536 ? Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | 126, length >> 8, length & 255])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = (mask ? 0x80 : 0) | 127; b.writeBigUInt64BE(BigInt(length), 2); return b; })();
    if (!mask) return Buffer.concat([header, payload]);
    const key = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
    return Buffer.concat([header, key, masked]);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try { socket.end(frame(0x8, Buffer.alloc(0))); } catch {}
    socket.destroy();
    handlers.close();
  };
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      const fin = pending[0] & 0x80, opcode = pending[0] & 0x0f, masked = pending[1] & 0x80;
      let length = pending[1] & 0x7f, offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (pending.length < 10) return; length = Number(pending.readBigUInt64BE(2)); offset = 10; }
      if (length > 64 * 1024 * 1024) return close();
      const keyAt = offset;
      if (masked) offset += 4;
      if (pending.length < offset + length) return;
      const payload = Buffer.from(pending.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= pending[keyAt + (i & 3)];
      pending = pending.subarray(offset + length);
      if (opcode === 0x8) return close();
      if (opcode === 0x9) { socket.write(frame(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      fragments.push(payload);
      if (!fin) continue;
      const data = Buffer.concat(fragments).toString("utf8");
      fragments = [];
      try { handlers.message(JSON.parse(data)); } catch {}
    }
  });
  socket.on("close", () => { if (!closed) { closed = true; handlers.close(); } });
  socket.on("error", () => close());
  return {
    send: (value) => { if (!closed) socket.write(frame(0x1, Buffer.from(JSON.stringify(value)))); },
    on: (event, handler) => { handlers[event] = handler; },
    close,
    get closed() { return closed; },
  };
}
function connectAsPeer() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const request = http.request({ host: "127.0.0.1", port: PORT, path: "/peer", headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key,
    } });
    request.on("upgrade", (_response, socket) => resolve(wrap(socket, true)));
    request.on("response", () => reject(new Error("The Rove port is in use by something else.")));
    request.on("error", reject);
    request.end();
  });
}

// ---------- Relay: hub (owns the port, talks to the extension) or peer (talks to the hub) ----------
const relay = (() => {
  let extension = null; // hub: the extension's socket
  let hub = null; // peer: socket to the hub
  const peers = new Set();
  const waiting = new Map(); // call id -> resolve
  const waiters = new Set();
  let extensionTools = null;
  const settleWaiters = () => { for (const wake of waiters) wake(); };
  const setTools = (next) => {
    const changed = JSON.stringify(next) !== JSON.stringify(tools);
    tools = next;
    if (changed && toolsListed) send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    settleWaiters();
  };
  const finishAll = (message) => {
    for (const [id, resolve] of waiting) resolve({ ok: false, error: message });
    waiting.clear();
  };

  function becomeHub() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((_request, response) => {
        response.writeHead(426, { "Content-Type": "text/plain" });
        response.end("Rove MCP relay. Connect from the Rove extension.");
      });
      server.on("upgrade", (request, socket) => {
        const origin = request.headers.origin;
        if (request.url === "/extension" && origin === EXTENSION_ORIGIN) return onExtension(accept(request, socket));
        // Other local MCP servers relay through this one; browsers always send an Origin, so pages cannot.
        if (request.url === "/peer" && !origin) return onPeer(accept(request, socket));
        socket.destroy();
      });
      server.once("error", reject);
      server.listen(PORT, "127.0.0.1", () => {
        log(`listening on 127.0.0.1:${PORT}`);
        resolve(server);
      });
    });
  }
  function onExtension(socket) {
    // The extension checks the token before it accepts any call; the hub hears from it only after that.
    socket.send({ type: "hello", server: "rove-mcp", version: VERSION, token: TOKEN, ...(clientKnown ? { client: clientInfo } : {}), pid: process.pid });
    socket.on("message", (message) => {
      if (message.type === "ready") {
        extension?.close();
        extension = socket;
        extensionTools = message.tools;
        setTools(message.tools);
        for (const peer of peers) peer.send({ type: "tools", tools: message.tools });
        log("Rove connected");
      } else if (message.type === "ping") socket.send({ type: "pong" });
      else if (message.type === "result") {
        const done = waiting.get(message.id);
        if (done) { waiting.delete(message.id); done(message); return; }
        for (const peer of peers) peer.send(message); // a peer's call; ids are unique per process
      } else if (message.type === "tools") {
        extensionTools = message.tools;
        setTools(message.tools);
        for (const peer of peers) peer.send({ type: "tools", tools: message.tools });
      }
    });
    socket.on("close", () => {
      if (extension !== socket) return;
      extension = null;
      log("Rove disconnected");
      finishAll("Rove disconnected before it answered. Check Chrome, then try again.");
      for (const peer of peers) peer.send({ type: "tools", tools: null });
    });
  }
  function onPeer(socket) {
    let trusted = false;
    socket.on("message", (message) => {
      if (!trusted) {
        if (message.type !== "peer" || message.token !== TOKEN) return socket.close();
        trusted = true;
        peers.add(socket);
        socket.send({ type: "tools", tools: extension ? extensionTools : null });
        return;
      }
      if (message.type === "call") {
        if (!extension) return socket.send({ type: "result", id: message.id, ok: false, error: "Rove is not connected." });
        extension.send({ ...message, client: message.client ?? clientInfo });
      } else if (message.type === "announce" && extension) extension.send({ type: "client", client: message.client });
    });
    socket.on("close", () => peers.delete(socket));
  }
  async function asPeer() {
    hub = await connectAsPeer();
    hub.send({ type: "peer", token: TOKEN });
    if (clientKnown) hub.send({ type: "announce", client: clientInfo });
    log(`relaying through the Rove MCP server already on port ${PORT}`);
    hub.on("message", (message) => {
      if (message.type === "tools") setTools(message.tools);
      else if (message.type === "result") {
        const done = waiting.get(message.id);
        if (done) { waiting.delete(message.id); done(message); }
      }
    });
    hub.on("close", () => {
      hub = null;
      setTools(null);
      finishAll("The Rove MCP relay closed before Rove answered. Try again.");
      setTimeout(() => void start(), 300 + Math.random() * 700);
    });
  }
  async function start() {
    try {
      await becomeHub();
    } catch (error) {
      if (error?.code !== "EADDRINUSE") return log(`cannot listen: ${error?.message ?? error}`);
      try {
        await asPeer();
      } catch (peerError) {
        log(`port ${PORT} is busy: ${peerError?.message ?? peerError}. Retrying.`);
        setTimeout(() => void start(), 3000);
      }
    }
  }
  void start();
  return {
    connected: () => !!(extension || (hub && tools)),
    announce() {
      if (!clientKnown) return;
      if (extension) extension.send({ type: "client", client: clientInfo });
      hub?.send({ type: "announce", client: clientInfo });
    },
    waitForExtension(ms) {
      if (this.connected()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const wake = () => { if (this.connected()) { clearTimeout(timer); waiters.delete(wake); resolve(true); } };
        const timer = setTimeout(() => { waiters.delete(wake); resolve(false); }, ms);
        waiters.add(wake);
      });
    },
    call(tool, args) {
      const id = `${process.pid}-${crypto.randomUUID()}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: "Rove did not answer within 15 minutes." }); }, CALL_TIMEOUT_MS);
        waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
        const message = { type: "call", id, tool, args, client: clientInfo };
        if (extension) extension.send(message);
        else if (hub) hub.send(message);
        else { waiting.delete(id); clearTimeout(timer); resolve({ ok: false, error: "Rove is not connected." }); }
      });
    },
  };
})();
