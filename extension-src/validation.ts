import { z } from "zod";
import { DEFAULT_PROMPT, DEFAULT_SETTINGS } from "../shared/defaults";
import type { Settings } from "../shared/types";
const record = z.record(z.string(), z.unknown());
const automaticSettings = {
  contextMode: "auto",
  reasoningFormat: "auto",
  stream: true,
  vision: true,
  maxImages: DEFAULT_SETTINGS.maxImages,
} as const;
export const settingsSchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? { ...value, ...automaticSettings }
      : value,
  z.object({
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
    memory: z.string().max(20000).default(""),
    siteRules: z
      .array(
        z.object({
          pattern: z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/).max(253),
          action: z.enum(["allow", "ask", "block"]),
        }),
      )
      .max(200)
      .default([]),
    maxSteps: z.number().int().min(1).max(200),
    contextMode: z.literal("auto").default("auto"),
    contextWindow: z
      .number()
      .int()
      .min(4096)
      .max(4000000)
      .default(DEFAULT_SETTINGS.contextWindow),
    maxOutputTokens: z
      .number()
      .int()
      .min(256)
      .max(256000)
      .default(DEFAULT_SETTINGS.maxOutputTokens),
    maxImages: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(DEFAULT_SETTINGS.maxImages),
    reasoningEffort: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,39}$/)
      .default("default"),
    reasoningFormat: z.literal("auto").default("auto"),
    stream: z.literal(true).default(true),
    modelTimeoutSeconds: z.number().int().min(15).max(1800).default(300),
    approvalMode: z.enum(["always", "risky", "never"]),
    vision: z.literal(true).default(true),
    disabledTools: z.array(z.string()).max(100),
  }),
);

/** Read/save migration: keep compatible model settings, discard removed options. */
export function normalizeSettings(value: unknown): Settings {
  const saved: Record<string, unknown> =
    value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  // The app was renamed from Relay to Rove. An untouched saved default prompt follows the rename.
  if (saved.systemPrompt === DEFAULT_PROMPT.replaceAll("Rove", "Relay"))
    saved.systemPrompt = DEFAULT_PROMPT;
  return settingsSchema.parse({
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
  }) as Settings;
}

export { record, z };
