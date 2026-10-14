/**
 * Whether one of the app's own unlock prompts - the PIN gate or the biometric sheet - is on screen.
 *
 * WHY A PAGE NEEDS TO KNOW (F1 of community-open-budget, 2026-10-14). The Communities page now draws
 * the saved community list before the session is up, and on a wide screen the PIN gate is a modal
 * over a 40 % scrim: the community names would read through it. A lock screen shows nothing of what
 * it locks, so the page draws that list only while no prompt is up. Written by the app shell, which
 * owns both prompts; read by the page.
 */

let shown = $state(false);

/** True while the PIN gate or the biometric sheet is on screen. */
export function authGateShown(): boolean {
  return shown;
}

/** Records whether an unlock prompt is on screen. Written by the app shell only. */
export function setAuthGateShown(value: boolean): void {
  shown = value;
}
