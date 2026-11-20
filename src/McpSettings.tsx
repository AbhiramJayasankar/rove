import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import type { AppState, Settings } from "../shared/types";
import { api } from "./ui";
import { useT } from "./i18n";

const FOLDER_KEY = "rove.folder";
function readFolder() {
  try {
    return localStorage.getItem(FOLDER_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Settings > Tools > Connected apps: lets MCP clients such as Claude Code use Rove. */
export default function McpSettings({ state, draft, update }: {
  state: AppState;
  draft: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const t = useT();
  const [token, setToken] = useState("");
  const [folder, setFolder] = useState(readFolder);
  const [copied, setCopied] = useState("");
  const saved = state.settings.mcpEnabled;
  const status = state.mcp;
  useEffect(() => {
    if (saved) void api<{ token: string }>("/api/mcp").then((info) => setToken(info.token)).catch(() => {});
  }, [saved]);
  const place = folder.trim().replace(/[\\/]+$/, "") || (navigator.userAgent.includes("Windows") ? "C:\\path\\to\\Rove" : "/path/to/Rove");
  const separator = place.includes("\\") ? "\\" : "/";
  const script = `${place}${separator}mcp${separator}rove-mcp.mjs`;
  const claude = `claude mcp add rove --scope user -e ROVE_TOKEN=${token} -- node "${script}"`;
  const config = JSON.stringify({ mcpServers: { rove: { command: "node", args: [script], env: { ROVE_TOKEN: token } } } }, null, 2);
  function copy(key: string, value: string) {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? "" : current)), 1600);
    });
  }
  const rows: [keyof Settings, string, string][] = [
    ["mcpBrowserTools", t("Let apps use the browser tools"), t("The app clicks, types and reads pages itself, in tabs Rove groups for it. Tools you switched off above stay off.")],
    ["mcpRunTasks", t("Let apps hand tasks to Rove"), t("The app gives Rove a whole task, which Rove's own model does in a new tab. It shows in your history.")],
  ];
  return (
    <section className="mcp-settings">
      <h2 className="settings-title">{t("Connected apps")}</h2>
      <div className="panel mcp-panel">
        <div className="tool-row behavior-row">
          <div className="behavior-text">
            <strong>{t("Let apps like Claude Code use Rove")}</strong>
            <small>{t("Through MCP, on this computer only. Off until you turn it on; your site rules apply to every app.")}</small>
          </div>
          <label className="tool-toggle">
            <input type="checkbox" role="switch" aria-label={t("Let apps like Claude Code use Rove")} checked={draft.mcpEnabled}
              onChange={(event) => update("mcpEnabled", event.target.checked)} />
            <span className="switch" aria-hidden="true" />
          </label>
        </div>
        {draft.mcpEnabled && !saved && <p className="mcp-hint">{t("Save changes to turn it on.")}</p>}
        {draft.mcpEnabled && (
          <>
            {rows.map(([key, title, note]) => (
              <div className="tool-row behavior-row" key={key}>
                <div className="behavior-text">
                  <strong>{title}</strong>
                  <small>{note}</small>
                </div>
                <label className="tool-toggle">
                  <input type="checkbox" role="switch" aria-label={title} checked={draft[key] as boolean} onChange={(event) => update(key, event.target.checked as never)} />
                  <span className="switch" aria-hidden="true" />
                </label>
              </div>
            ))}
          </>
        )}
        {saved && (
          <>
            <p className={`mcp-status ${status?.connected ? "on" : ""}`} role="status">
              <span className={`status-dot ${status?.connected ? "completed" : ""}`} aria-hidden="true" />
              {status?.connected
                ? t("Connected: {apps}", { apps: status.clients.join(", ") || t("an MCP app") })
                : t("Waiting for an app. Rove connects within 30 seconds of one starting.")}
            </p>
            <div className="field">
              <span>{t("Rove folder")}</span>
              <input
                value={folder}
                placeholder={place}
                spellCheck={false}
                onChange={(event) => {
                  setFolder(event.target.value);
                  try { localStorage.setItem(FOLDER_KEY, event.target.value); } catch {}
                }}
              />
              <small className="mcp-note">{t("The folder you loaded in chrome://extensions. Needs Node.js 22 or newer.")}</small>
            </div>
            <div className="mcp-command">
              <div className="mcp-command-head">
                <span>{t("Claude Code")}</span>
                <button type="button" className="text-button" onClick={() => copy("claude", claude)}>
                  {copied === "claude" ? <Check size={13} /> : <Copy size={13} />}
                  {copied === "claude" ? t("Copied") : t("Copy")}
                </button>
              </div>
              <code>{claude}</code>
            </div>
            <div className="mcp-command">
              <div className="mcp-command-head">
                <span>{t("Other apps (MCP config)")}</span>
                <button type="button" className="text-button" onClick={() => copy("json", config)}>
                  {copied === "json" ? <Check size={13} /> : <Copy size={13} />}
                  {copied === "json" ? t("Copied") : t("Copy")}
                </button>
              </div>
              <code>{config}</code>
            </div>
            <p className="mcp-note">
              {t("The token stops other programs on this computer from posing as Rove's server. Keep it private.")}{" "}
              <button type="button" className="text-button" onClick={() => {
                if (confirm(t("Make a new token? Apps set up with the old one stop connecting until you update their command.")))
                  void api<{ token: string }>("/api/mcp/token", { method: "POST" }).then((info) => setToken(info.token));
              }}>
                <RefreshCw size={12} />
                {t("New token")}
              </button>
            </p>
            {!!status?.activity.length && (
              <div className="mcp-activity">
                <span className="mcp-activity-title">{t("Recent actions")}</span>
                <ul>
                  {status.activity.slice(0, 6).map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className={entry.ok ? "" : "failed"} title={entry.error}>
                      <span className="mcp-tool">{entry.tool}</span>
                      <span className="mcp-client">{entry.client}</span>
                      <time>{new Date(entry.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
