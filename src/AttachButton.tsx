import { useRef } from "react";
import { createPortal } from "react-dom";
import { Camera, Paperclip, Upload } from "lucide-react";
import { usePopover } from "./Popover";
import { api } from "./ui";
import { useT } from "./i18n";
import { ACCEPT, MAX_ATTACHMENTS, readAttachment, screenshotAttachment, type Attachment } from "./attachments";

export default function AttachButton({
  tabId,
  count,
  disabled,
  onAdd,
  onError,
}: {
  tabId?: number;
  count: number;
  disabled?: boolean;
  onAdd: (items: Attachment[]) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const popup = usePopover({ width: 250 });
  const input = useRef<HTMLInputElement>(null);
  const full = count >= MAX_ATTACHMENTS;
  async function pick(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_ATTACHMENTS - count;
    const added: Attachment[] = [];
    for (const file of Array.from(files).slice(0, room)) {
      try {
        added.push(await readAttachment(file));
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    }
    if (files.length > room) onError(`Only ${MAX_ATTACHMENTS} attachments per message.`);
    if (added.length) onAdd(added);
    if (input.current) input.current.value = "";
  }
  async function screenshot() {
    popup.close();
    try {
      const shot = await api<{ dataUrl?: string; title?: string }>("/api/browser", {
        method: "POST",
        body: JSON.stringify({ action: "browser_screenshot", args: { tabId } }),
      });
      if (!shot.dataUrl) throw new Error("No screenshot was returned.");
      onAdd([screenshotAttachment(shot.dataUrl, shot.title || "")]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <>
      <input ref={input} type="file" multiple hidden accept={ACCEPT} aria-label={t("Attach files")} onChange={(event) => void pick(event.target.files)} />
      <button
        ref={popup.trigger}
        type="button"
        className="voice-button attach-button"
        aria-label={t("Attach")}
        title={full ? t("Up to {n} attachments", { n: MAX_ATTACHMENTS }) : t("Attach files or a screenshot")}
        aria-haspopup="menu"
        aria-expanded={popup.open}
        disabled={disabled || full}
        onClick={() => popup.setOpen(!popup.open)}
      >
        <Paperclip size={15} />
      </button>
      {popup.open &&
        createPortal(
          <div ref={popup.panel} role="menu" aria-label={t("Attach")} className="choice-menu anchored-popover" style={popup.style}>
            <button type="button" role="menuitem" className="choice-option attach-option" onClick={() => { popup.close(); input.current?.click(); }}>
              <Upload size={14} aria-hidden="true" />
              <span><strong>{t("Upload files")}</strong><small>{t("Images or text, up to 5 MB each")}</small></span>
            </button>
            <button type="button" role="menuitem" className="choice-option attach-option" disabled={!tabId} onClick={() => void screenshot()}>
              <Camera size={14} aria-hidden="true" />
              <span><strong>{t("Screenshot of this tab")}</strong><small>{tabId ? t("Adds what the tab shows now") : t("Choose a tab first")}</small></span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
