import type { Settings } from "../shared/types";

// A provider-neutral estimate, not the model's tokenizer. Image cost is separate
// from its base64 transport size. Actual prompt usage is logged by the provider.
export function estimateTokens(value: unknown): number {
  let imageTokens = 0;
  const text =
    JSON.stringify(value, (_key, item) => {
      if (item?.type === "image_url") {
        imageTokens += 4096;
        return { type: "image_url", image_url: "[image]" };
      }
      return item;
    }) || "";
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3) + imageTokens;
}

export function compactContext(
  messages: any[],
  settings: Settings,
  tools: unknown,
) {
  let images = 0;
  let removedImages = 0;
  for (let index = messages.length - 1; index >= 2; index--) {
    const message = messages[index];
    if (!Array.isArray(message.content)) continue;
    const hadImage = message.content.some(
      (part: any) => part.type === "image_url",
    );
    message.content = message.content.filter((part: any) => {
      if (part.type !== "image_url") return true;
      if (++images <= settings.maxImages) return true;
      removedImages++;
      return false;
    });
    if (
      hadImage &&
      !message.content.some((part: any) => part.type === "image_url")
    )
      message.content = [
        {
          type: "text",
          text: "[Older screenshot omitted; associated tool results remain above.]",
        },
      ];
  }
  const budget = Math.max(
    1024,
    settings.contextWindow - settings.maxOutputTokens - 2048,
  );
  let droppedMessages = 0;
  // Preserve original instructions/task and the newest complete tool-call group.
  while (estimateTokens([messages, tools]) > budget) {
    const starts = messages.flatMap((m, i) =>
      i >= 2 && m.role === "assistant" ? [i] : [],
    );
    if (starts.length <= 1) break;
    const count = starts[1] - 2;
    messages.splice(2, count);
    droppedMessages += count;
  }
  const estimatedTokens = estimateTokens([messages, tools]);
  if (estimatedTokens > budget)
    throw new Error(
      "The latest observation exceeds the configured context budget. Increase the context window or request a smaller snapshot.",
    );
  return {
    estimatedTokens,
    contextWindow: settings.contextWindow,
    reservedOutputTokens: settings.maxOutputTokens,
    droppedMessages,
    removedImages,
  };
}
