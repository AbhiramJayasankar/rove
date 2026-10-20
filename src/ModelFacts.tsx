import type { ModelInfo } from "../shared/types";
import { reasoningOptions } from "../shared/capabilities";
import { useT } from "./i18n";

const number = (value: unknown): number | undefined =>
  value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
const grouped = (n: number) => n.toLocaleString();
/** Price per million tokens from either per-token or per-million fields; undefined when the endpoint gave none. */
function perMillion(pricing: Record<string, unknown> | undefined, token: string, million: string): number | undefined {
  const perToken = number(pricing?.[token]);
  if (perToken != null) return perToken * 1_000_000;
  return number(pricing?.[million]);
}
const dollars = (value: number) => `$${value >= 1 ? value.toFixed(2) : value.toFixed(value >= 0.1 ? 2 : 3)}`;
const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n.toLocaleString());

type Row = { label: string; value: string };

/** Everything the endpoint told us about one model, with an explicit "Not reported" for what it left out. */
export function modelFacts(model: ModelInfo, t: ReturnType<typeof useT>): { main: Row[]; extra: Row[] } {
  const unknown = t("Not reported");
  const reported = model.endpointVision ?? model.supportsVision;
  const yesNo = (value: boolean | undefined) => (value === undefined ? unknown : value ? t("Yes") : t("No"));
  const list = (items?: string[]) => (items?.length ? items.join(", ") : unknown);
  const tokens = (n?: number) => (n ? t("{n} tokens", { n: grouped(n) }) : unknown);
  const inputPrice = perMillion(model.pricing, "prompt", "input_usd_per_1m");
  const outputPrice = perMillion(model.pricing, "completion", "output_usd_per_1m");
  const efforts = model.reasoningFormat || model.customReasoning?.length
    ? reasoningOptions({} as never, model).map((option) => option.label).join(" · ")
    : unknown;
  const reasoningKind = model.customReasoning?.length
    ? t("Custom levels")
    : model.reasoningFormat
      ? { reasoning_effort: "reasoning_effort", thinking: "thinking.type", enable_thinking: "enable_thinking", reasoning: "reasoning" }[model.reasoningFormat]
      : "";
  const main: Row[] = [
    { label: t("Context window"), value: tokens(model.contextWindow) },
    { label: t("Max input"), value: tokens(model.maxInputTokens) },
    { label: t("Max output"), value: tokens(model.maxOutputTokens) },
    { label: t("Accepts"), value: list(model.inputModalities ?? (reported === undefined ? undefined : reported ? ["text", "image"] : ["text"])) },
    { label: t("Produces"), value: list(model.outputModalities) },
    { label: t("Tool calling"), value: yesNo(model.supportsTools) },
    { label: t("Image input"), value: model.endpointVision !== undefined && model.endpointVision !== model.supportsVision ? t("{now} (endpoint says {said})", { now: yesNo(model.supportsVision), said: yesNo(model.endpointVision) }) : yesNo(model.supportsVision) },
    { label: t("Reasoning"), value: reasoningKind ? `${efforts} (${reasoningKind})` : efforts },
    {
      label: t("Price per 1M tokens"),
      value: model.free && inputPrice == null ? t("Free") : inputPrice != null && outputPrice != null ? `${dollars(inputPrice)} ${t("in")} · ${dollars(outputPrice)} ${t("out")}${model.free ? ` · ${t("Free")}` : ""}` : unknown,
    },
  ];
  const meta = model.metadata?.meta && typeof model.metadata.meta === "object" ? (model.metadata.meta as Record<string, unknown>) : undefined;
  const extra: Row[] = [];
  if (model.providerName || model.owner) extra.push({ label: t("Provider"), value: [model.providerName, model.owner].filter(Boolean).join(" · ") });
  if (number(meta?.n_params)) extra.push({ label: t("Parameters"), value: compact(Number(meta!.n_params)) });
  if (number(meta?.size)) extra.push({ label: t("File size"), value: size(Number(meta!.size)) });
  if (typeof meta?.ftype === "string") extra.push({ label: t("Quantization"), value: meta.ftype });
  if (number(meta?.n_ctx_train)) extra.push({ label: t("Trained context"), value: tokens(Number(meta!.n_ctx_train)) });
  if (model.outputTokenParameter) extra.push({ label: t("Output limit field"), value: model.outputTokenParameter });
  if (model.supportedParameters?.length) extra.push({ label: t("Accepted parameters"), value: model.supportedParameters.join(", ") });
  if (model.capabilitySources?.length) extra.push({ label: t("Capability sources"), value: model.capabilitySources.join("\n") });
  extra.push({ label: t("Listed by"), value: model.source.replace(/\/models$/, "") });
  return { main, extra };
}

export function ModelFactList({ model, all = false }: { model: ModelInfo; all?: boolean }) {
  const t = useT();
  const { main, extra } = modelFacts(model, t);
  const rows = all ? [...main, ...extra] : main;
  return (
    <dl className="model-facts">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.value === t("Not reported") ? "unreported" : ""}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Full details for the Settings page: the facts above and the endpoint's raw entry for this model. */
export function ModelDetails({ model }: { model: ModelInfo }) {
  const t = useT();
  const raw = JSON.stringify(model.metadata ?? {}, null, 2);
  return (
    <div className="model-details">
      <span className="abilities-title">{t("What the endpoint reports")}</span>
      <ModelFactList model={model} all />
      <details className="raw-details">
        <summary>{t("Raw endpoint data")}</summary>
        <pre>{raw.length > 20000 ? `${raw.slice(0, 20000)}\n…` : raw}</pre>
      </details>
    </div>
  );
}
