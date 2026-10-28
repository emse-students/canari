/**
 * Centralised theme preference store.
 *
 * Persists the *preference* (`dark` | `light` | `system`) to localStorage under
 * `canari-theme`. In `system` mode the active theme follows the OS
 * `prefers-color-scheme` media query **and updates live** when the OS theme
 * changes - in a browser and on Android; in the iOS app the query reports the window style this
 * store itself set (see `colorSchemeIsOwnCommand`), so it is read at start only. Applies the theme by
 * setting `data-theme` on `<html>`.
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

/**
 * The native shells theme the status bar (and on iOS the keyboard and the tab bar) from the
 * WINDOW, which follows the phone and not the page - so the resolved theme is handed over:
 *
 * - iOS: the `canariTheme` message handler `canari_ios.mm` registers.
 * - Android: the `canariTheme` JavaScript interface `MainActivity` registers. `enableEdgeToEdge()`
 *   chooses the bar icons once and a live OS switch never re-runs it (white icons on a white page).
 *
 * Absent in the browser, where this is a no-op by design, not a fallback.
 */
function postThemeToNative(theme: 'dark' | 'light'): void {
  const w = window as unknown as {
    webkit?: { messageHandlers?: { canariTheme?: { postMessage: (m: string) => void } } };
    canariTheme?: { set?: (m: string) => void };
  };
  const ios = w.webkit?.messageHandlers?.canariTheme;
  ios?.postMessage(theme);
  colorSchemeIsOwnCommand = ios !== undefined;
  w.canariTheme?.set?.(theme);
}

/**
 * Whether the page's `prefers-color-scheme` now reports the page's OWN last command rather than the
 * phone's theme. True once a theme reached the iOS shell: `CanariApplyTheme` sets the WINDOW's
 * `overrideUserInterfaceStyle`, and WKWebView's media query follows the window. So a change of that
 * query there is the echo of what this store posted - the camera's `holdNativeBar('dark')` above all -
 * and never evidence of the OS (iPhone, 2026-10-19: opening the camera turned the app dark, and the
 * release then posted that echoed dark back, so it stayed dark until a restart). Android's bridge only
 * sets the bar icons and leaves the WebView's scheme to the OS, so the query stays the OS's there.
 */
let colorSchemeIsOwnCommand = false;

/** The native bars' theme while a full-bleed screen holds them (see `holdNativeBar`), else null. */
let heldNativeTheme: 'dark' | 'light' | null = null;

function applyToDocument(dark: boolean): void {
  if (typeof document === 'undefined') return;
  const theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  postThemeToNative(heldNativeTheme ?? theme);
}

let preference = $state<ThemePreference>('system');
let isDark = $state(false);
let osListenerAttached = false;

/**
 * Attaches (once) a listener on the OS media query that only updates the theme when the
 * preference is `system`. Lets the app follow a live system theme change while open.
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
    if (colorSchemeIsOwnCommand) {
      console.debug(
        `[theme] prefers-color-scheme -> ${e.matches ? 'dark' : 'light'} not followed: on iOS it` +
          ' echoes the window style this page set, not the phone'
      );
      return;
    }
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
   * Holds the native status bar (and nav bar) icons at `theme` while a screen that paints its own
   * dark surface under them is up - the camera preview runs under the status bar, so light-theme
   * dark icons would be unreadable on it. The page theme is untouched. Returns the release, which
   * hands the bars back to the page's own resolved theme.
   */
  holdNativeBar(theme: 'dark' | 'light'): () => void {
    console.debug(`[theme] native bars held at ${theme}`);
    heldNativeTheme = theme;
    postThemeToNative(theme);
    return () => {
      if (heldNativeTheme !== theme) return;
      heldNativeTheme = null;
      // The theme the DOM carries, not `isDark`: this runs from an effect teardown, where a
      // `$state` read returns its value from BEFORE the current flush - a theme switched in the
      // same flush as the camera closing would hand the bars the old one.
      const applied = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      console.debug(`[theme] native bars released to ${applied}`);
      postThemeToNative(applied);
    };
  },
};
