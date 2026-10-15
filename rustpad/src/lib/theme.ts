import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const KEY = "theme";
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "dark" || stored === "light") return stored;
    // Carry over the editor's old boolean preference.
    if (localStorage.getItem("darkMode") === "false") return "light";
  } catch {
    // Storage can be blocked; fall through to the default.
  }
  return "dark";
}

let current: Theme = read();

function apply(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

apply(current);

export function setTheme(theme: Theme) {
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not persisted; still applied for this page.
  }
  apply(theme);
  listeners.forEach((listener) => listener());
}

export function toggleTheme() {
  setTheme(current === "dark" ? "light" : "dark");
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
