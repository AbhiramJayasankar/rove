import { useState } from "react";
import { Image, ImageOff } from "lucide-react";
import type { ModelInfo, ModelOverride } from "../shared/types";
import { useT } from "./i18n";
import { api } from "./ui";

/** Next override when the user flips images for a model; undefined images means "follow the endpoint". */
export function imageOverride(model: ModelInfo, on: boolean): ModelOverride | null {
  const endpointOn = (model.endpointVision ?? model.supportsVision) !== false;
  const next: ModelOverride = { ...model.override, images: on === endpointOn ? undefined : on ? "on" : "off" };
  if (!next.images) delete next.images;
  return next.images || next.reasoning?.length ? next : null;
}

/** Composer switch between image mode (screenshots, image attachments) and text-only mode for the current model. */
export default function ImageModeToggle({
  model,
  endpoint,
  disabled,
  onError,
}: {
  model: ModelInfo;
  endpoint: string;
  disabled?: boolean;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const on = model.supportsVision !== false;
  const endpointOn = (model.endpointVision ?? model.supportsVision) !== false;
  const title = on
    ? t("Image mode: the model sees screenshots and image attachments. Click for text only.")
    : t("Text-only mode: no screenshots or images; the model reads page text. Click to send images.");
  const warning = on && !endpointOn ? ` ${t("The endpoint says this model cannot see images.")}` : "";
  async function flip() {
    setSaving(true);
    onError("");
    try {
      await api("/api/model-override", {
        method: "PUT",
        body: JSON.stringify({ baseUrl: endpoint, model: model.id, override: imageOverride(model, !on) }),
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <button
      type="button"
      className={`voice-button image-mode ${on ? "" : "text-only"}`}
      aria-label={t("Image mode")}
      aria-pressed={on}
      title={title + warning}
      disabled={disabled || saving}
      onClick={() => void flip()}
    >
      {on ? <Image size={16} /> : <ImageOff size={16} />}
    </button>
  );
}
