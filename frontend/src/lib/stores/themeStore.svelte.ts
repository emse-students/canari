/**
 * Centralised theme preference store.
 *
 * Persists the *preference* (`dark` | `light` | `system`) to localStorage under
 * `canari-theme`. In `system` mode the active theme follows the OS
 * `prefers-color-scheme` media query **and updates live** when the OS theme
 * changes. Applies the theme by setting `data-theme` on `<html>`.
 */

const THEME_KEY = 'canari-theme';

/** User-facing preference. `system` defers to the OS and tracks live changes. */
export type ThemePreference = 'dark' | 'light' | 'system';

function readPreference(): ThemePreference {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
  }
  return 'system';
}

function osPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Resolves the concrete dark/light state from a preference. */
function resolveIsDark(pref: ThemePreference): boolean {
  return pref === 'system' ? osPrefersDark() : pref === 'dark';
}

function applyToDocument(dark: boolean): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

let preference = $state<ThemePreference>('system');
let isDark = $state(false);
let osListenerAttached = false;

/**
 * Attache (une seule fois) un écouteur sur la media query OS qui ne met à jour le
 * thème que lorsque la préférence est `system`. Permet de suivre en direct un
 * changement de thème système app ouverte.
 */
function attachOsListener(): void {
  if (
    osListenerAttached ||
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  )
    return;
  osListenerAttached = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (preference !== 'system') return;
    isDark = e.matches;
    applyToDocument(isDark);
  });
}

export const themeStore = {
  /** Whether dark mode is currently active (resolved from the preference). */
  get isDark(): boolean {
    return isDark;
  },

  /** The persisted preference (`dark` | `light` | `system`). */
  get preference(): ThemePreference {
    return preference;
  },

  /**
   * Reads the saved preference (default `system`), applies the theme, and arms the
   * live OS-theme listener. Must be called once inside `onMount` in the root layout.
   */
  init(): void {
    preference = readPreference();
    isDark = resolveIsDark(preference);
    applyToDocument(isDark);
    attachOsListener();
  },

  /** Sets an explicit preference (`dark` | `light` | `system`), applies and persists it. */
  setPreference(pref: ThemePreference): void {
    preference = pref;
    isDark = resolveIsDark(pref);
    applyToDocument(isDark);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THEME_KEY, pref);
    }
    attachOsListener();
  },

  /**
   * Toggles light/dark by setting an **explicit** preference (leaves `system` mode).
   * Preserves the existing toggle-switch behaviour.
   */
  toggle(): void {
    themeStore.setPreference(isDark ? 'light' : 'dark');
  },
};
