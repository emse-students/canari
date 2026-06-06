/**
 * Centralised theme preference store.
 *
 * Persists to localStorage under `canari-theme`. Falls back to the OS
 * `prefers-color-scheme` media query when no saved preference exists.
 * Applies the theme by setting `data-theme` on `<html>`.
 */

const THEME_KEY = 'canari-theme';

type Theme = 'dark' | 'light';

function readPreference(): Theme {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  }
  return 'light';
}

function applyToDocument(dark: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

let isDark = $state(false);

export const themeStore = {
  /** Whether dark mode is currently active. */
  get isDark(): boolean {
    return isDark;
  },

  /**
   * Reads the saved preference (or OS preference) and applies the theme.
   * Must be called once inside `onMount` in the root layout.
   */
  init(): void {
    isDark = readPreference() === 'dark';
    applyToDocument(isDark);
  },

  /** Toggles between light and dark mode and persists the new preference. */
  toggle(): void {
    isDark = !isDark;
    applyToDocument(isDark);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
    }
  },
};
