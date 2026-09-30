import { isMobileTauriRuntime } from '$lib/utils/appVersion';

/**
 * Whether the conversation wears the GLASS CHROME: the floating header (back, a centre pill, a menu
 * that grows) and the composer's single "+".
 *
 * THE PHONE APPS ONLY - iOS and Android (user, 2026-09-30: "only apply it on phone finally, the design
 * is good on web"). The website keeps its header and composer at every width, a phone's browser
 * included. Read once per component: the platform does not change under a running app.
 */
export function usesGlassChrome(): boolean {
  return isMobileTauriRuntime();
}
