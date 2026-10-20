// Live check of which reasoning controls an OpenAI-compatible gateway actually honors.
// Usage: set TOKENHARBOR_KEY (never printed), then `node scripts/probe-reasoning.mjs [baseUrl] [model ...]`.
const key = process.env.TOKENHARBOR_KEY;
if (!key) { console.error("Set TOKENHARBOR_KEY first."); process.exit(1); }
const base = (process.argv[2] || "https://tokenharbor.ai/v1").replace(/\/+$/, "");
const models = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["mimo-v2.5:free", "mimo-v2.6-flash:free", "deepseek-v4-flash:free", "deepseek-v4.1-flash:free"];
const variants = (model) =>
  model.startsWith("mimo")
    ? [["default", {}], ["thinking disabled", { thinking: { type: "disabled" } }], ["thinking enabled", { thinking: { type: "enabled" } }]]
    : [["default", {}], ["thinking disabled", { thinking: { type: "disabled" } }],
       ...["low", "high", "max"].map((effort) => [`reasoning_effort ${effort}`, { reasoning_effort: effort }])];
const prompt = "A train leaves at 3:40 pm and the trip takes 2 h 55 min. What time does it arrive? Answer in one line.";
for (const model of models) {
  console.log(`\n${model}`);
  for (const [name, extra] of variants(model)) {
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1500, ...extra }),
        signal: AbortSignal.timeout(90000),
      });
      const text = await response.text();
      if (!response.ok) { console.log(`  ${name.padEnd(22)} HTTP ${response.status} ${text.replaceAll(key, "[key]").slice(0, 140)}`); continue; }
      const data = JSON.parse(text);
      const message = data.choices?.[0]?.message || {};
      const reasoning = message.reasoning_content || message.reasoning || "";
      const tokens = data.usage?.completion_tokens_details?.reasoning_tokens;
      console.log(`  ${name.padEnd(22)} ok  reasoning text: ${reasoning ? reasoning.length + " chars" : "none"}  reasoning tokens: ${tokens ?? "n/a"}  completion tokens: ${data.usage?.completion_tokens ?? "n/a"}`);
    } catch (error) {
      console.log(`  ${name.padEnd(22)} failed: ${String(error.message || error).replaceAll(key, "[key]").slice(0, 140)}`);
    }
  }
}
