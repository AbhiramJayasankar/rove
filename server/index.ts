import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import Ajv from "ajv";
import { Store } from "./store";
import { ChromeBridge } from "./bridge";
import { AgentEngine } from "./agent";
import { BUILTIN_TOOLS, validateCustomTools } from "./tools";
import { testModel } from "./model";
import type { AppState, RunRecord, Settings } from "../shared/types";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.RELAY_PORT || 4789);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("RELAY_PORT must be between 1024 and 65535.");
const origin = `http://127.0.0.1:${port}`;
const allowedOrigins = new Set([origin, `http://localhost:${port}`]);
const store = new Store(
  process.env.RELAY_DATA_DIR || path.join(root, ".relay"),
);
let apiKey = process.env.RELAY_API_KEY || "";
const app = express();
app.disable("x-powered-by");
const server = http.createServer(app);
const bridge = new ChromeBridge(server, () => store.token);
const clients = new Set<express.Response>();
const argumentValidator = new Ajv({ strict: false, allErrors: true });
function broadcast(type: string, data: unknown) {
  for (const res of clients)
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
function redact(message: string) {
  return apiKey ? message.split(apiKey).join("[redacted]") : message;
}
const engine = new AgentEngine({
  transport: bridge,
  getSettings: () => structuredClone(store.settings),
  getApiKey: () => apiKey,
  emit: (runId, event) => {
    broadcast("event", { runId, event });
    if (event.type === "status")
      broadcast("run_status", {
        id: runId,
        status: event.data.status,
        updatedAt: event.time,
      });
  },
  save: (run: RunRecord) => {
    const first = !store.getRun(run.id);
    store.saveRun(run);
    if (first || ["completed", "failed", "stopped"].includes(run.status))
      broadcast("run", run);
  },
});
bridge.on("status", (status) => broadcast("bridge", status));
bridge.on("notice", (notice) => broadcast("browser_notice", notice));
function state(): AppState {
  return {
    settings: store.settings,
    hasApiKey: Boolean(apiKey),
    bridge: bridge.status(),
    runs: store.listRuns(),
    activeRunId: engine.activeRunId,
    tools: BUILTIN_TOOLS,
  };
}

app.use((req, res, next) => {
  if (
    !["127.0.0.1", "localhost"].includes(req.hostname) ||
    ![String(port), ""].includes((req.headers.host || "").split(":")[1] || "")
  ) {
    res.status(403).json({ error: "Untrusted host." });
    return;
  }
  const requestOrigin = req.headers.origin;
  if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
    res
      .status(403)
      .json({ error: "Relay only accepts requests from its own local app." });
    return;
  }
  if (
    req.path.startsWith("/api") &&
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    !req.is("application/json")
  ) {
    res.status(415).json({ error: "Use application/json." });
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  );
  if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "2mb" }));
const record = z.record(z.string(), z.unknown());
const customToolSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(4000),
  parameters: record,
  enabled: z.boolean(),
  approval: z.boolean(),
  handler: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("javascript"),
      code: z.string().min(1).max(100000),
    }),
    z.object({
      type: z.literal("http"),
      url: z.url(),
      method: z.enum(["GET", "POST"]),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  ]),
});
const settingsSchema = z.object({
  baseUrl: z
    .url()
    .refine(
      (url) =>
        ["http:", "https:"].includes(new URL(url).protocol) &&
        !new URL(url).username &&
        !new URL(url).password,
      "Use an HTTP(S) endpoint without embedded credentials.",
    ),
  model: z.string().max(200),
  systemPrompt: z.string().min(1).max(100000),
  maxSteps: z.number().int().min(1).max(200),
  approvalMode: z.enum(["always", "risky", "never"]),
  vision: z.boolean(),
  disabledTools: z.array(z.string()).max(100),
  customTools: z.array(customToolSchema).max(50),
});
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  return schema.parse(input);
}
app.get("/api/state", (_req, res) => res.json(state()));
app.get("/api/health", (_req, res) => res.json({ ok: true, version: "1.0.0" }));
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 20000);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});
app.put("/api/settings", (req, res) => {
  if (engine.activeRunId) {
    res
      .status(409)
      .json({ error: "Stop the active run before changing its settings." });
    return;
  }
  const settings = parse(settingsSchema, req.body) as Settings;
  validateCustomTools(settings.customTools);
  if (req.body.apiKey !== undefined)
    apiKey = parse(z.string().max(10000), req.body.apiKey);
  store.saveSettings(settings);
  const result = { settings, hasApiKey: Boolean(apiKey) };
  broadcast("settings", result);
  res.json(result);
});
app.post("/api/model/test", async (req, res) => {
  const candidate = parse(settingsSchema, {
    ...store.settings,
    ...req.body,
  }) as Settings;
  const key =
    req.body.apiKey === undefined
      ? apiKey
      : parse(z.string().max(10000), req.body.apiKey);
  try {
    const message = await testModel(candidate, key);
    res.json({ ok: true, message });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    res
      .status(400)
      .json({
        ok: false,
        error: key ? raw.split(key).join("[redacted]") : raw,
      });
  }
});
const pairing = () => ({
  token: store.token,
  extensionPath: path.join(root, "extension"),
  serverUrl: origin,
});
app.get("/api/pairing", (_req, res) => res.json(pairing()));
app.post("/api/pairing/rotate", (_req, res) => {
  if (engine.activeRunId) {
    res
      .status(409)
      .json({
        error: "Stop the active run before rotating its connection token.",
      });
    return;
  }
  store.rotateToken();
  bridge.disconnect("Pairing token rotated. Reconnect the extension.");
  res.json(pairing());
});
app.get("/api/tabs", async (_req, res) => {
  const result = await bridge.execute("browser_tabs", {});
  res.json(Array.isArray(result) ? result : result.tabs || []);
});
const observations = new Set([
  "browser_tabs",
  "browser_screenshot",
]);
app.post("/api/browser", async (req, res) => {
  const input = parse(
    z.object({ action: z.string(), args: record.default({}) }),
    req.body,
  );
  const definition = BUILTIN_TOOLS.find((t) => t.name === input.action);
  if (!definition || input.action === "ask_user") {
    res.status(400).json({ error: "Unknown browser action." });
    return;
  }
  const valid = argumentValidator.compile(definition.parameters);
  if (!valid(input.args)) {
    res.status(400).json({ error: argumentValidator.errorsText(valid.errors) });
    return;
  }
  if (engine.activeRunId && !observations.has(input.action)) {
    res
      .status(409)
      .json({
        error: "Stop the active run before manually controlling Chrome.",
      });
    return;
  }
  const result = await bridge.execute(input.action, input.args);
  res.json(result ?? null);
});
app.post("/api/runs", (req, res) => {
  const { prompt, tabId } = parse(
    z.object({
      prompt: z.string().trim().min(1).max(50000),
      tabId: z.number().int().optional(),
    }),
    req.body,
  );
  if (engine.activeRunId) {
    res
      .status(409)
      .json({
        error: "A run is already active. Stop it before starting another.",
      });
    return;
  }
  if (!bridge.status().connected) {
    res
      .status(409)
      .json({ error: "Connect the Relay Chrome extension first." });
    return;
  }
  if (!store.settings.model.trim()) {
    res.status(400).json({ error: "Choose a model in Model settings first." });
    return;
  }
  res.status(201).json(engine.start(prompt, tabId));
});
app.get("/api/runs/:id", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  res.json(run);
});
app.get("/api/runs/:id/export", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  res.attachment(`relay-${run.id}.json`).json(run);
});
app.post("/api/runs/:id/stop", (req, res) => {
  engine.stop(req.params.id);
  res.json({ ok: true });
});
app.post("/api/runs/:id/approval", (req, res) => {
  const input = parse(
    z.object({ approvalId: z.string(), approved: z.boolean() }),
    req.body,
  );
  engine.approve(req.params.id, input.approvalId, input.approved);
  res.json({ ok: true });
});
app.post("/api/runs/:id/reply", (req, res) => {
  const input = parse(
    z.object({ message: z.string().trim().min(1).max(50000) }),
    req.body,
  );
  engine.reply(req.params.id, input.message);
  res.json({ ok: true });
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API route not found." }),
);
if (process.argv.includes("--dev")) {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist", "index.html")),
  );
}
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json({
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: redact(message) });
  },
);
server.listen(port, "127.0.0.1", () =>
  console.log(`Relay is ready at ${origin}`),
);
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
function shutdown() {
  if (engine.activeRunId) engine.stop(engine.activeRunId);
  bridge.disconnect("Relay shut down.");
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
