import { useEffect, useState } from "react";
import { DEFAULT_PALETTE, cssVariables, paletteById, type Mode, type PaletteId } from "./palettes";

/** "system" follows Chrome's light or dark setting. Stored under relay.theme (absent means system). */
export type ModePreference = Mode | "system";
const MODE_KEY = "relay.theme";
const PALETTE_KEY = "relay.palette";

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the choice then lasts until the page closes.
  }
}
const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

export function readModePreference(): ModePreference {
  const saved = read(MODE_KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}
export function readPalette(): PaletteId {
  return paletteById(read(PALETTE_KEY)).id;
}
export function resolveMode(preference: ModePreference): Mode {
  return preference === "system" ? (systemDark() ? "dark" : "light") : preference;
}

/** Paint the page with the saved theme and mode. */
export function applyTheme(preference = readModePreference(), paletteId = readPalette()) {
  const mode = resolveMode(preference);
  const tokens = paletteById(paletteId)[mode];
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.dataset.palette = paletteId;
  root.style.colorScheme = mode;
  for (const [name, value] of Object.entries(cssVariables(tokens))) root.style.setProperty(name, value);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", tokens.canvas);
}

export type Appearance = ReturnType<typeof useAppearance>;
/** The saved theme and mode, kept in step with other Rove panels and with Chrome's dark setting. */
export function useAppearance() {
  const [preference, setPreferenceState] = useState(readModePreference);
  const [palette, setPaletteState] = useState(readPalette);
  const [systemMode, setSystemMode] = useState(() => resolveMode("system"));
  useEffect(() => applyTheme(preference, palette), [preference, palette, systemMode]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const onSystem = () => setSystemMode(media.matches ? "dark" : "light");
    const onStorage = (event: StorageEvent) => {
      if (event.key !== MODE_KEY && event.key !== PALETTE_KEY && event.key !== null) return;
      setPreferenceState(readModePreference());
      setPaletteState(readPalette());
    };
    media.addEventListener("change", onSystem);
    addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onSystem);
      removeEventListener("storage", onStorage);
    };
  }, []);
  return {
    preference,
    palette,
    mode: preference === "system" ? systemMode : preference,
    setPreference(next: ModePreference) {
      write(MODE_KEY, next === "system" ? null : next);
      setPreferenceState(next);
    },
    setPalette(next: PaletteId) {
      write(PALETTE_KEY, next === DEFAULT_PALETTE ? null : next);
      setPaletteState(next);
    },
  };
}
