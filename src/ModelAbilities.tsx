import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { ModelInfo, ModelOverride, ReasoningLevel } from "../shared/types";
import { reasoningOptions } from "../shared/capabilities";
import ChoiceMenu from "./ChoiceMenu";
import { useT } from "./i18n";
import { api } from "./ui";

const level = (label: string, body: unknown): ReasoningLevel => ({
  value: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "level",
  label,
  body: JSON.stringify(body),
});
const PRESETS: { id: string; name: string; levels: ReasoningLevel[] }[] = [
  { id: "effort-switch", name: "reasoning_effort on/off (llama.cpp)", levels: [level("Off", { reasoning_effort: "none" }), level("On", { reasoning_effort: "high" })] },
  { id: "template", name: "chat_template_kwargs enable_thinking", levels: [level("Off", { chat_template_kwargs: { enable_thinking: false } }), level("On", { chat_template_kwargs: { enable_thinking: true } })] },
  { id: "budget", name: "thinking_budget_tokens (llama.cpp)", levels: [level("Off", { thinking_budget_tokens: 0 }), level("Low", { thinking_budget_tokens: 1024 }), level("Medium", { thinking_budget_tokens: 4096 }), level("High", { thinking_budget_tokens: 16384 })] },
  { id: "effort", name: "reasoning_effort low / medium / high", levels: [level("Low", { reasoning_effort: "low" }), level("Medium", { reasoning_effort: "medium" }), level("High", { reasoning_effort: "high" })] },
  { id: "thinking", name: "thinking.type (DeepSeek, MiMo)", levels: [level("Off", { thinking: { type: "disabled" } }), level("On", { thinking: { type: "enabled" } })] },
  { id: "object", name: "reasoning object (OpenRouter)", levels: [level("Off", { reasoning: { enabled: false } }), level("Low", { reasoning: { effort: "low" } }), level("Medium", { reasoning: { effort: "medium" } }), level("High", { reasoning: { effort: "high" } })] },
];
const prettyBody = (body: string) => {
  try {
    return JSON.stringify(JSON.parse(body));
  } catch {
    return body;
  }
};
/** Give every level a unique id derived from its name. */
function withIds(levels: ReasoningLevel[]): ReasoningLevel[] {
  const seen = new Set<string>();
  return levels.map((item) => {
    const base = level(item.label.trim(), {}).value;
    let value = base;
    for (let n = 2; seen.has(value); n++) value = `${base}-${n}`;
    seen.add(value);
    return { value, label: item.label.trim(), body: item.body.trim() || "{}" };
  });
}
function bodyError(body: string): "" | "json" | "object" {
  try {
    const value = JSON.parse(body.trim() || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? "" : "object";
  } catch {
    return "json";
  }
}

/** Per-model choices that replace what the endpoint advertises: whether to send images, and how to ask for reasoning. */
export default function ModelAbilities({
  model,
  endpoint,
  onSaved,
}: {
  model: ModelInfo;
  endpoint: string;
  onSaved?: (model: ModelInfo | null) => void;
}) {
  const t = useT();
  const [override, setOverride] = useState<ModelOverride>(model.override ?? {});
  const [levels, setLevels] = useState<ReasoningLevel[]>(model.override?.reasoning ?? []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const custom = !!override.reasoning;
  useEffect(() => {
    setOverride(model.override ?? {});
    setLevels(model.override?.reasoning ?? []);
    setError("");
  }, [model.id, endpoint, JSON.stringify(model.override ?? null)]);

  async function save(next: ModelOverride) {
    setSaving(true);
    setError("");
    try {
      const result = await api<{ model: ModelInfo | null }>("/api/model-override", {
        method: "PUT",
        body: JSON.stringify({ baseUrl: endpoint, model: model.id, override: next.images || next.reasoning ? next : null }),
      });
      setOverride(next);
      onSaved?.(result.model);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }
  const images = override.images ?? "auto";
  const endpointVision = model.endpointVision ?? model.supportsVision;
  const hint = endpointVision === false
    ? t("The endpoint says this model cannot see images.")
    : endpointVision === true
      ? t("The endpoint says this model can see images.")
      : t("The endpoint does not say whether this model can see images.");
  const advertised = reasoningOptions({} as never, { ...model, customReasoning: undefined });
  const advertisedText = model.reasoningFormat
    ? t("Endpoint offers: {levels}", { levels: advertised.map((option) => option.label).join(" · ") })
    : t("The endpoint does not advertise a reasoning control, so Rove sends nothing.");
  const unnamed = levels.some((item) => !item.label.trim());
  const problem = levels.some((item) => bodyError(item.body)) || unnamed;
  const dirty = JSON.stringify(withIds(levels)) !== JSON.stringify(override.reasoning ?? []);

  return (
    <div className="model-abilities">
      <span className="abilities-title">{t("Model abilities")}</span>
      <p className="abilities-note">{t("These apply to {model} and save at once. New tasks use them.", { model: model.name })}</p>
      <div className="ability-row">
        <div>
          <strong>{t("Images")}</strong>
          <small>{hint}</small>
        </div>
        <ChoiceMenu
          label={t("Images")}
          value={images}
          disabled={saving}
          options={[
            { value: "auto", label: t("Follow the endpoint") },
            { value: "on", label: t("Always send images") },
            { value: "off", label: t("Never send images") },
          ]}
          onChange={(value) => void save({ ...override, images: value === "auto" ? undefined : (value as "on" | "off") })}
        />
      </div>
      <div className="ability-row">
        <div>
          <strong>{t("Reasoning control")}</strong>
          <small>{custom ? t("Your levels replace the endpoint's. Each level's JSON is merged into the request.") : advertisedText}</small>
        </div>
        <ChoiceMenu
          label={t("Reasoning control")}
          value={custom ? "custom" : "endpoint"}
          disabled={saving}
          options={[
            { value: "endpoint", label: t("Endpoint default") },
            { value: "custom", label: t("Custom levels") },
          ]}
          onChange={(value) => {
            if (value === "endpoint") {
              setLevels([]);
              void save({ ...override, reasoning: undefined });
            } else {
              const start = withIds(PRESETS[0].levels);
              setLevels(start);
              setOverride({ ...override, reasoning: start });
              void save({ ...override, reasoning: start });
            }
          }}
        />
      </div>
      {custom && (
        <div className="level-editor">
          <div className="level-presets">
            <ChoiceMenu
              label={t("Start from a preset")}
              value=""
              displayLabel={t("Start from a preset")}
              options={PRESETS.map((preset) => ({ value: preset.id, label: preset.name }))}
              onChange={(id) => setLevels(PRESETS.find((preset) => preset.id === id)?.levels ?? levels)}
            />
          </div>
          <p className="abilities-note">{t("List levels from lowest to highest. The last one is the default.")}</p>
          {levels.map((item, index) => (
            <div className="level-card" key={index}>
              <div className="level-head">
                <input
                  aria-label={t("Level name")}
                  value={item.label}
                  maxLength={40}
                  placeholder={t("Level name")}
                  onChange={(event) => setLevels(levels.map((other, at) => (at === index ? { ...other, label: event.target.value } : other)))}
                />
                <button type="button" className="icon-button" aria-label={t("Remove level")} title={t("Remove level")} onClick={() => setLevels(levels.filter((_, at) => at !== index))}>
                  <Trash2 size={14} />
                </button>
              </div>
              <textarea
                aria-label={t("Request fields (JSON)")}
                className="level-body"
                spellCheck={false}
                rows={2}
                value={prettyBody(item.body)}
                placeholder='{"reasoning_effort": "high"}'
                onChange={(event) => setLevels(levels.map((other, at) => (at === index ? { ...other, body: event.target.value } : other)))}
              />
              {bodyError(item.body) && (
                <span className="voice-error" role="alert">
                  {bodyError(item.body) === "json" ? t("Request fields must be valid JSON.") : t("Request fields must be a JSON object.")}
                </span>
              )}
            </div>
          ))}
          <div className="level-actions">
            <button type="button" className="button secondary" disabled={levels.length >= 8} onClick={() => setLevels([...levels, { value: "", label: "", body: "{}" }])}>
              <Plus size={14} /> {t("Add level")}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={saving || !!problem || !levels.length || !dirty}
              onClick={() => void save({ ...override, reasoning: withIds(levels) })}
            >
              {t("Save levels")}
            </button>
          </div>
          {unnamed && <span className="voice-error" role="alert">{t("Name every level.")}</span>}
        </div>
      )}
      {error && <span className="voice-error" role="alert">{error}</span>}
    </div>
  );
}
