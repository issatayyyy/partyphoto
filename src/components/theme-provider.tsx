"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { parseTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

const ThemeContext = createContext<{ theme: Theme; toggleTheme: () => void } | null>(null);

function readPreference() {
  try { return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY)); }
  catch { return null; }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The first React render matches SSR. The head script has already applied
  // the actual colors; the effect synchronizes the button after hydration.
  const [theme, setTheme] = useState<Theme>("light");
  const preference = useRef<Theme | null>(null);

  const applyTheme = useCallback((value: Theme) => {
    document.documentElement.dataset.theme = value;
    setTheme(value);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const systemTheme = (): Theme => media.matches ? "dark" : "light";
    preference.current = readPreference();
    applyTheme(preference.current ?? systemTheme());

    function followSystem() {
      if (!preference.current) applyTheme(systemTheme());
    }
    function synchronizeTabs(event: StorageEvent) {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      // Ignore sessionStorage events and continue working when storage access
      // is restricted by browser privacy settings.
      try { if (event.storageArea !== window.localStorage) return; }
      catch { return; }
      preference.current = readPreference();
      applyTheme(preference.current ?? systemTheme());
    }
    media.addEventListener("change", followSystem);
    window.addEventListener("storage", synchronizeTabs);
    return () => {
      media.removeEventListener("change", followSystem);
      window.removeEventListener("storage", synchronizeTabs);
    };
  }, [applyTheme]);

  const toggleTheme = useCallback(() => {
    const next: Theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    preference.current = next;
    applyTheme(next);
    try { window.localStorage.setItem(THEME_STORAGE_KEY, next); }
    catch { /* Keep the choice for this visit even if persistence is blocked. */ }
  }, [applyTheme]);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("Theme controls require ThemeProvider");
  return value;
}
