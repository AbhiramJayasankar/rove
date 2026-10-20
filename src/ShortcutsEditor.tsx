import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Shortcut, ShortcutsEditor as Editor } from "./shortcuts";

const blank = (): Shortcut => ({ id: crypto.randomUUID(), name: "", prompt: "", startUrl: "" });

export default function ShortcutsEditor({ editor }: { editor: Editor }) {
  const [editing, setEditing] = useState<Shortcut | null>(null);
  const valid = !!editing && !!editing.name.trim() && !!editing.prompt.trim();
  function commit() {
    if (!editing || !valid) return;
    const next = { ...editing, name: editing.name.trim(), prompt: editing.prompt.trim(), startUrl: editing.startUrl?.trim() || undefined };
    editor.change(editor.items.some((item) => item.id === next.id) ? editor.items.map((item) => (item.id === next.id ? next : item)) : [...editor.items, next]);
    setEditing(null);
  }
  return (
    <>
      <div className="settings-heading">
        <h2 className="settings-title">Saved prompts</h2>
        <button type="button" className="icon-button" aria-label="Add saved prompt" title="Add saved prompt" onClick={() => setEditing(blank())}>
          <Plus size={17} />
        </button>
      </div>
      <div className="panel shortcuts-panel">
        {!editor.items.length && !editing && <p className="rules-empty">Type / in the message box to use a saved prompt. Add your first one with the plus button.</p>}
        {editor.items.map((item) => (
          <div className="shortcut-row" key={item.id}>
            <span>
              <strong>/{item.name}</strong>
              <small>{item.prompt}</small>
            </span>
            <button type="button" className="icon-button" aria-label={`Edit ${item.name}`} onClick={() => setEditing({ ...item, startUrl: item.startUrl ?? "" })}>
              <Pencil size={14} />
            </button>
            <button type="button" className="icon-button" aria-label={`Delete ${item.name}`} onClick={() => editor.change(editor.items.filter((other) => other.id !== item.id))}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {editing && (
          <div className="shortcut-form">
            <label className="field">
              <span>Name</span>
              <input value={editing.name} maxLength={60} placeholder="daily-news" onChange={(event) => setEditing({ ...editing, name: event.target.value })} autoFocus />
            </label>
            <label className="field">
              <span>Prompt</span>
              <textarea value={editing.prompt} rows={4} placeholder="Open Hacker News and summarize the top five stories." onChange={(event) => setEditing({ ...editing, prompt: event.target.value })} />
            </label>
            <label className="field">
              <span>Start page (optional)</span>
              <input type="url" value={editing.startUrl ?? ""} placeholder="https://news.ycombinator.com" onChange={(event) => setEditing({ ...editing, startUrl: event.target.value })} />
            </label>
            <div className="shortcut-actions">
              <button type="button" className="button secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button type="button" className="button primary" disabled={!valid} onClick={commit}>
                Keep prompt
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
