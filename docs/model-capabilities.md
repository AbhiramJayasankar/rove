# Model capability discovery

Reviewed against primary documentation on 2026-10-20.

Rove reads `/models` before model work. Endpoint names, context/output limits, modalities, supported parameters, and effort enums take precedence. The normalizer accepts common compatible schemas, including DeepSeek's `effort.supported_levels` and parameter-schema enums. Unknown controls remain automatic instead of displaying fabricated levels.

Some compatible catalogues return only IDs, names and context sizes. Exact endpoint/model fallbacks in `extension-core/provider-capabilities.ts` fill those gaps. They never apply to similarly named models on arbitrary hosts. The metadata event records source links alongside the raw endpoint response.

| TokenHarbor free model | Context | Max output | Screenshot inputs | Reasoning control |
| --- | ---: | ---: | --- | --- |
| MiMo V2.5 | 1,048,576 | 128,000 | Yes | Thinking on/off |
| MiMo V2.6 Flash | 1,048,576 | 128,000 | Yes | Thinking on/off |
| DeepSeek V4 Flash | 1,000,000 | 128,000 | Text only | Off, Low, High, Max |
| DeepSeek V4.1 Flash | 1,048,576 | 128,000 | Yes | Off, Low, High, Max |

The gateway's advertised output cap takes priority over a larger direct-upstream cap. Model and reasoning choices appear only in the composer. A new model uses its greatest advertised canonical effort, or enabled thinking for a binary protocol. The DeepSeek selector also exposes the documented aliases Minimal, Medium, X high and Ultra, with descriptions of their Low/High/Max mapping. Rove sends the canonical API value. An explicit valid effort choice is retained. Streaming is always requested. Vision is enabled automatically, except for explicitly text-only models; screenshots remain visible in the trace.

Context and output capacity are shared. Rove starts with the model's maximum output, reserves space for actual instructions and the newest complete tool group, and then compacts older complete groups when needed. Lower limits reported by a context rejection are applied to the working request while the original model metadata remains inspectable. Rejected model requests can retry; browser actions never replay.

## OpenRouter reasoning object

OpenRouter's `/models` publishes `reasoning: { mandatory, supported_efforts, default_effort, default_enabled }`. Rove reads it and sends `reasoning: { effort }`. Without tiers, an optional model gets a Thinking off/on control (`reasoning: { enabled }`); mandatory or absent reasoning shows no control. Checked 2026-10-21 against the live catalogue of 468 models: 196 show three or more levels, 98 show on/off, 174 have no control. TokenHarbor's catalogue publishes no reasoning fields, so only its four documented models have controls.

## MiMo effort names versus distinct intensity

Xiaomi's Chat Completions protocol documents `thinking.type` with `enabled` and `disabled`. Its Responses protocol accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra` through `reasoning.effort`, but explicitly states that all non-`none` values currently enable the same reasoning behavior. Those accepted names do not establish different intensity tiers. Rove uses Chat Completions and shows the documented binary control when the connected catalogue does not advertise effort tiers. If an endpoint advertises effort enums, those levels and its declared reasoning protocol override the fallback automatically.

Sources:

- [Xiaomi Chat Completions reference](https://mimo.mi.com/docs/en-US/api/chat/openai-api)
- [Xiaomi Responses reference](https://mimo.mi.com/docs/en-US/api/chat/responses)
- [DeepSeek model metadata](https://api-docs.deepseek.com/api/list-models/)
- [DeepSeek thinking controls](https://api-docs.deepseek.com/guides/thinking_mode/)
- [TokenHarbor MiMo V2.5](https://tokenharbor.ai/models/mimo-v2.5:free)
- [TokenHarbor MiMo V2.6 Flash](https://tokenharbor.ai/models/mimo-v2.6-flash:free)
- [TokenHarbor DeepSeek V4 Flash](https://tokenharbor.ai/models/deepseek-v4-flash:free)
- [TokenHarbor DeepSeek V4.1 Flash](https://tokenharbor.ai/models/deepseek-v4.1-flash:free)
