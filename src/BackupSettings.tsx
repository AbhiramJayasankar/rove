import { useRef, useState } from "react";
import { Download, LoaderCircle, Upload } from "lucide-react";
import { api, json } from "./ui";
import { useT } from "./i18n";

/** Display preferences kept in the page's own storage, carried in the backup too. */
const UI_KEYS = ["relay.theme", "relay.palette", "relay.black", "rove.language", "relay.freeModels"];

export default function BackupSettings({ busy }: { busy: boolean }) {
  const t = useT();
  const [withKeys, setWithKeys] = useState(true);
  const [working, setWorking] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  async function exportBackup() {
    setWorking("export");
    setMessage(null);
    try {
      const backup = await api<Record<string, unknown>>(`/api/backup${withKeys ? "?keys=1" : ""}`);
      const ui = Object.fromEntries(UI_KEYS.map((key) => [key, localStorage.getItem(key)]).filter(([, value]) => value !== null));
      const blob = new Blob([JSON.stringify({ ...backup, ui }, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `rove-settings-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      setMessage({ ok: true, text: withKeys ? t("Saved. The file holds your API keys; keep it private.") : t("Saved, without API keys.") });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setWorking("");
    }
  }
  async function restore(chosen: File) {
    setWorking("restore");
    setMessage(null);
    try {
      let backup: any;
      try {
        backup = JSON.parse(await chosen.text());
      } catch {
        throw new Error(t("This file is not a Rove settings backup."));
      }
      await api("/api/backup", { method: "POST", body: json(backup) });
      if (backup.ui && typeof backup.ui === "object")
        for (const key of UI_KEYS) if (typeof backup.ui[key] === "string") localStorage.setItem(key, backup.ui[key]);
      setMessage({ ok: true, text: t("Settings restored. Rove is reloading to show them.") });
      // Voice, saved prompts and display preferences are read when the page loads.
      setTimeout(() => location.reload(), 900);
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
      setWorking("");
    }
  }
  return (
    <section className="backup-settings">
      <h2 className="settings-title">{t("Backup")}</h2>
      <div className="panel backup-panel">
        <p className="backup-note">
          {t("Save your providers, instructions, saved prompts and tool settings to a file, and restore them in another Chrome profile. Chat history is not included.")}
        </p>
        <label className="backup-keys">
          <input type="checkbox" checked={withKeys} onChange={(event) => setWithKeys(event.target.checked)} />
          {t("Include API keys")}
        </label>
        <div className="backup-actions">
          <button type="button" className="button secondary" disabled={!!working} onClick={() => void exportBackup()}>
            {working === "export" ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
            {t("Save backup")}
          </button>
          <button type="button" className="button secondary" disabled={!!working || busy} onClick={() => file.current?.click()}>
            {working === "restore" ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
            {t("Restore from file")}
          </button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = "";
              if (chosen) void restore(chosen);
            }}
          />
        </div>
        {message && (
          <p role="status" className={message.ok ? "backup-ok" : "backup-error"}>
            {message.text}
          </p>
        )}
      </div>
    </section>
  );
}
