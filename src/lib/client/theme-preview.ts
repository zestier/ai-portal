import { faviconDataUri, type ThemeAccent } from "$lib/types";

export type ThemeMode = "dark" | "light" | "system";

type ThemeRoot = HTMLElement & { dataset: DOMStringMap };

export type LiveThemePreferenceOptions = {
  theme: ThemeMode;
  accent: ThemeAccent;
  fallbackTheme: ThemeMode;
  fallbackAccent: ThemeAccent;
  root?: ThemeRoot;
  matchMedia?: typeof window.matchMedia;
  favicon?: HTMLLinkElement | null;
};

function resolveSystemTheme(
  matchMediaFn: typeof window.matchMedia | undefined,
): "dark" | "light" {
  return matchMediaFn?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function applyTheme(
  root: ThemeRoot,
  theme: ThemeMode,
  matchMediaFn: typeof window.matchMedia | undefined,
): void {
  root.dataset.themeMode = theme;
  root.dataset.theme =
    theme === "system" ? resolveSystemTheme(matchMediaFn) : theme;
}

function applyAccent(
  root: ThemeRoot,
  accent: ThemeAccent,
  favicon: HTMLLinkElement | null,
): void {
  root.dataset.accent = accent;
  if (favicon) favicon.href = faviconDataUri(accent);
}

export function applyLiveThemePreference(
  options: LiveThemePreferenceOptions,
): () => void {
  if (typeof document === "undefined") return () => {};

  const root = options.root ?? document.documentElement;
  const matchMediaFn = options.matchMedia ?? window.matchMedia?.bind(window);
  const favicon =
    options.favicon ??
    document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const mediaQuery = matchMediaFn?.("(prefers-color-scheme: light)");

  const applySelectedTheme = () =>
    applyTheme(root, options.theme, matchMediaFn);
  applySelectedTheme();
  applyAccent(root, options.accent, favicon);

  if (options.theme === "system") {
    if (mediaQuery?.addEventListener)
      mediaQuery.addEventListener("change", applySelectedTheme);
    else if (mediaQuery?.addListener)
      mediaQuery.addListener(applySelectedTheme);
  }

  return () => {
    if (options.theme === "system") {
      if (mediaQuery?.removeEventListener)
        mediaQuery.removeEventListener("change", applySelectedTheme);
      else if (mediaQuery?.removeListener)
        mediaQuery.removeListener(applySelectedTheme);
    }
    applyTheme(root, options.fallbackTheme, matchMediaFn);
    applyAccent(root, options.fallbackAccent, favicon);
  };
}
