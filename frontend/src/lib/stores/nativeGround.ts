/**
 * THE GROUND UNDER THE WEBVIEW FOLLOWS THE SURFACE AT THE BOTTOM EDGE (keyboard-and-send-motion.md).
 *
 * The Android shell paints `android.R.id.content` under the transparent WebView with the colour the
 * page posts (`canariTheme.setGround`, `MainActivity`). Wherever the WebView does not cover the
 * bottom inset, that ground IS the strip under the page. It was posted once per keyboard rise, with
 * the colour of the screen the keyboard rose over - a conversation's grey - and never again, so the
 * strip under the feed's white tab bar stayed grey until a cold restart (owner's Pixel 6a,
 * 2026-11-26). A ground posted for one surface outlives it; so it is re-read whenever the bottom
 * surface can change - a settled route, a theme apply, the tab bar mounted or unmounted, the boot
 * gate lifted, the splash gone, a keyboard rise - and posted only when it differs from the last one posted.
 *
 * Absent in the browser and on iOS (no `setGround`), where this is a no-op by design, not a fallback.
 */
import { Log } from '$lib/utils/Log';
import { cssColorToHex, groundOf } from './imeGround';

/** What made the page re-read its bottom edge, written into each post's log line. */
export type GroundSource =
  | 'keyboard-rise'
  | 'navigation'
  | 'theme'
  | 'bottom-bar'
  | 'boot-gate'
  | 'splash-done';

/** The Android shell's `setGround`, or null in the browser and on iOS (no such bridge). */
function groundBridge(): { setGround: (c: string) => void } | null {
  const bridge = (window as unknown as { canariTheme?: { setGround?: (c: string) => void } })
    .canariTheme;
  return bridge?.setGround ? (bridge as { setGround: (c: string) => void }) : null;
}

/** The last colour handed to the shell by this document, or null before the first post. */
let posted: string | null = null;

/**
 * The opaque colour painted at the bottom edge of the window, as `#rrggbb`: the element the bottom
 * row hits (the tab bar, a composer, a full-bleed screen) and, through a translucent one, what shows
 * through it - so the ground always equals what is drawn there. Null when nothing there is opaque.
 */
function readBottomGround(): string | null {
  const start = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 1);
  return groundOf(start, (el) => getComputedStyle(el).backgroundColor, cssColorToHex);
}

/**
 * Reads the bottom edge and posts its colour to the Android shell when it changed since the last
 * post. One function, called from every place the bottom surface can change; a repeat of the same
 * value is not sent. A read with nothing opaque keeps the native ground and says so.
 */
export function syncNativeGround(source: GroundSource): void {
  const bridge = groundBridge();
  if (!bridge) return;
  const ground = readBottomGround();
  if (!ground) {
    Log.w(
      'nativeGround',
      `no opaque ground at the bottom edge (${source}) - the native one is kept`
    );
    return;
  }
  if (ground === posted) return;
  Log.d('nativeGround', `ground ${posted ?? 'none'} -> ${ground} (${source})`);
  posted = ground;
  bridge.setGround(ground);
}

/**
 * `syncNativeGround` once the theme's crossfade has landed. `nav`, `body` and `:root` carry a 180 ms
 * `background-color` transition (app.css, `@layer base`), so read right after a theme switch the
 * bottom edge still computes the OLD colour - the tab bar's white under a dark theme - which equals
 * the last post and would be dropped as a repeat. The read waits for the background transitions
 * running at that moment to end or be cancelled (`finished`, an event, not a timer), then reads
 * what they landed on. With none running (reduced motion, no theme change) it reads at once.
 */
export function syncNativeGroundAfterTransitions(source: GroundSource): void {
  if (!groundBridge()) return;
  // `getAnimations` flushes style first, so the transitions the switch just started are listed.
  const running =
    typeof document.getAnimations === 'function'
      ? document
          .getAnimations()
          .filter(
            (a) =>
              (a as Animation & { transitionProperty?: string }).transitionProperty ===
              'background-color'
          )
      : [];
  if (running.length === 0) {
    syncNativeGround(source);
    return;
  }
  Log.d(
    'nativeGround',
    `${running.length} background transition(s) running (${source}) - read when they land`
  );
  void Promise.allSettled(running.map((a) => a.finished)).then(() => syncNativeGround(source));
}

/** Forgets the last post, for a test that starts a fresh document. */
export function forgetPostedGroundForTest(): void {
  posted = null;
}
