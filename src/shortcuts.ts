import { useEffect, useState } from "react";

export type Shortcut = { id: string; name: string; prompt: string; startUrl?: string };

const KEY = "shortcuts";
const clean = (value: unknown): Shortcut[] =>
  Array.isArray(value)
    ? value
        .filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.prompt === "string")
        .map((item) => ({
          id: item.id,
          name: item.name.slice(0, 60),
          prompt: item.prompt.slice(0, 20000),
          ...(typeof item.startUrl === "string" && item.startUrl ? { startUrl: item.startUrl.slice(0, 2000) } : {}),
        }))
    : [];

export async function readShortcuts(): Promise<Shortcut[]> {
  try {
    return clean((await chrome.storage.local.get(KEY))[KEY]);
  } catch {
    return [];
  }
}

/** Live list for the composer. */
export function useShortcuts(): Shortcut[] {
  const [items, setItems] = useState<Shortcut[]>([]);
  useEffect(() => {
    void readShortcuts().then(setItems);
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && KEY in changes) void readShortcuts().then(setItems);
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  return items;
}

/** Draft list for Settings; written with the other settings on Save. */
export function useShortcutsEditor() {
  const [items, setItems] = useState<Shortcut[]>([]);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    void readShortcuts().then(setItems);
  }, []);
  return {
    items,
    touched,
    change(next: Shortcut[]) {
      setItems(next);
      setTouched(true);
    },
    async save() {
      if (!touched) return;
      await chrome.storage.local.set({ [KEY]: clean(items) });
      setTouched(false);
    },
  };
}
export type ShortcutsEditor = ReturnType<typeof useShortcutsEditor>;

/** What a chosen shortcut puts in the composer. */
export function shortcutText(shortcut: Shortcut): string {
  return shortcut.startUrl ? `Start at ${shortcut.startUrl}. ${shortcut.prompt}` : shortcut.prompt;
}
