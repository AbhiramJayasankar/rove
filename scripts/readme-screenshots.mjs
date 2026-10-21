// Regenerates docs/images/*.png for the README from the real extension.
//   npm run build && node scripts/readme-screenshots.mjs
// It serves a small demo bookshop page and a scripted OpenAI-compatible model that streams
// like a real endpoint, then drives the built extension in Chromium. No network or real key is used.
import { chromium } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const out = path.join(root, "docs", "images");
fs.mkdirSync(out, { recursive: true });
const MODEL_PORT = 8787, SITE_PORT = 8788;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- the demo page
const BOOKS = [
  ["The Salt Roads", "Hardcover", 18.0],
  ["Quiet Engines", "Paperback", 12.5],
  ["A Field Guide to Lighthouses", "Hardcover", 24.0],
  ["Nine Winters", "Hardcover", 14.5],
  ["Paper Maps", "Paperback", 9.99],
  ["The Long Tide", "Hardcover", 21.0],
];
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Harbor Books: New arrivals</title>
<style>
  :root { --ink:#1f2a2c; --sea:#2f6f73; --sand:#f4efe6; --line:#e2dccf; }
  * { box-sizing: border-box; }
  body { margin:0; font:16px/1.5 Georgia, "Times New Roman", serif; color:var(--ink); background:var(--sand); }
  header { display:flex; align-items:center; justify-content:space-between; padding:18px 40px; background:var(--sea); color:#fff; }
  header strong { font-size:22px; letter-spacing:.02em; } header span { font:14px system-ui, sans-serif; opacity:.9; }
  main { max-width:860px; margin:0 auto; padding:34px 40px 60px; }
  h1 { margin:0 0 4px; font-size:34px; } p.lede { margin:0 0 22px; color:#5b6b6d; font:15px system-ui, sans-serif; }
  .bar { display:flex; gap:10px; align-items:center; margin-bottom:18px; font:14px system-ui, sans-serif; }
  .bar button { padding:8px 14px; border:1px solid var(--line); border-radius:999px; background:#fff; cursor:pointer; font:inherit; }
  ul { list-style:none; margin:0; padding:0; display:grid; gap:12px; }
  li { display:flex; align-items:center; gap:18px; padding:14px 18px; background:#fff; border:1px solid var(--line); border-radius:14px; }
  .cover { width:46px; height:62px; border-radius:4px; background:linear-gradient(135deg,var(--sea),#8fb8a8); flex:none; }
  .meta { flex:1; } .meta b { display:block; font-size:18px; } .meta small { color:#6b7b7d; font:13px system-ui, sans-serif; }
  .price { font:600 18px system-ui, sans-serif; min-width:70px; text-align:right; }
  li button { padding:8px 14px; border:0; border-radius:8px; background:var(--sea); color:#fff; cursor:pointer; font:600 14px system-ui, sans-serif; }
</style>
<header><strong>Harbor Books</strong><span>Cart (<b id="cart">0</b>)</span></header>
<main>
  <h1>New arrivals</h1>
  <p class="lede">Six titles, shipped from the quay every Tuesday.</p>
  <div class="bar"><button id="sort" type="button">Sort by price</button><span>Showing 6 books</span></div>
  <ul id="list">${BOOKS.map(([title, format, price]) => `
    <li data-price="${price}"><div class="cover"></div><div class="meta"><b>${title}</b><small>${format}</small></div><div class="price">$${price.toFixed(2)}</div><button type="button" aria-label="Add ${title} to cart" onclick="document.getElementById('cart').textContent=+document.getElementById('cart').textContent+1">Add to cart</button></li>`).join("")}
  </ul>
</main>
<script>
  document.getElementById('sort').addEventListener('click', () => {
    const list = document.getElementById('list');
    [...list.children].sort((a, b) => a.dataset.price - b.dataset.price).forEach((item) => list.appendChild(item));
  });
</script></html>`;
const site = http.createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end(page); });

// ---------------------------------------------------------------- the scripted model
let demoTab = 0;
const MODELS = [
  { id: "aurora-70b", name: "Aurora 70B Instruct", context_length: 131072, max_output_tokens: 16384, supported_parameters: ["tools", "reasoning_effort", "max_tokens"], reasoning_efforts: ["low", "medium", "high"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, pricing: { prompt: "0.0000004", completion: "0.0000012" } },
  { id: "birch-405b", name: "Birch 405B", context_length: 262144, max_output_tokens: 32768, supported_parameters: ["tools", "reasoning_effort"], reasoning_efforts: ["low", "medium", "high"], architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, pricing: { prompt: "0.000002", completion: "0.000006" } },
  { id: "meadow-8b:free", name: "Meadow 8B", context_length: 32768, max_output_tokens: 4096, supported_parameters: ["tools"], architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
  { id: "tide-mini", name: "Tide Mini (text only)", context_length: 65536, max_output_tokens: 8192, supported_parameters: ["tools", "reasoning"], architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.00000008", completion: "0.0000002" } },
];
function findRef(messages, text) {
  for (const message of [...messages].reverse()) {
    if (message.role !== "tool" || !String(message.content).includes('"ref"')) continue;
    let found;
    (function walk(node) {
      if (found || !node || typeof node !== "object") return;
      if (node.ref && Object.values(node).some((value) => typeof value === "string" && value.includes(text))) found = node.ref;
      for (const child of Object.values(node)) walk(child);
    })(JSON.parse(message.content));
    if (found) return found;
  }
  return undefined;
}
const FINAL = `**Nine Winters** is the cheapest hardcover, at **$14.50**.

| Hardcover | Price |
| --- | --- |
| Nine Winters | $14.50 |
| The Salt Roads | $18.00 |
| The Long Tide | $21.00 |
| A Field Guide to Lighthouses | $24.00 |

The only cheaper books are paperbacks (*Paper Maps* at $9.99 and *Quiet Engines* at $12.50).`;
function plan(prompt, toolCount, messages) {
  const tab = { tabId: demoTab };
  if (/cheapest hardcover/i.test(prompt)) {
    if (toolCount === 0) return { reasoning: "I'll read the page first to see what is listed.", call: ["browser_snapshot", tab] };
    if (toolCount === 1) return { text: "Sorting by price will make the cheapest hardcover easy to confirm.", call: ["browser_click", { ...tab, ref: findRef(messages, "Sort by price") }] };
    if (toolCount === 2) return { call: ["browser_screenshot", tab] };
    return { text: FINAL };
  }
  if (/cart/i.test(prompt)) {
    if (toolCount === 0) return { reasoning: "I need the current list to find the right button.", call: ["browser_snapshot", tab] };
    return { text: "Adding Nine Winters, the cheapest hardcover, to the cart.", call: ["browser_click", { ...tab, ref: findRef(messages, "Add Nine Winters to cart") }] };
  }
  return { text: "Done." };
}
const model = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: MODELS })); }
  if (!req.url?.endsWith("/chat/completions")) { res.statusCode = 404; return res.end("{}"); }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const prompt = body.messages.find((message) => message.role === "user")?.content;
  const promptText = typeof prompt === "string" ? prompt : (prompt || []).map((part) => part.text || "").join(" ");
  const toolCount = body.messages.filter((message) => message.role === "tool").length;
  const step = plan(promptText, toolCount, body.messages);
  const words = (text) => text.split(/(\s+)/).filter(Boolean);
  const chunks = [];
  for (const word of words(step.reasoning || "")) chunks.push({ choices: [{ index: 0, delta: { reasoning_content: word } }] });
  for (const word of words(step.text || "")) chunks.push({ choices: [{ index: 0, delta: { content: word } }] });
  if (step.call) chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${toolCount + 1}`, type: "function", function: { name: step.call[0], arguments: JSON.stringify(step.call[1]) } }] } }] });
  const completion = Math.max(40, (step.text || "").length / 3.4 + (step.reasoning || "").length / 4 + (step.call ? 30 : 0));
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: step.call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1900 + toolCount * 1300, completion_tokens: Math.round(completion), total_tokens: 1900 + toolCount * 1300 + Math.round(completion) } });
  res.writeHead(200, { "content-type": "text/event-stream" });
  // A tool call arrives after the model has composed it, so give call-only turns a believable pause.
  if (step.call && !step.text) await sleep(380);
  for (const chunk of chunks) { res.write(`data: ${JSON.stringify(chunk)}\n\n`); await sleep(15); }
  res.write("data: [DONE]\n\n");
  res.end();
});

// ---------------------------------------------------------------- drive the extension
await Promise.all([new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r)), new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r))]);
const extension = path.join(root, "extension");
const context = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true, viewport: { width: 470, height: 860 }, deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
const ui = await context.newPage();
await ui.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
const rpc = async (route, method = "GET", body) => {
  const result = await ui.evaluate(({ route, method, body }) => chrome.runtime.sendMessage({ type: "rove-api", path: route, method, body }), { route, method, body });
  if (!result.ok) throw new Error(result.error);
  return result.data;
};
const shot = (name, options = {}) => ui.screenshot({ path: path.join(out, name), ...options });
const settings = (await rpc("/api/state")).settings;
await rpc("/api/settings", "PUT", { ...settings, baseUrl: `http://127.0.0.1:${MODEL_PORT}/v1`, model: "aurora-70b", apiKey: "demo-key", providerName: "Demo endpoint", approvalMode: "never" });
await ui.reload();

const books = await context.newPage();
await books.setViewportSize({ width: 1030, height: 754 });
await books.goto(`http://127.0.0.1:${SITE_PORT}/`);
demoTab = await ui.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.title?.startsWith("Harbor Books"))?.id);
await ui.bringToFront();
const heroBefore = await books.screenshot({ type: "png" });

async function chooseTab() {
  await ui.getByRole("combobox", { name: "Chrome tab" }).click();
  await ui.getByRole("option", { name: /Harbor Books/ }).click();
}
async function ask(text) {
  await ui.getByRole("textbox", { name: "Task prompt" }).fill(text);
  await ui.getByRole("button", { name: "Run task", exact: true }).click();
}
await ui.getByRole("button", { name: "New task", exact: true }).click();
await chooseTab();
await ui.screenshot({ path: path.join(out, "panel-empty.png") });

// Task 1: read, click, look, answer.
await ask("Find the cheapest hardcover on this page and tell me what it costs.");
await ui.getByText("Nine Winters").first().waitFor({ timeout: 30000 }).catch(async (error) => {
  await ui.screenshot({ path: path.join(root, "test-results", "screenshots-debug.png") });
  const state = await rpc("/api/state");
  const run = state.runs[0] && (await rpc(`/api/runs/${state.runs[0].id}`));
  console.log("DEBUG status:", run?.status, JSON.stringify(run?.events?.slice(-4)).slice(0, 1500));
  throw error;
});
await ui.getByText(/tok\/s/).first().waitFor({ timeout: 30000 });
await sleep(800);
await shot("panel-chat-light.png");
const heroAfter = await books.screenshot({ type: "png" });
// Activity view of the same task.
await ui.getByRole("button", { name: /Action|actions?/i }).first().click().catch(() => {});
await sleep(400);
await shot("panel-activity-light.png");
await ui.getByRole("button", { name: "Use dark mode" }).click();
await sleep(300);
await shot("panel-activity-dark.png");
await ui.getByRole("button", { name: "Use light mode" }).click();

// Task 2: ask first, so the click waits for a decision.
await ui.getByRole("button", { name: "New task", exact: true }).click();
await chooseTab();
await ui.getByRole("combobox", { name: "Approval mode" }).click();
await ui.getByRole("option", { name: /Ask permission/ }).click();
await ask("Add the cheapest hardcover to my cart.");
await ui.getByRole("button", { name: /^Approve/ }).first().waitFor({ timeout: 30000 });
await sleep(500);
await shot("panel-approval.png");
await ui.getByRole("button", { name: "Stop", exact: true }).first().click().catch(() => ui.keyboard.press("Escape"));
await sleep(500);

// Settings.
await ui.setViewportSize({ width: 470, height: 2100 });
await ui.getByRole("button", { name: "Settings", exact: true }).click();
await sleep(1200);
await ui.locator(".settings-content").evaluate((node) => (node.scrollTop = 0));
await shot("settings-model.png", { fullPage: true });
await ui.getByRole("button", { name: "Tools", exact: true }).click();
await sleep(500);
await ui.setViewportSize({ width: 470, height: 1500 });
await shot("settings-tools.png");
await ui.setViewportSize({ width: 470, height: 860 });

// Model picker with its details.
await ui.getByRole("button", { name: "Back to chat", exact: true }).click();
await ui.getByRole("button", { name: "New task", exact: true }).click();
await ui.getByRole("combobox", { name: "Approval mode" }).click();
await ui.getByRole("option", { name: /Auto-approve/ }).click();
await ui.getByRole("button", { name: "Choose model", exact: true }).click();
await ui.getByRole("button", { name: "Details for Birch 405B" }).hover();
await sleep(500);
await shot("model-picker.png");

// ---------------------------------------------------------------- hero: the page and the panel, side by side
const read = (file) => `data:image/png;base64,${fs.readFileSync(path.join(out, file)).toString("base64")}`;
const png = (buffer) => `data:image/png;base64,${buffer.toString("base64")}`;
await context.close();
const browser = await chromium.launch({ channel: "chromium", headless: true });
const compose = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 })).newPage();
await compose.setContent(`<!doctype html><meta charset="utf-8"><style>
  body { margin:0; width:1600px; height:900px; background:linear-gradient(135deg,#d7e3d4,#eef1e4 55%,#f4efe6); font-family:system-ui,sans-serif; display:flex; align-items:center; justify-content:center; }
  .window { width:1500px; height:800px; display:flex; flex-direction:column; border-radius:16px; overflow:hidden; background:#fff; box-shadow:0 30px 80px rgba(31,42,44,.28), 0 2px 6px rgba(31,42,44,.2); }
  .chrome { height:46px; flex:none; display:flex; align-items:center; gap:14px; padding:0 18px; background:#e9ece4; }
  .dots { display:flex; gap:8px; } .dots i { width:12px; height:12px; border-radius:50%; background:#c4c9bd; }
  .tab { padding:7px 16px; border-radius:10px 10px 0 0; background:#fff; font-size:13px; color:#3a4642; }
  .url { flex:1; max-width:560px; height:28px; border-radius:14px; background:#fff; color:#5d6a65; font-size:13px; display:flex; align-items:center; padding:0 16px; margin-left:12px; }
  .body { flex:1; display:flex; min-height:0; }
  .site { flex:1; min-width:0; overflow:hidden; } .site img { width:100%; display:block; }
  .panel { width:470px; flex:none; border-left:1px solid #d9ddd1; background:#fcfdf8; overflow:hidden; } .panel img { width:100%; display:block; }
</style>
<div class="window"><div class="chrome"><div class="dots"><i></i><i></i><i></i></div><div class="tab">Harbor Books: New arrivals</div><div class="url">harborbooks.example/new</div></div>
<div class="body"><div class="site"><img src="${png(heroAfter)}"></div><div class="panel"><img src="${read("panel-chat-light.png")}"></div></div></div>`);
await compose.screenshot({ path: path.join(out, "hero.png") });
await browser.close();
site.close(); model.close();
console.log("wrote", fs.readdirSync(out).filter((name) => name.endsWith(".png")).join(", "));
setTimeout(() => process.exit(0), 300);
