import { describe, expect, it } from "vitest";
import { PALETTES, cssVariables, paletteById } from "../../src/palettes";

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

describe("colour themes", () => {
  it("every theme defines the same tokens in light and dark", () => {
    const keys = Object.keys(PALETTES[0].light).sort();
    for (const palette of PALETTES) {
      expect(Object.keys(palette.light).sort()).toEqual(keys);
      expect(Object.keys(palette.dark).sort()).toEqual(keys);
    }
  });
  it("text stays readable (WCAG AA) on every background it sits on", () => {
    const failures: string[] = [];
    for (const palette of PALETTES)
      for (const mode of ["light", "dark"] as const) {
        const t = palette[mode];
        const pairs: [string, string, string, number][] = [
          ["ink/canvas", t.ink, t.canvas, 7], ["ink/panel", t.ink, t.panel, 7], ["ink/accentSoft", t.ink, t.accentSoft, 7],
          ["muted/canvas", t.muted, t.canvas, 4.5], ["muted/panel", t.muted, t.panel, 4.5], ["muted/field", t.muted, t.field, 4.5],
          ["accent/canvas", t.accent, t.canvas, 4.5], ["accent/panel", t.accent, t.panel, 4.5], ["onAccent/accent", t.onAccent, t.accent, 4.5],
          ["danger/canvas", t.danger, t.canvas, 4.5], ["danger/errorSurface", t.danger, t.errorSurface, 4.5], ["warning/canvas", t.warning, t.canvas, 4.5],
        ];
        for (const [name, fg, bg, min] of pairs) {
          const ratio = contrast(fg, bg);
          if (ratio < min) failures.push(`${palette.id} ${mode} ${name} ${ratio.toFixed(2)} < ${min}`);
        }
      }
    expect(failures).toEqual([]);
  });
  it("maps tokens to CSS custom properties and falls back to Sage", () => {
    expect(cssVariables(PALETTES[0].light)["--accent-hover"]).toBe("#405037");
    expect(paletteById("nope").id).toBe("sage");
    expect(paletteById("harbor").name).toBe("Harbor");
  });
});
