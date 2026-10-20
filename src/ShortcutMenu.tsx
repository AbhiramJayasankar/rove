import { useEffect, useState } from "react";
import { Slash } from "lucide-react";
import type { Shortcut } from "./shortcuts";
import { useT } from "./i18n";

/** Suggestions above the composer while the message starts with "/". */
export function slashQuery(prompt: string): string | null {
  const match = /^\/(\S*)$/.exec(prompt);
  return match ? match[1].toLowerCase() : null;
}

export function shortcutMatches(shortcuts: Shortcut[], query: string): Shortcut[] {
  return shortcuts.filter((item) => item.name.toLowerCase().includes(query));
}

export default function ShortcutMenu({
  shortcuts,
  query,
  index,
  onPick,
  onSettings,
}: {
  shortcuts: Shortcut[];
  query: string;
  index: number;
  onPick: (shortcut: Shortcut) => void;
  onSettings: () => void;
}) {
  const matches = shortcutMatches(shortcuts, query);
  const t = useT();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <div className="shortcut-menu" role="listbox" aria-label={t("Saved prompts")}>
      {matches.map((item, position) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={position === index}
          className="shortcut-option"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(item)}
        >
          <Slash size={13} aria-hidden="true" />
          <span>
            <strong>{item.name}</strong>
            <small>{item.prompt}</small>
          </span>
        </button>
      ))}
      {!matches.length && (
        <div className="shortcut-empty">
          {shortcuts.length ? t("No saved prompt matches.") : t("No saved prompts yet.")}
          <button type="button" className="text-button" onMouseDown={(event) => event.preventDefault()} onClick={onSettings}>
            {t("Add one in Settings")}
          </button>
        </div>
      )}
    </div>
  );
}
