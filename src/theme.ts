export type Theme = "light" | "dark";
export function readTheme(): Theme {
  const saved = localStorage.getItem("relay.theme");
  return saved === "light" || saved === "dark"
    ? saved
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
}
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#242722" : "#fcfcf9");
  localStorage.setItem("relay.theme", theme);
}
