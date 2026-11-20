/** Colour themes. Each has a light and a dark set of the same tokens; the CSS reads them as
 *  custom properties (`ink` becomes `--ink`, `accentHover` becomes `--accent-hover`). */
export type Mode = "light" | "dark";
export type PaletteId = "sage" | "harbor" | "heather" | "ochre" | "rosehip" | "graphite";
export type Tokens = {
  ink: string; muted: string; canvas: string; surface: string; line: string; subtle: string; panel: string; field: string;
  accent: string; accentHover: string; accentSoft: string; onAccent: string; switchTrack: string;
  danger: string; warning: string; errorSurface: string; shadow: string; backdrop: string;
  dotIdle: string; dotDone: string; dotWait: string;
};
export type Palette = { id: PaletteId; name: string; light: Tokens; dark: Tokens };

export const PALETTES: Palette[] = [
  {
    id: "sage",
    name: "Sage",
    light: {
      ink: "#272923", muted: "#646a5e", canvas: "#fcfcf9", surface: "#ffffff", line: "#dfe4d8", subtle: "#f1f3ed", panel: "#f2f4ec", field: "#ffffff",
      accent: "#536448", accentHover: "#405037", accentSoft: "#ecf0e6", onAccent: "#ffffff", switchTrack: "#c3c8bc",
      danger: "#aa4b3e", warning: "#936d2d", errorSurface: "#f7ece8", shadow: "#2729231a", backdrop: "#27292336",
      dotIdle: "#b7bcb0", dotDone: "#658151", dotWait: "#b0873f",
    },
    dark: {
      ink: "#e5e8df", muted: "#a1a799", canvas: "#242722", surface: "#2c3029", line: "#454c3d", subtle: "#2c3127", panel: "#2b2f27", field: "#343a2f",
      accent: "#b8c9a5", accentHover: "#ccdbbc", accentSoft: "#363e2e", onAccent: "#20271a", switchTrack: "#626a59",
      danger: "#efa38d", warning: "#d8bb7e", errorSurface: "#42312b", shadow: "#00000040", backdrop: "#00000075",
      dotIdle: "#7d8476", dotDone: "#8fae78", dotWait: "#d8bb7e",
    },
  },
  {
    id: "harbor",
    name: "Harbor",
    light: {
      ink: "#222831", muted: "#626c7a", canvas: "#fafbfc", surface: "#ffffff", line: "#dbe1e8", subtle: "#eff2f6", panel: "#eef2f6", field: "#ffffff",
      accent: "#345c88", accentHover: "#284a70", accentSoft: "#e7eef6", onAccent: "#ffffff", switchTrack: "#bfc7d1",
      danger: "#b0443a", warning: "#8a6420", errorSurface: "#f8ebe9", shadow: "#2228311a", backdrop: "#22283136",
      dotIdle: "#b3bcc7", dotDone: "#3f7a5a", dotWait: "#b0873f",
    },
    dark: {
      ink: "#e3e8ee", muted: "#9aa5b3", canvas: "#1e232a", surface: "#252b33", line: "#3b4552", subtle: "#262d36", panel: "#252b34", field: "#2e3540",
      accent: "#9fc0e6", accentHover: "#b9d2ef", accentSoft: "#2b3747", onAccent: "#14202e", switchTrack: "#556172",
      danger: "#f0a294", warning: "#dcbc7c", errorSurface: "#422f2d", shadow: "#00000045", backdrop: "#00000078",
      dotIdle: "#6b7686", dotDone: "#86c0a0", dotWait: "#dcbc7c",
    },
  },
  {
    id: "heather",
    name: "Heather",
    light: {
      ink: "#2a2530", muted: "#6f6678", canvas: "#fcfafd", surface: "#ffffff", line: "#e4dde9", subtle: "#f4f0f6", panel: "#f3eff6", field: "#ffffff",
      accent: "#6a4c80", accentHover: "#573d6a", accentSoft: "#f0eaf4", onAccent: "#ffffff", switchTrack: "#cbc2d2",
      danger: "#ad4540", warning: "#8a6420", errorSurface: "#f8eae9", shadow: "#2a25301a", backdrop: "#2a253036",
      dotIdle: "#bfb6c7", dotDone: "#4f7d5b", dotWait: "#b0873f",
    },
    dark: {
      ink: "#ebe5ef", muted: "#aa9fb4", canvas: "#241f29", surface: "#2c2632", line: "#4a4054", subtle: "#2d2733", panel: "#2c2633", field: "#362e3e",
      accent: "#cdb2e0", accentHover: "#dcc8ea", accentSoft: "#3a2f45", onAccent: "#261b30", switchTrack: "#66597a",
      danger: "#f0a294", warning: "#dcbc7c", errorSurface: "#43302f", shadow: "#00000045", backdrop: "#00000078",
      dotIdle: "#75697f", dotDone: "#8fbf98", dotWait: "#dcbc7c",
    },
  },
  {
    id: "ochre",
    name: "Ochre",
    light: {
      ink: "#29271f", muted: "#6e6957", canvas: "#f9f9f7", surface: "#ffffff", line: "#e3e0d4", subtle: "#f2f0e8", panel: "#f2f0e7", field: "#ffffff",
      accent: "#7a5b0e", accentHover: "#644a0a", accentSoft: "#f4eed9", onAccent: "#ffffff", switchTrack: "#cac5b4",
      danger: "#ad4a3a", warning: "#7a5b0e", errorSurface: "#f7ebe7", shadow: "#29271f1a", backdrop: "#29271f36",
      dotIdle: "#bdb8a8", dotDone: "#5d7d45", dotWait: "#c08a1e",
    },
    dark: {
      ink: "#ece8dc", muted: "#aaa48f", canvas: "#23211b", surface: "#2b2922", line: "#48443a", subtle: "#2c2a23", panel: "#2b2922", field: "#353229",
      accent: "#e6c26e", accentHover: "#f0d38f", accentSoft: "#3d3524", onAccent: "#2a2006", switchTrack: "#67614f",
      danger: "#f0a294", warning: "#e6c26e", errorSurface: "#43302b", shadow: "#00000045", backdrop: "#00000078",
      dotIdle: "#736d5d", dotDone: "#a3c08a", dotWait: "#e6c26e",
    },
  },
  {
    id: "rosehip",
    name: "Rosehip",
    light: {
      ink: "#2d2427", muted: "#74646a", canvas: "#fdfafa", surface: "#ffffff", line: "#ebdde1", subtle: "#f7eff1", panel: "#f6eef1", field: "#ffffff",
      accent: "#96385a", accentHover: "#7c2c4a", accentSoft: "#f6e8ed", onAccent: "#ffffff", switchTrack: "#d2c2c8",
      danger: "#b0441e", warning: "#8a6420", errorSurface: "#f8ebe5", shadow: "#2d24271a", backdrop: "#2d242736",
      dotIdle: "#c6b6bc", dotDone: "#4f7d5b", dotWait: "#b0873f",
    },
    dark: {
      ink: "#f0e6e9", muted: "#b39fa6", canvas: "#281f22", surface: "#30262a", line: "#523f46", subtle: "#31272b", panel: "#30262b", field: "#3a2e33",
      accent: "#eaa8c0", accentHover: "#f2c2d3", accentSoft: "#45303a", onAccent: "#33141f", switchTrack: "#725b64",
      danger: "#f5ab8a", warning: "#dcbc7c", errorSurface: "#46302a", shadow: "#00000045", backdrop: "#00000078",
      dotIdle: "#7f6a72", dotDone: "#8fbf98", dotWait: "#dcbc7c",
    },
  },
  {
    id: "graphite",
    name: "Graphite",
    light: {
      ink: "#1f2023", muted: "#65686e", canvas: "#fafafa", surface: "#ffffff", line: "#e0e1e4", subtle: "#f1f1f3", panel: "#f0f0f2", field: "#ffffff",
      accent: "#2f3237", accentHover: "#1c1e21", accentSoft: "#ececee", onAccent: "#ffffff", switchTrack: "#c4c6ca",
      danger: "#b0403a", warning: "#85651f", errorSurface: "#f7ebea", shadow: "#1f20231a", backdrop: "#1f202336",
      dotIdle: "#b8babf", dotDone: "#4f7d5b", dotWait: "#b0873f",
    },
    dark: {
      ink: "#e8e9eb", muted: "#a0a3a9", canvas: "#1b1c1e", surface: "#232427", line: "#3c3e43", subtle: "#242528", panel: "#242528", field: "#2e3034",
      accent: "#e2e3e6", accentHover: "#f4f4f6", accentSoft: "#33353a", onAccent: "#1b1c1e", switchTrack: "#5c5f66",
      danger: "#f0a294", warning: "#dcbc7c", errorSurface: "#3f2e2c", shadow: "#00000050", backdrop: "#0000007d",
      dotIdle: "#6c6f76", dotDone: "#8fbf98", dotWait: "#dcbc7c",
    },
  },
];

export const DEFAULT_PALETTE: PaletteId = "sage";
export function paletteById(id: string | null | undefined): Palette {
  return PALETTES.find((palette) => palette.id === id) ?? PALETTES[0];
}
/** Custom properties for one theme and mode, e.g. `{"--ink": "#272923", "--accent-hover": ...}`. */
export function cssVariables(tokens: Tokens): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tokens).map(([key, value]) => [`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value]),
  );
}

function scale(hex: string, factor: number) {
  const channels = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * factor));
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}${hex.slice(7)}`;
}
/** A theme's dark set on pure black, for OLED screens: the page background is #000000 (pixels off),
 *  and raised surfaces keep a trace of the theme's tint so panels still read as panels. */
export function pitchBlack(tokens: Tokens): Tokens {
  return {
    ...tokens,
    canvas: "#000000",
    subtle: scale(tokens.subtle, 0.35),
    surface: scale(tokens.surface, 0.42),
    panel: scale(tokens.panel, 0.42),
    field: scale(tokens.field, 0.55),
    line: scale(tokens.line, 0.7),
    accentSoft: scale(tokens.accentSoft, 0.65),
    errorSurface: scale(tokens.errorSurface, 0.6),
    switchTrack: scale(tokens.switchTrack, 0.85),
    shadow: "#00000000",
    backdrop: "#000000b3",
  };
}
