export const themeOptions = [
  { label: "跟随系统", value: "system" },
  { label: "白天", value: "light" },
  { label: "夜间", value: "dark" },
];

export const themeStorageKey = "owner-config-theme";

export function normalizeTheme(value) {
  return themeOptions.some((option) => option.value === value) ? value : "system";
}

export function readTheme(storage = window.localStorage) {
  return normalizeTheme(storage.getItem(themeStorageKey));
}

export function applyTheme(theme, options = {}) {
  const normalized = normalizeTheme(theme);
  const root = options.root ?? document.documentElement;
  const prefersDark = options.prefersDark ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = normalized;
  root.classList.toggle("dark", normalized === "dark" || (normalized === "system" && prefersDark));
  return normalized;
}

export function saveTheme(theme, storage = window.localStorage, options = {}) {
  const normalized = applyTheme(theme, options);
  storage.setItem(themeStorageKey, normalized);
  return normalized;
}
