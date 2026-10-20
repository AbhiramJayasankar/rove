export type Attachment = {
  id: string;
  name: string;
  kind: "image" | "text";
  mime: string;
  size: number;
  dataUrl?: string;
  text?: string;
};

export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 5_000_000;
export const MAX_TEXT_CHARS = 200_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|html?|xml|ya?ml|toml|ini|js|ts|tsx|jsx|py|css|sql|sh)$/i;
export const ACCEPT = [...IMAGE_TYPES, ".txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.html,.htm,.xml,.yaml,.yml,.toml,.ini,.js,.ts,.tsx,.jsx,.py,.css,.sql,.sh"].join(",");

function readAs<T extends string>(file: Blob, mode: "dataUrl" | "text"): Promise<T> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as T);
    reader.onerror = () => reject(new Error(`Could not read ${(file as File).name || "the file"}.`));
    mode === "dataUrl" ? reader.readAsDataURL(file) : reader.readAsText(file);
  });
}

/** Turn a chosen file into an attachment, or throw a message the user can act on. */
export async function readAttachment(file: File): Promise<Attachment> {
  if (IMAGE_TYPES.includes(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} is larger than 5 MB. Attach a smaller image.`);
    return { id: crypto.randomUUID(), name: file.name, kind: "image", mime: file.type, size: file.size, dataUrl: await readAs<string>(file, "dataUrl") };
  }
  if (file.type.startsWith("text/") || TEXT_FILE.test(file.name) || file.type === "application/json") {
    const text = await readAs<string>(file, "text");
    if (text.includes("\u0000")) throw new Error(`${file.name} looks like a binary file. Attach text or an image.`);
    if (text.length > MAX_TEXT_CHARS) throw new Error(`${file.name} is longer than ${MAX_TEXT_CHARS.toLocaleString()} characters. Attach a shorter excerpt.`);
    return { id: crypto.randomUUID(), name: file.name, kind: "text", mime: file.type || "text/plain", size: file.size, text };
  }
  throw new Error(`${file.name || "That file"} is not an image or a text file.`);
}

export function screenshotAttachment(dataUrl: string, title: string): Attachment {
  const name = `${(title || "tab").replace(/[^\w .-]+/g, " ").trim().slice(0, 40) || "tab"} screenshot.jpg`;
  return { id: crypto.randomUUID(), name, kind: "image", mime: "image/jpeg", size: Math.round((dataUrl.length * 3) / 4), dataUrl };
}

/** What is sent to the extension with a message. */
export function attachmentPayload(items: Attachment[]) {
  return items.map(({ name, mime, kind, size, dataUrl, text }) => ({ name, mime, kind, size, ...(kind === "image" ? { dataUrl } : { text }) }));
}
