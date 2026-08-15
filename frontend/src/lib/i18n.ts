/**
 * i18n.ts - Thin wrapper around the Paraglide runtime.
 *
 * Centralizes the app's locale helpers so the rest of the code never imports the
 * generated `$lib/paraglide/runtime` directly. The UI language is detected and
 * persisted by Paraglide's strategy chain (localStorage → browser preferred
 * language → base locale `fr`); there is no SSR (ssr=false), so all detection is
 * client-side.
 */

import { getLocale, setLocale, locales, baseLocale, type Locale } from '$lib/paraglide/runtime';

export { getLocale, setLocale, locales, baseLocale };
export type { Locale };

/**
 * Endonyms shown in the language picker - each language is labelled in its own
 * tongue (proper nouns, not translated) so it is recognizable whatever the
 * current UI locale.
 */
export const LOCALE_LABELS: Record<Locale, string> = {
  fr: 'Français',
  en: 'English',
};

/**
 * Mirrors the chosen language into `push_context.json`, where the native background side reads it.
 *
 * NOTHING ELSE CAN TELL THE PHONE WHICH LANGUAGE THE APP IS IN. A push arrives with the WebView
 * closed, so Paraglide is not running and cannot be asked; the platform's own answer - Android's
 * `R.string` resolution and iOS's `preferredLocalizations` - is the language of the OS, which is a
 * different setting. A French phone running the app in English produced French notifications.
 *
 * Same posture as `channelKeyMirror`: the WebView holds the truth, the file is what survives it
 * being closed. Tauri only, and a no-op on web, which has no background notifications at all.
 */
async function mirrorLocaleToNative(locale: Locale): Promise<void> {
  const { isTauriRuntime } = await import('$lib/utils/openExternal');
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_push_context_locale', { locale });
  } catch (e) {
    // Best-effort: the cost of failing is a notification in the previous language, never a lost
    // one. Silence would leave nothing behind, so it accuses - it should not happen.
    console.warn(`[LOCALE_MIRROR] failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Switches the UI language and persists the choice (localStorage, via Paraglide).
 * Triggers a full reload so every message function re-evaluates with the new
 * locale - acceptable for an explicit user action in settings.
 *
 * The native mirror is awaited BEFORE `setLocale`, and that order is load-bearing: `setLocale`
 * reloads the document, which would cancel an in-flight command and leave the phone writing its
 * notifications in the language the user just left.
 */
export async function changeLocale(locale: Locale): Promise<void> {
  if (locale === getLocale()) return;
  await mirrorLocaleToNative(locale);
  setLocale(locale);
}
