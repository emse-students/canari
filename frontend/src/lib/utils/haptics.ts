import { settings } from '$lib/stores/settingsStore.svelte';

/**
 * One light vibration, when the member has vibrations on and the engine can vibrate.
 *
 * The Web Vibration API is the only haptic the app has: Android's WebView honours it, iOS WebKit
 * has no `navigator.vibrate` at all, so an iPhone feels nothing - no plugin is added for that.
 * Only ever called from a gesture's consequence, because Chrome refuses a vibration before a user
 * activation and reports it as a console error; a refusal is logged at debug level, a nicety never
 * being a path anything depends on.
 */
export function hapticTick(ms: number): void {
  if (!settings.vibrationsEnabled) return;
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(ms);
  } catch (err) {
    console.debug('[haptics] vibrate refused', err);
  }
}
