import Ajv from "ajv";
import type {
  BrowserTransport,
  CustomTool,
  Settings,
  ToolDefinition,
} from "../shared/types";

const ajv = new Ajv({ allErrors: true, strict: false });
const str = { type: "string" };
const tab = { type: "integer", minimum: 1 };
const frame = { type: "string", minLength: 1 };
const target = { tabId: tab, frameId: frame };
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  risk: ToolDefinition["risk"] = "read",
): ToolDefinition {
  return {
    name,
    description,
    risk,
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}
export const BUILTIN_TOOLS: ToolDefinition[] = [
  tool("browser_tabs", "List Chrome tabs and their IDs."),
  tool(
    "browser_navigate",
    "Navigate a tab to an HTTP(S) URL, or open a new tab. Observe the result before interacting.",
    { url: str, tabId: tab, newTab: { type: "boolean" } },
    ["url"],
    "write",
  ),
  tool(
    "browser_snapshot",
    "Read page text and actionable element refs. Use query to find matching labels/links, viewportOnly for visible controls, or nextElementOffset to paginate. Prefer refs over coordinate guesses. Refs expire after fresh snapshots or page changes.",
    {
      ...target,
      textOffset: { type: "integer", minimum: 0 },
      textLimit: { type: "integer", minimum: 100, maximum: 18000 },
      elementOffset: { type: "integer", minimum: 0 },
      elementLimit: { type: "integer", minimum: 1, maximum: 200 },
      query: { type: "string", maxLength: 200 },
      viewportOnly: { type: "boolean" },
    },
  ),
  tool(
    "browser_screenshot",
    "Capture the visible tab with viewport CSS size and devicePixelRatio. Pointer tools use CSS coordinates: divide screenshot pixel coordinates by devicePixelRatio. Prefer element refs when available.",
    { tabId: tab },
  ),
  tool(
    "browser_click",
    "Click a current snapshot ref or viewport x/y coordinates. This may submit forms or perform external actions.",
    {
      ...target,
      ref: str,
      x: { type: "number" },
      y: { type: "number" },
      button: { enum: ["left", "middle", "right"] },
    },
    [],
    "write",
  ),
  tool(
    "browser_hover",
    "Move the pointer over an element ref or viewport coordinates to reveal menus and hover content.",
    { ...target, ref: str, x: { type: "number" }, y: { type: "number" } },
  ),
  tool(
    "browser_drag",
    "Drag from a ref or viewport coordinates to another ref or coordinates, using native mouse input.",
    {
      ...target,
      fromRef: str,
      toRef: str,
      fromX: { type: "number" },
      fromY: { type: "number" },
      toX: { type: "number" },
      toY: { type: "number" },
      toFrameId: frame,
      steps: { type: "integer", minimum: 1, maximum: 50 },
    },
    [],
    "write",
  ),
  tool(
    "browser_downloads",
    "List the last 20 Chrome downloads or cancel a download by ID. Does not read downloaded files.",
    {
      action: { enum: ["list", "cancel"] },
      id: { type: "integer", minimum: 0 },
    },
    ["action"],
    "write",
  ),
  tool(
    "browser_type",
    "Type text into a ref or the focused element; optionally clear existing text first.",
    { ...target, text: str, ref: str, clear: { type: "boolean" } },
    ["text"],
    "write",
  ),
  tool(
    "browser_press_key",
    "Press a key or chord such as Enter, Tab, Control+A. Enter may submit forms.",
    { tabId: tab, key: str },
    ["key"],
    "write",
  ),
  tool(
    "browser_scroll",
    "Scroll by deltaX/deltaY, optionally at viewport x/y coordinates.",
    {
      tabId: tab,
      x: { type: "number" },
      y: { type: "number" },
      deltaX: { type: "number" },
      deltaY: { type: "number" },
    },
    [],
    "read",
  ),
  tool(
    "browser_select",
    "Select option values on a current snapshot select ref.",
    { ...target, ref: str, values: { type: "array", items: str, minItems: 1 } },
    ["ref", "values"],
    "write",
  ),
  tool(
    "browser_wait",
    "Wait briefly for the page to settle (maximum 10 seconds).",
    { milliseconds: { type: "integer", minimum: 0, maximum: 10000 } },
    ["milliseconds"],
  ),
  tool(
    "browser_close_tab",
    "Close a browser tab.",
    { tabId: tab },
    ["tabId"],
    "write",
  ),
  tool(
    "browser_history",
    "Go back, forward, or reload a tab.",
    { tabId: tab, direction: { enum: ["back", "forward", "reload"] } },
    ["direction"],
    "write",
  ),
  tool(
    "browser_evaluate",
    "Advanced: execute JavaScript body in the page with args accessible. Can read or change arbitrary page state.",
    { ...target, code: str, args: { type: "object" } },
    ["code"],
    "danger",
  ),
  tool(
    "browser_cdp",
    "Advanced: send a Chrome DevTools Protocol command. Broad browser access; enable only when needed.",
    { tabId: tab, method: str, params: { type: "object" }, sessionId: str },
    ["method"],
    "danger",
  ),
  tool(
    "browser_dialog",
    "Accept or dismiss an open browser JavaScript dialog.",
    { tabId: tab, accept: { type: "boolean" }, promptText: str },
    ["accept"],
    "write",
  ),
  tool(
    "browser_upload",
    "Advanced: set local absolute file paths on a file input ref. Requires explicit user intent to upload these files.",
    { ...target, ref: str, files: { type: "array", items: str, minItems: 1 } },
    ["ref", "files"],
    "danger",
  ),
  tool(
    "ask_user",
    "Pause and ask the user a question, or request manual login/CAPTCHA interaction. Resume after their reply.",
    { question: str },
    ["question"],
  ),
];

export function getTools(settings: Settings): ToolDefinition[] {
  return [
    ...BUILTIN_TOOLS.filter((t) => !settings.disabledTools.includes(t.name)),
    ...settings.customTools
      .filter((t) => t.enabled && !settings.disabledTools.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        risk: t.approval ? ("danger" as const) : ("read" as const),
      })),
  ];
}

export function validateCustomTools(customTools: CustomTool[]): void {
  if (!Array.isArray(customTools) || customTools.length > 100)
    throw new Error("Provide at most 100 custom tools.");
  const names = new Set(BUILTIN_TOOLS.map((t) => t.name));
  for (const t of customTools) {
    if (
      !t ||
      !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(t.name) ||
      names.has(t.name)
    )
      throw new Error(`Invalid or duplicate custom tool name: ${t?.name}`);
    names.add(t.name);
    if (typeof t.description !== "string" || !t.description.trim())
      throw new Error(`Tool ${t.name} needs a description.`);
    if (!t.parameters || t.parameters.type !== "object")
      throw new Error(
        `Tool ${t.name} parameters must be an object JSON Schema.`,
      );
    if (typeof t.enabled !== "boolean" || typeof t.approval !== "boolean")
      throw new Error(`Tool ${t.name} needs enabled and approval flags.`);
    try {
      ajv.compile(t.parameters);
    } catch {
      throw new Error(`Invalid JSON Schema for tool ${t.name}.`);
    }
    if (t.handler?.type === "javascript") {
      if (
        typeof t.handler.code !== "string" ||
        !t.handler.code.trim() ||
        t.handler.code.length > 100000
      )
        throw new Error(
          `Tool ${t.name} needs JavaScript body (maximum 100 KB).`,
        );
    } else if (t.handler?.type === "http") {
      const url = new URL(t.handler.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(
          `Tool ${t.name} needs an HTTP(S) URL without embedded credentials.`,
        );
      if (!["GET", "POST"].includes(t.handler.method))
        throw new Error(`Invalid method for tool ${t.name}.`);
      if (
        t.handler.headers &&
        Object.entries(t.handler.headers).some(
          ([k, v]) => !k || typeof v !== "string" || /[\r\n]/.test(k + v),
        )
      )
        throw new Error(`Invalid headers for tool ${t.name}.`);
    } else throw new Error(`Invalid handler for tool ${t.name}.`);
  }
}

export function isToolRisky(name: string, settings: Settings): boolean {
  const builtin = BUILTIN_TOOLS.find((t) => t.name === name);
  return builtin
    ? builtin.risk !== "read"
    : !!settings.customTools.find((t) => t.name === name)?.approval;
}

export async function readBounded(
  response: Response,
  maxBytes = 2_000_000,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function executeTool(
  name: string,
  args: Record<string, any>,
  settings: Settings,
  transport: BrowserTransport,
  signal: AbortSignal,
): Promise<any> {
  signal.throwIfAborted();
  const definition = getTools(settings).find((t) => t.name === name);
  if (!definition) throw new Error(`Tool unavailable or disabled: ${name}`);
  const validate = ajv.compile(definition.parameters);
  if (!validate(args))
    throw new Error(
      `Invalid arguments for ${name}: ${ajv.errorsText(validate.errors)}`,
    );
  if (name === "ask_user")
    throw new Error("ask_user must be handled by the agent.");
  if (
    name === "browser_click" &&
    !(
      typeof args.ref === "string" ||
      (typeof args.x === "number" && typeof args.y === "number")
    )
  )
    throw new Error("browser_click requires a ref or x and y.");
  if (name === "browser_navigate") {
    const url = new URL(args.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        "Navigation requires an HTTP(S) URL without embedded credentials.",
      );
  }
  if (name === "browser_wait") {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, args.milliseconds);
      signal.addEventListener("abort", abort, { once: true });
    });
    return { waited: args.milliseconds };
  }
  const custom = settings.customTools.find((t) => t.name === name);
  if (!custom) return transport.execute(name, args, signal);
  if (custom.handler.type === "javascript")
    return transport.execute(
      "browser_evaluate",
      { code: custom.handler.code, args },
      signal,
    );
  const url = new URL(custom.handler.url);
  if (custom.handler.method === "GET")
    for (const [key, value] of Object.entries(args))
      url.searchParams.set(
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      );
  const response = await fetch(url, {
    method: custom.handler.method,
    headers: {
      ...custom.handler.headers,
      ...(custom.handler.method === "POST"
        ? { "Content-Type": "application/json" }
        : {}),
    },
    ...(custom.handler.method === "POST" ? { body: JSON.stringify(args) } : {}),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    redirect: "error",
  });
  const body = await readBounded(response, 256000);
  if (!response.ok)
    throw new Error(
      `Custom HTTP tool returned ${response.status}: ${body.slice(0, 2000)}`,
    );
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
