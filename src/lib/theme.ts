export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "partyphoto-theme";

export function parseTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

// Runs synchronously in <head>, before the page can paint. The string contains
// only application constants, never request data or user-provided JavaScript.
export const themeInitScript = `(()=>{let theme;try{theme=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch{}if(theme!=="light"&&theme!=="dark"){theme=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.dataset.theme=theme})();`;
