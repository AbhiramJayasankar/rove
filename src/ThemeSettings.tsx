import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import { PALETTES, cssVariables } from "./palettes";
import { themeTokens, type Appearance, type ModePreference } from "./theme";
import { useT } from "./i18n";

const MODES: [ModePreference, string][] = [
  ["system", "Match Chrome"],
  ["light", "Light"],
  ["dark", "Dark"],
];

/** Theme and light/dark choice. Each swatch is a small Rove chat drawn in that theme's own colours. */
export default function ThemeSettings({ appearance }: { appearance: Appearance }) {
  const t = useT();
  const { preference, palette, mode, black, setPreference, setPalette, setBlack } = appearance;
  return (
    <section className="theme-settings">
      <h2 className="settings-title">{t("Appearance")}</h2>
      <div className="panel theme-panel">
        <div className="mode-switch" role="radiogroup" aria-label={t("Light or dark")}>
          {MODES.map(([value, label]) => (
            <button
              type="button"
              role="radio"
              key={value}
              aria-checked={preference === value}
              className={preference === value ? "selected" : ""}
              onClick={() => setPreference(value)}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <div className="tool-row behavior-row black-row">
          <div className="behavior-text">
            <strong>{t("Pitch black in dark mode")}</strong>
            <small>{t("Pure black backgrounds for OLED screens, where black pixels are switched off.")}</small>
          </div>
          <label className="tool-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-label={t("Pitch black in dark mode")}
              checked={black}
              onChange={(event) => setBlack(event.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
          </label>
        </div>
        <div className="theme-grid" role="radiogroup" aria-label={t("Theme")}>
          {PALETTES.map((option) => {
            const selected = option.id === palette;
            return (
              <button
                type="button"
                role="radio"
                key={option.id}
                aria-checked={selected}
                aria-label={option.name}
                className={`theme-swatch${selected ? " selected" : ""}`}
                onClick={() => setPalette(option.id)}
              >
                <span className="theme-preview" style={cssVariables(themeTokens(option.id, mode, black)) as CSSProperties} aria-hidden="true">
                  <span className="preview-ask" />
                  <span className="preview-line" />
                  <span className="preview-line short" />
                  <span className="preview-composer">
                    <span className="preview-send" />
                  </span>
                </span>
                <span className="theme-name">
                  {option.name}
                  {selected && <Check size={13} aria-hidden="true" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
