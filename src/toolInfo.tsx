import type { ToolDefinition } from "../shared/types";

type Translate = (text: string, vars?: Record<string, string | number>) => string;
type Property = { type?: string; enum?: unknown[]; minimum?: number; maximum?: number; maxLength?: number; items?: Property };

/** Plain-language type of one input, e.g. "whole number" or "one of: left, right". */
export function inputType(property: Property, t: Translate): string {
  if (property.enum) return t("one of: {values}", { values: property.enum.join(", ") });
  switch (property.type) {
    case "string":
      return t("text");
    case "integer":
      return t("whole number");
    case "number":
      return t("number");
    case "boolean":
      return t("yes or no");
    case "array":
      return property.items?.type === "string" ? t("list of text") : t("list");
    case "object":
      return t("object");
    default:
      return t("value");
  }
}

export const riskLabel = (risk: ToolDefinition["risk"], t: Translate) =>
  risk === "read" ? t("Look") : risk === "write" ? t("Act") : t("Dangerous");

export const riskExplanation = (risk: ToolDefinition["risk"], t: Translate) =>
  risk === "read"
    ? t("Only reads or observes. It never changes a page.")
    : risk === "write"
      ? t("Changes pages or files: clicks, typing, navigation, downloads and similar.")
      : t("Can run code or raw browser commands on a page. Off by default.");

export const approvalNote = (risk: ToolDefinition["risk"], t: Translate) =>
  risk === "read"
    ? t("Never asks for approval.")
    : t("Asks first in Ask first mode, and whenever a site rule says Ask.");

/** Everything a person needs to know about one tool, in one tooltip. */
export function ToolDetails({ tool, t }: { tool: ToolDefinition; t: Translate }) {
  const properties = Object.entries((tool.parameters.properties ?? {}) as Record<string, Property>);
  const required = new Set((tool.parameters.required ?? []) as string[]);
  return (
    <div className="tool-details">
      <strong className="tool-details-name">{tool.name}</strong>
      <p>{tool.description}</p>
      <p>
        <b>{riskLabel(tool.risk, t)}.</b> {riskExplanation(tool.risk, t)}
      </p>
      <p>{approvalNote(tool.risk, t)}</p>
      <b className="tool-details-heading">{t("Inputs")}</b>
      {properties.length ? (
        <ul>
          {properties.map(([name, property]) => (
            <li key={name}>
              <code>{name}</code> <span>{inputType(property, t)}</span>
              <em>{required.has(name) ? t("required") : t("optional")}</em>
            </li>
          ))}
        </ul>
      ) : (
        <p>{t("None")}</p>
      )}
    </div>
  );
}
