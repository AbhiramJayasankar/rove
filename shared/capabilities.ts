import type { ModelInfo, Settings } from "./types";

export function reasoningOptions(
  settings: Settings,
  info?: ModelInfo | null,
): { value: Settings["reasoningEffort"]; label: string }[] {
  const format =
    settings.reasoningFormat === "auto"
      ? info?.reasoningFormat
      : settings.reasoningFormat;
  const base: { value: Settings["reasoningEffort"]; label: string }[] = [
    {
      value: "default",
      label: format ? "Thinking: default" : "Thinking: provider default",
    },
  ];
  if (!format) return base;
  if (format === "thinking" || format === "enable_thinking")
    return [
      ...base,
      { value: "none", label: "Thinking: off" },
      { value: "high", label: "Thinking: on" },
    ];
  const efforts = info?.reasoningEfforts || ["none", "low", "medium", "high"];
  return [
    ...base,
    ...efforts
      .filter((effort) => /^[a-z][a-z0-9_-]{0,39}$/.test(effort))
      .map((value) => ({ value, label: `Think: ${value}` })),
  ];
}
