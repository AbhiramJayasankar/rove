import type { ModelInfo, Settings } from "./types";
const order = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const labels: Record<string, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X high",
  max: "Max",
  ultra: "Ultra",
};
export function reasoningOptions(
  _settings: Settings,
  info?: ModelInfo | null,
): { value: string; label: string; description?: string }[] {
  if (!info?.reasoningFormat) return [{ value: "default", label: "Automatic" }];
  if (
    info.reasoningFormat === "thinking" ||
    info.reasoningFormat === "enable_thinking"
  )
    return [
      { value: "none", label: "Thinking off" },
      { value: "high", label: "Thinking on" },
    ];
  const efforts = [
    ...new Set(
      info.reasoningEfforts?.filter((effort) =>
        /^[a-z][a-z0-9_-]{0,39}$/.test(effort),
      ) || [],
    ),
  ];
  if (info.reasoningToggle && !efforts.includes("none"))
    efforts.unshift("none");
  if (!efforts.length) return [{ value: "default", label: "Automatic" }];
  return efforts
    .filter((value) => !info.reasoningAliases?.[value])
    .sort(
      (a, b) =>
        (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) -
        (order.indexOf(b) < 0 ? 99 : order.indexOf(b)),
    )
    .map((value) => ({
      value,
      label: labels[value] || value.charAt(0).toUpperCase() + value.slice(1),
    }));
}
/** Choose the greatest advertised effort for a new model; preserve an explicit valid choice. */
export function resolvedReasoningEffort(
  settings: Settings,
  info?: ModelInfo | null,
): string {
  const choices = reasoningOptions(settings, info);
  const selected = info?.reasoningAliases?.[settings.reasoningEffort] || settings.reasoningEffort;
  if (
    selected !== "default" &&
    choices.some((choice) => choice.value === selected)
  )
    return selected;
  return (
    choices.filter((choice) => !info?.reasoningAliases?.[choice.value]).at(-1)
      ?.value || "default"
  );
}
