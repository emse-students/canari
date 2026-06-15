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
 * Switches the UI language and persists the choice (localStorage, via Paraglide).
 * Triggers a full reload so every message function re-evaluates with the new
 * locale - acceptable for an explicit user action in settings.
 */
export function changeLocale(locale: Locale): void {
  if (locale === getLocale()) return;
  setLocale(locale);
}
