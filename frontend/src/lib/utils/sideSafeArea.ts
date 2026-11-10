/**
 * THE SIDES' SAFE AREA, for the screens that turn (screen-orientation.md): in landscape the notch and
 * the rounded corners are on the LEFT or the RIGHT. Android's WebView answers `env(safe-area-inset-*)`;
 * the iOS WebView answers 0 for every `env()`, so `canari_ios.mm` publishes `--safe-area-inset-left`
 * and `--safe-area-inset-right` after every turn, and the variable wins where it is set.
 */

/** The left inset: the iOS variable, else the engine's `env()`, else 0. */
export const SAFE_LEFT = 'var(--safe-area-inset-left, env(safe-area-inset-left, 0px))';
/** The right inset, the same way. */
export const SAFE_RIGHT = 'var(--safe-area-inset-right, env(safe-area-inset-right, 0px))';

/**
 * An inline `style` padding both sides by the safe area plus `extra` (a CSS length, `0px` by default),
 * for a row of controls laid across the screen's width.
 */
export function sideSafePadding(extra = '0px'): string {
  return `padding-left: calc(${SAFE_LEFT} + ${extra}); padding-right: calc(${SAFE_RIGHT} + ${extra});`;
}
