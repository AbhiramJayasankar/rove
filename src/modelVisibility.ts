import { useEffect, useState } from "react";

// Per provider, the model IDs shown in the chat picker. A provider with no entry shows everything.
export type VisibleModels = Record<string, string[]>;

export async function readVisibleModels(): Promise<VisibleModels> {
  try {
    const { visibleModels } = await chrome.storage.local.get("visibleModels");
    if (!visibleModels || typeof visibleModels !== "object") return {};
    return Object.fromEntries(
      Object.entries(visibleModels as Record<string, unknown>).map(([provider, ids]) => [
        provider,
        Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
      ]),
    );
  } catch {
    return {};
  }
}

export function useVisibleModels(): VisibleModels {
  const [value, setValue] = useState<VisibleModels>({});
  useEffect(() => {
    void readVisibleModels().then(setValue);
    const changed = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && "visibleModels" in changes) void readVisibleModels().then(setValue);
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, []);
  return value;
}

// Editing state for one provider in Settings; written together with the other settings on Save.
export function useModelVisibility(providerId: string) {
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    let current = true;
    setTouched(false);
    void readVisibleModels().then((map) => {
      if (current) setSelected(map[providerId] ? new Set(map[providerId]) : null);
    });
    return () => {
      current = false;
    };
  }, [providerId]);
  async function save() {
    if (!touched) return;
    const map = await readVisibleModels();
    if (selected) map[providerId] = [...selected];
    else delete map[providerId];
    await chrome.storage.local.set({ visibleModels: map });
    setTouched(false);
  }
  return {
    selected,
    touched,
    change(next: Set<string> | null) {
      setSelected(next);
      setTouched(true);
    },
    save,
  };
}
export type ModelVisibility = ReturnType<typeof useModelVisibility>;
