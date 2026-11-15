/**
 * THE ONE MODULE THAT OWNS THE KEYBOARD'S VARIABLES (docs/wiki/frontend/keyboard-and-send-motion.md).
 * It reads the keyboard from the Visual Viewport API - or, in the Android app, from the shell's
 * announcement (`imeTarget.ts`), the one source there - and exposes the reactive snapshot and every
 * CSS variable a screen lays itself out by. No screen computes its own:
 *
 * - `--app-viewport-height`: the shell's height while the keyboard is open. The visible height where
 *   the keyboard shrinks the WebView (iOS) or the visual viewport (a phone browser); the FULL height
 *   in the Android app, whose WebView the keyboard covers without resizing.
 * - `--keyboard-layout-inset-bottom`: what the keyboard covers of the shell's bottom. Non-zero only
 *   in the Android app; a screen inside the shell adds it where it relied on the shell shrinking.
 * - `--keyboard-occlusion-bottom`: what the keyboard covers of the WINDOW's bottom, for `position:
 *   fixed` elements. 0 wherever the WebView itself was resized (the web, iOS, an older shell).
 * - `--keyboard-inset-bottom`, `--visual-viewport-offset-top`, `--keyboard-free-viewport-height`:
 *   below.
 */

import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
import { orientationOf, rememberKeyboardHeight } from './keyboardHeightMemory';
import { cssColorToHex, groundOf } from './imeGround';
import { parseImeTarget, resolveImeTarget, type ImeAnimation, type ImeTarget } from './imeTarget';
import {
  afterLayoutReactions,
  captureKeyboardRide,
  fallRefusal,
  parseKeyboardFall,
  startKeyboardRide,
  uikitCurveEasing,
  releaseThreadGlides,
  type KeyboardRide,
  type KeyboardRideCapture,
} from './keyboardRide';
import { Log } from '$lib/utils/Log';

export type KeyboardViewportSnapshot = {
  isOpen: boolean;
  /** Visible layout height (px). */
  viewportHeight: number;
  /** Top offset when the browser pans the page (adjustPan). */
  offsetTop: number;
  /** Space occupied by the keyboard from the bottom of the layout viewport. */
  insetBottom: number;
  /**
   * What the keyboard covers of the shell's bottom, in px - `--keyboard-layout-inset-bottom`. Only
   * an overlay keyboard (the Android app, `imeTarget.ts`) has one; zero wherever the keyboard
   * shrinks the layout or the visual viewport, which takes the shell with it.
   */
  layoutInsetBottom: number;
  /**
   * What the keyboard covers of the WINDOW's bottom, in px - `--keyboard-occlusion-bottom`, for
   * `position: fixed` elements, which the shell's own layout does not reach. Non-zero only for an
   * overlay keyboard; zero wherever the WebView itself was resized (the web, iOS, an older shell).
   */
  occlusionBottom: number;
  /**
   * The height `--app-viewport-height` pins the shell to while the keyboard is open: the visible
   * height (`viewportHeight`) where the keyboard shrinks the viewport, the full layout where it
   * covers it (the shell does not shrink, its screens read `layoutInsetBottom`).
   */
  shellHeight: number;
  /**
   * True when the user has pinch-zoomed in (visual viewport scale > 1). A zoomed-in visual
   * viewport shrinks exactly like a keyboard opening, so we must NOT treat it as one:
   * doing so collapses the app shell (white gaps) and hides the nav bars (reframing).
   */
  zoomed: boolean;
  /**
   * How tall the keyboard is. ONE NUMBER FOR EVERY PLATFORM, from the one source each has: where the
   * keyboard shrinks the VISUAL viewport (iOS's native layer resizes the WebView, a phone browser
   * shrinks only the visual viewport), what it took from the screen - the baseline height (the
   * tallest the viewport has been with no keyboard) minus the visible height; in the Android app,
   * whose WebView the keyboard covers without resizing it, the height the shell announced
   * (`imeTarget.ts`). Zero while closed or zoomed - a URL bar sliding is not a keyboard. The
   * composer's GIF panel takes exactly this room (`composerSurface.ts`).
   */
  keyboardHeight: number;
};

/** Raw viewport measurements, injectable so the geometry stays unit-testable off-DOM. */
export type ViewportMeasurement = {
  /** Layout viewport height (`window.innerHeight`), immune to pinch-zoom. */
  winH: number;
  /** Visual viewport height (`visualViewport.height`), shrinks on keyboard AND pinch-zoom. */
  vvHeight: number;
  /** Visual viewport top offset (`visualViewport.offsetTop`), grows when the page is panned. */
  offsetTop: number;
  /** Pinch-zoom scale (`visualViewport.scale`); 1 at rest, > 1 when zoomed in. */
  scale: number;
  /**
   * The keyboard's height when the native shell announced it as COVERING the window, which it does
   * not resize (the Android app, `imeTarget.ts`) - 0 included, the shell saying there is none.
   * Absent wherever the keyboard is measured from the viewport.
   */
  overlayPx?: number;
};

/** A pinch-zoom scale above this counts as "the user zoomed", not "a keyboard opened". */
const ZOOM_SCALE_EPSILON = 1.01;

/**
 * How much the visual viewport must shrink before it counts as a keyboard.
 *
 * THE OS IS ASKED, NEVER THE USER AGENT: an iPad WKWebView calls itself "Macintosh", so the
 * `/iphone|ipad|ipod/` test that used to be here gave every iPad the desktop threshold.
 */
function keyboardOpenThresholdPx(): number {
  return detectRuntimeDeviceOs() === 'ios' ? 100 : 160;
}

/**
 * How far apart two heights may be and still be the SAME height, in CSS px.
 *
 * Not a size: three numbers enter the comparison below and each is rounded on its own -
 * `innerHeight` to a whole CSS px (twice: the baseline and `winH`), `visualViewport.height` to a
 * device pixel (0.4 CSS px on the Mi 9T). Measured there, the two halves of a double report differ by
 * 0.7 (588 - 230.3 = 357.7 against 945 - 588 = 357). A keyboard of any height passes or fails it the
 * same way.
 */
const SAME_HEIGHT_ROUNDING_PX = 2;

/**
 * Whether this measurement is the Android WebView's DOUBLE REPORT of one keyboard rise.
 *
 * Mi 9T, 2026-10-02: for one frame of most rises the layout viewport has ALREADY given up the
 * keyboard's room (`winH` 588 of a 945 baseline) while the visual viewport reads 230 tall -
 * 945 - 2 x 357, the keyboard taken off twice. Trusted, it pinned the shell at 230 and the composer
 * jumped 358 px up and back.
 *
 * THE REPORT IS RECOGNISED BY ITS OWN SHAPE, NOT BY A HEIGHT. It used to require the layout viewport
 * to have shrunk by more than the keyboard-open threshold (160 px on Android), so a keyboard shorter
 * than that - the bench's 90 px ADB keyboard, a floating or one-row IME - was trusted and the
 * composer spent a frame at 702 instead of 792 (2 of 5 rises, 2026-10-13). What the double report IS
 * does not depend on the keyboard's size: the visual viewport stands below the layout viewport by
 * EXACTLY what the layout viewport gave up, the same inset applied a second time. Nothing else has
 * that shape: a pan keeps `winH` at the baseline (nothing given up), a pinch-zoom is `scale` and is
 * bailed out before this is asked, a settled keyboard leaves the two viewports equal, and a browser
 * whose URL bar slid (`winH` short by the bar) while a keyboard covers the visual viewport has the
 * keyboard's height below the layout and the bar's above, which agree only if the two are the same
 * height to the pixel.
 *
 * @param m the raw viewport measurement of this event.
 * @param baselineHeight the tallest the layout viewport has been with no keyboard.
 * @returns true when the visual viewport must be read as the layout viewport's own height.
 */
export function isDoubleReport(m: ViewportMeasurement, baselineHeight: number): boolean {
  const layoutGaveUp = baselineHeight - m.winH;
  if (layoutGaveUp <= SAME_HEIGHT_ROUNDING_PX) return false;
  const visualBelowLayout = m.winH - m.vvHeight;
  return Math.abs(visualBelowLayout - layoutGaveUp) <= SAME_HEIGHT_ROUNDING_PX;
}

/**
 * How much of the LAYOUT viewport's bottom the keyboard covers, in CSS px: the band below the
 * visible area that a `position: fixed` panel must stay out of.
 *
 * THE VISUAL VIEWPORT KNOWS FIRST. When the Android app still padded its content by the IME inset,
 * the layout viewport gave up the keyboard's room late: Mi 9T, `1.6.9`, 2026-11-10, `visualViewport`
 * resize to 588 at +357 ms after the focus, `innerHeight` still 945 until +1000 ms - and a phone
 * browser never shrinks the layout viewport at all. Zero when pinch-zoomed (a zoom is not a
 * keyboard) and once the layout viewport has caught up; the double report is absorbed as in
 * `computeSnapshot`, so its one bogus frame is never a 357 px band. An overlay keyboard (the
 * Android app since 2026-11-14) is the announced height itself.
 *
 * @param m the raw viewport measurement.
 * @param baselineHeight the tallest the layout viewport has been with no keyboard.
 */
export function keyboardInsetBottom(m: ViewportMeasurement, baselineHeight: number): number {
  if (m.overlayPx !== undefined) return m.overlayPx;
  if (m.scale > ZOOM_SCALE_EPSILON) return 0;
  const vvHeight = isDoubleReport(m, baselineHeight) ? m.winH : m.vvHeight;
  return Math.max(0, m.winH - vvHeight - m.offsetTop);
}

/**
 * Pure geometry: turns raw viewport numbers into a keyboard snapshot.
 * Fix (root cause): when `scale > 1` the visual viewport shrank because of a pinch-zoom, not a
 * keyboard - bail out with `zoomed: true` and a full-height, closed snapshot so the shell is
 * left untouched (see the desktop-zoom / iOS-keyboard white-gap bug).
 * `viewportHeight` is deliberately the raw visual-viewport height, not shell-relative: the app
 * shell's own top offset (status-bar inset) is already subtracted exactly once, structurally,
 * by the shell's own ancestor padding (`var(--safe-area-inset-top)`) - see WP-KBD-1 in
 * docs/wiki/frontend/mobile.md. Subtracting it again here double-counts it.
 *
 * AN OVERLAY KEYBOARD (`m.overlayPx`, the Android app) is read before anything else: the shell said
 * how much of the window it covers, so neither a pinch-zoom nor the visual viewport is a question.
 * The shell keeps the full layout height, and the keyboard's room is the two insets - from its first
 * pixel, so a keyboard shorter than the open threshold (a one-row IME, the bench's ADB keyboard) still
 * lifts what sits on it; `isOpen`, which hides the bars and remembers the keyboard's height, keeps the
 * threshold every platform reads it with.
 */
export function computeSnapshot(
  m: ViewportMeasurement,
  baselineHeight: number,
  thresholdPx: number
): KeyboardViewportSnapshot {
  if (m.overlayPx !== undefined) {
    const px = m.overlayPx;
    const isOpen = px > thresholdPx;
    return {
      isOpen,
      viewportHeight: m.vvHeight,
      offsetTop: 0,
      insetBottom: px,
      layoutInsetBottom: px,
      occlusionBottom: px,
      shellHeight: m.winH,
      zoomed: m.scale > ZOOM_SCALE_EPSILON,
      keyboardHeight: isOpen ? Math.round(px) : 0,
    };
  }

  if (m.scale > ZOOM_SCALE_EPSILON) {
    return {
      isOpen: false,
      viewportHeight: baselineHeight,
      offsetTop: 0,
      insetBottom: 0,
      layoutInsetBottom: 0,
      occlusionBottom: 0,
      shellHeight: baselineHeight,
      zoomed: true,
      keyboardHeight: 0,
    };
  }

  const doubleReported = isDoubleReport(m, baselineHeight);
  if (doubleReported) {
    Log.d(
      'keyboardViewport',
      `double report absorbed: visual ${m.vvHeight} read as layout ${m.winH} (baseline ${baselineHeight})`
    );
  }
  const vvHeight = doubleReported ? m.winH : m.vvHeight;

  const insetBottom = keyboardInsetBottom(m, baselineHeight);
  const delta = Math.max(baselineHeight - vvHeight, m.winH - vvHeight);
  const isOpen = delta > thresholdPx;
  const layoutShrunk =
    baselineHeight - m.winH > thresholdPx * 0.35 || m.winH - vvHeight > thresholdPx * 0.35;
  const layoutInsetBottom = isOpen && !layoutShrunk ? insetBottom : 0;

  return {
    isOpen,
    viewportHeight: vvHeight,
    offsetTop: m.offsetTop,
    insetBottom,
    layoutInsetBottom,
    occlusionBottom: 0,
    shellHeight: vvHeight,
    zoomed: false,
    keyboardHeight: isOpen ? Math.max(0, Math.round(baselineHeight - vvHeight)) : 0,
  };
}

/**
 * The bottom safe-area value to PIN while the keyboard is open, or null to leave the platform's own.
 *
 * iOS keeps `env(safe-area-inset-bottom)` at the home indicator's 34 px for ~400 ms after the
 * keyboard opens, although the keyboard covers that strip from its first frame
 * (`visualViewport.height` was already 543); the composer footer pads `max(0.75rem, inset)`, so it
 * stood 22 pt too high until the inset caught up (iPhone 12, iOS 27.0.1, 2026-10-02). The settled
 * value is 0, so pinning 0 from the first open frame changes no resting state - only the transient.
 *
 * THE ANDROID APP'S OVERLAY KEYBOARD (`occlusionBottom > 0`) IS PINNED HERE TOO, AND IT IS THE ONLY
 * PLACE THAT SAYS SO (review of #3556, D2). The keyboard covers the navigation bar, so the bar's strip
 * is the keyboard's. The shell used to say it by withdrawing the bar's inset from the WebView, which
 * Chromium applies to `env()` a frame or more AFTER the announcement: the composer's floor fell by
 * 12 px (`max(0.75rem, 23.8px)` to `0.75rem`, Mi 9T) one frame into the ride and the thread's bottom
 * moved under it (scrollTop 4085 then 4073). Pinned here, it changes in the announcement's own task,
 * with the keyboard's room. From its first pixel - a keyboard shorter than the open threshold covers
 * the bar as well.
 *
 * @param occlusionBottom what an overlay keyboard covers of the window (0 wherever it resizes it).
 */
export function keyboardSafeAreaBottomOverride(
  isOpen: boolean,
  os: string,
  occlusionBottom = 0
): string | null {
  if (occlusionBottom > 0) return '0px';
  return isOpen && os === 'ios' ? '0px' : null;
}

/**
 * The viewport height a keyboard-free page would have, while a keyboard has taken it from the LAYOUT
 * viewport - or null when nothing has (the CSS then keeps its own `100svh`).
 *
 * WHY IT EXISTS: `--media-max-height` is `60svh`, meant to be stable, and in a phone BROWSER it is -
 * the keyboard shrinks only the visual viewport there. In the iOS app it is not: iOS shrinks the
 * WebView's frame (`CanariApplyKeyboardLayout`), so the layout viewport itself shrinks and EVERY
 * viewport unit (`svh`, `lvh`, `dvh`, `vh`) shrinks with it. The Android app did the same by padding
 * the WebView until 2026-11-14; its keyboard now covers the WebView without resizing it, so the
 * layout keeps the baseline and this answers null there. Measured on the Mi 9T (`1.6.11-alpha.5`, LatinIME):
 * `60svh` and `60lvh` both 567.3 px closed, 352.7 px open (innerHeight 945 -> 588) - a 1080x2340
 * screenshot in a 290 px bubble showed 90% of itself, then 56%, cropped top AND bottom
 * (`object-cover object-center`). No CSS unit names "the screen without the keyboard"; this store
 * is the one place that knows it (`baselineHeight`), so it writes it.
 *
 * Only while `isOpen` AND the layout viewport gave room (`winH < baseline`): a phone browser keeps
 * `svh` itself, and a closed keyboard means the current viewport IS the keyboard-free one - so a
 * desktop window resize and a rotation are still followed by plain CSS.
 *
 * @param baselineHeight the tallest the layout viewport has been with no keyboard.
 */
export function keyboardFreeViewportHeight(
  isOpen: boolean,
  winH: number,
  baselineHeight: number
): number | null {
  if (!isOpen) return null;
  if (baselineHeight - winH < SAME_HEIGHT_ROUNDING_PX) return null;
  return Math.round(baselineHeight);
}

/** The CSS property `--media-max-height` reads its viewport from while a keyboard holds the layout. */
const KEYBOARD_FREE_HEIGHT_PROPERTY = '--keyboard-free-viewport-height';

/**
 * Whether this OS can have an on-screen keyboard at all. A desktop window has none, so a window
 * made shorter than its tallest size is a RESIZE, never a keyboard: it used to read as one past
 * 160px and hid the top bar and the bottom bar while the fixed rail kept its offset, leaving a gap
 * above it (user, 2026-10-04).
 */
export function hasVirtualKeyboard(os: string): boolean {
  return os !== 'windows' && os !== 'macos' && os !== 'linux';
}

/**
 * What the window says of its size, read in ONE place and BEFORE anything is written in a task.
 *
 * `innerWidth`, `innerHeight` and `visualViewport.height` are not free on Android: with the viewport
 * meta enabled, Chromium brings style and layout up to date before answering them. Read after the
 * keyboard's variables were written - every one of them on `:root`, so the whole document's style is
 * dirty - each forced that whole pass inside the announcement's task (LoAF on the Mi 9T, 2026-11-14:
 * 28-33 ms of a ~38 ms announcement, rise and fall alike). So `update` takes this reading, made
 * first, and nothing after its writes reads the window again (review of #3556, D3).
 */
export type WindowReading = ViewportMeasurement & {
  /** `innerWidth`. */
  winW: number;
  /** `visualViewport.width` (`innerWidth` where there is no visual viewport). */
  vvWidth: number;
};

/** Reads the window now - see {@link WindowReading}. */
function readWindow(): WindowReading {
  const vv = window.visualViewport;
  const winH = window.innerHeight;
  const winW = window.innerWidth;
  return {
    winW,
    vvWidth: vv?.width ?? winW,
    winH,
    vvHeight: vv?.height ?? winH,
    offsetTop: vv?.offsetTop ?? 0,
    scale: vv?.scale ?? 1,
  };
}

/**
 * Whether a window reading is SETTLED: the layout viewport and the visual viewport agree on the
 * window's size, width and height, within rounding.
 *
 * THE FACT A NEW BASELINE IS TAKEN FROM (second review of #3556). A rotation does not reach both
 * viewports in one step: the layout can report the new width with a height that is not final yet,
 * while the visual viewport already has the final size (or the reverse). Taken as the baseline - the
 * first update at a new width used to be - a transient TALLER height stuck for good, since only
 * `max()` moves the baseline afterwards, and every keyboard in that orientation was measured that much
 * too tall. When the two viewports agree, neither is mid-turn. Nothing else makes them disagree with
 * no zoom: a phone browser's keyboard (only the visual viewport shrinks, and the layout height is then
 * the keyboard-free one), or a desktop scrollbar (the visual width excludes it) - on both the
 * baseline keeps following the layout's height until they agree again, which is the keyboard-free
 * height for the first and is not read at all for the second (`hasVirtualKeyboard`).
 */
export function isSettledWindow(w: WindowReading): boolean {
  return (
    Math.abs(w.vvWidth - w.winW) <= SAME_HEIGHT_ROUNDING_PX &&
    Math.abs(w.vvHeight - w.winH) <= SAME_HEIGHT_ROUNDING_PX
  );
}

/**
 * The viewport measurement of a window reading. A desktop OS has no on-screen keyboard, so its
 * visual viewport is read as the layout viewport: a shorter window there is a resize
 * (`hasVirtualKeyboard`). While the native shell has announced a keyboard, the measurement is the one
 * the announcement implies (`resolveImeTarget`): the iOS resize to come, or the Android overlay.
 */
function measureViewport(w: WindowReading = readWindow()): ViewportMeasurement {
  const winH = w.winH;
  if (!hasVirtualKeyboard(detectRuntimeDeviceOs())) {
    return { winH, vvHeight: winH, offsetTop: 0, scale: 1 };
  }
  const raw = { winH, vvHeight: w.vvHeight, offsetTop: w.offsetTop, scale: w.scale };
  const { measurement, drop } = resolveImeTarget(raw, baselineHeight, imeTarget);
  if (drop) {
    Log.d(
      'keyboardViewport',
      `keyboard target ${imeTarget?.px} spent (layout ${winH}, visual ${raw.vvHeight})`
    );
    imeTarget = null;
  }
  return measurement;
}

/** What the native shell announced about the keyboard (`imeTarget.ts`), or null. */
let imeTarget: ImeTarget | null = null;

/** Tallest the layout viewport has been with no keyboard - owned by `initKeyboardViewport`. */
let baselineHeight = 0;

function readSnapshot(m: ViewportMeasurement): KeyboardViewportSnapshot {
  return computeSnapshot(
    m,
    hasVirtualKeyboard(detectRuntimeDeviceOs()) ? baselineHeight : m.winH,
    keyboardOpenThresholdPx()
  );
}

/**
 * The keyboard's band at the bottom of the layout viewport, MEASURED NOW rather than read from the
 * last snapshot - so a caller handling the same `resize` event as this store never mixes a fresh
 * `innerHeight` with a stale inset, whichever listener ran first. See `keyboardInsetBottom`.
 */
export function currentKeyboardInsetBottom(): number {
  if (typeof window === 'undefined') return 0;
  return keyboardInsetBottom(measureViewport(), baselineHeight);
}

const SAFE_BOTTOM_PROPERTY = '--safe-area-inset-bottom';

/** The inline value the pin replaced, while one is in force. */
let pinnedSafeBottom: { previous: string } | null = null;

/** Pins `value` (or releases the pin with null), putting back whatever inline value it replaced. */
export function pinSafeAreaBottom(root: CSSStyleDeclaration, value: string | null): void {
  if (value && !pinnedSafeBottom) {
    pinnedSafeBottom = { previous: root.getPropertyValue(SAFE_BOTTOM_PROPERTY) };
    root.setProperty(SAFE_BOTTOM_PROPERTY, value);
  } else if (!value && pinnedSafeBottom) {
    if (pinnedSafeBottom.previous)
      root.setProperty(SAFE_BOTTOM_PROPERTY, pinnedSafeBottom.previous);
    else root.removeProperty(SAFE_BOTTOM_PROPERTY);
    pinnedSafeBottom = null;
  }
}

function applyCssVars(
  snapshot: KeyboardViewportSnapshot,
  m: ViewportMeasurement,
  baselineHeight: number
): void {
  const root = document.documentElement.style;
  // Fix 2: only pin the shell height (in px) while the keyboard is actually open. Otherwise
  // remove the override so the shell falls back to the stable `100dvh` from `:root` - a bare
  // pan (URL-bar slide) or a pinch-zoom must NOT be allowed to collapse the shell into a white gap.
  if (snapshot.isOpen) {
    root.setProperty('--app-viewport-height', `${snapshot.shellHeight}px`);
  } else {
    root.removeProperty('--app-viewport-height');
  }
  // Inline on the root, so it outranks the `:root` declaration. `app.html` already pins the same
  // property inline outside Tauri, so what was there is put BACK on release, never just removed.
  pinSafeAreaBottom(
    root,
    keyboardSafeAreaBottomOverride(
      snapshot.isOpen,
      detectRuntimeDeviceOs(),
      snapshot.occlusionBottom
    )
  );
  root.setProperty('--keyboard-inset-bottom', `${snapshot.insetBottom}px`);
  root.setProperty('--keyboard-layout-inset-bottom', `${snapshot.layoutInsetBottom}px`);
  root.setProperty('--keyboard-occlusion-bottom', `${snapshot.occlusionBottom}px`);
  root.setProperty('--visual-viewport-offset-top', `${snapshot.offsetTop}px`);
  // An overlay keyboard (the Android app) never takes room from the layout viewport: a window
  // shorter than the baseline there is a window resized for another reason (split screen), which
  // plain `svh` follows.
  const keyboardFree =
    m.overlayPx !== undefined
      ? null
      : keyboardFreeViewportHeight(snapshot.isOpen, m.winH, baselineHeight);
  if (keyboardFree !== null) {
    if (root.getPropertyValue(KEYBOARD_FREE_HEIGHT_PROPERTY) !== `${keyboardFree}px`) {
      Log.d(
        'keyboardViewport',
        `media held at the keyboard-free height ${keyboardFree} (layout ${m.winH})`
      );
    }
    root.setProperty(KEYBOARD_FREE_HEIGHT_PROPERTY, `${keyboardFree}px`);
  } else {
    root.removeProperty(KEYBOARD_FREE_HEIGHT_PROPERTY);
  }
}

let snapshot = $state<KeyboardViewportSnapshot>({
  isOpen: false,
  viewportHeight: 0,
  offsetTop: 0,
  insetBottom: 0,
  layoutInsetBottom: 0,
  occlusionBottom: 0,
  shellHeight: 0,
  zoomed: false,
  keyboardHeight: 0,
});

/** Reactive keyboard / viewport snapshot for components. */
export function getKeyboardViewport(): KeyboardViewportSnapshot {
  return snapshot;
}

function isFocusableField(el: HTMLElement): boolean {
  return el.matches(
    'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]'
  );
}

/**
 * How a reveal moves: never animated for someone who asked the system for reduced motion.
 *
 * @param requested what the caller asked for (`auto` after a keyboard rise, `smooth` otherwise).
 * @param reducedMotion whether `prefers-reduced-motion: reduce` matches.
 */
export function revealBehavior(requested: ScrollBehavior, reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : requested;
}

/**
 * Scrolls the focused field into the visible viewport (above the virtual keyboard).
 *
 * `nearest`, so a field already in view does not move. The room for the field AFTER it is not
 * decided here: inside `[data-keyboard-aware-overlay]` every field carries a `scroll-margin-block-end`
 * (`app.css`) that `nearest` honours, so the reveal stops with the next field's label and box still
 * above the footer (the PIN change's confirm field stood cut under the submit button, iPhone 12,
 * v1.2.9-alpha.4).
 */
export function scrollFocusedFieldIntoView(behavior: ScrollBehavior = 'smooth'): void {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !isFocusableField(el)) return;
  if (el.closest('.chat-composer-footer, .app-layout')) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const how = revealBehavior(behavior, reduced);
  Log.d('keyboardViewport', `revealing the focused field (${how})`);
  requestAnimationFrame(() => {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: how });
  });
}

/**
 * Whether a `transitionend` is a keyboard-aware overlay reaching its final HEIGHT with the focused
 * field inside it - the moment the reveal must be redone.
 *
 * THE FIRST REVEAL MEASURES A BOX STILL MOVING. `[data-keyboard-aware-overlay]` animates its height
 * (180 ms, `app.css`), and the reveal that follows a keyboard rise runs one frame after the resize,
 * so it scrolls the field to the bottom of a scrollport that is still shrinking: once the overlay
 * settles, the field sits under the modal's footer. iPhone 12 bench, 2026-10-15: in the PIN change
 * dialog the focused field was half under the submit button, and a tap where the next field stood
 * hit the button and submitted the form. The iOS keyboard drops and rises again between two fields,
 * so every field move paid it.
 */
export function overlaySettledAroundFocus(
  propertyName: string,
  target: EventTarget | null,
  active: Element | null
): boolean {
  return (
    propertyName === 'height' &&
    target instanceof HTMLElement &&
    target.matches('[data-keyboard-aware-overlay]') &&
    active !== null &&
    target.contains(active)
  );
}

/** What `initKeyboardViewport` may be handed instead of the browser's own, for its tests. */
export type KeyboardViewportSeams = {
  /** Runs a ride's start after the resize's layout reactions (`afterLayoutReactions`). */
  afterLayout?: (targets: Element[], start: () => void) => () => void;
  /** The clock a ride is phased on (`performance.now`): see `startKeyboardRide`. */
  now?: () => number;
};

/**
 * Who is told when the keyboard's band changes: see {@link onKeyboardInsetChange}. A plain list, not
 * reactive state: it is called, never rendered.
 */
const insetListeners: (() => void)[] = [];

/**
 * Calls `listener` every time the keyboard's band at the bottom of the window changes, from the
 * store's own update - the one moment every platform shares. A `position: fixed` panel placed above
 * the keyboard needs it: in the Android app the keyboard covers the WebView without resizing it, so
 * neither `resize` nor a `visualViewport` resize ever fires for it (review of #3556, F4).
 *
 * Called AFTER the store has written its variables, in the same task: a listener that reads layout
 * must wait for a frame (`requestAnimationFrame`), or it forces the style and layout pass those
 * writes left dirty. Returns the unsubscribe.
 */
export function onKeyboardInsetChange(listener: () => void): () => void {
  insetListeners.push(listener);
  return () => {
    const at = insetListeners.indexOf(listener);
    if (at >= 0) insetListeners.splice(at, 1);
  };
}

/** Tells every inset listener, each in its own `try`: one failing must not silence the next. */
function notifyInsetListeners(): void {
  // A copy: a listener may unsubscribe itself while the list is walked.
  for (const listener of insetListeners.slice()) {
    try {
      listener();
    } catch (error) {
      Log.w('keyboardViewport', `a keyboard inset listener threw: ${String(error)}`);
    }
  }
}

/**
 * Whether the keyboard MOVED between two snapshots, as far as a focused field can tell: the band it
 * covers at the bottom of the layout (`insetBottom`) or the visible height (`viewportHeight`) changed.
 *
 * BOTH, BECAUSE EACH PLATFORM SHOWS ONLY ONE (second review of #3556). Where the keyboard RESIZES the
 * page - the iOS app, whose shell shrinks the WebView, and a browser with `interactive-widget=
 * resizes-content` - the layout follows the visible height and `insetBottom` stays 0 for good, the
 * iOS hand-off included (`resolveImeTarget` lays both viewports out at the same height): a keyboard
 * growing while open (the emoji keyboard, the predictive bar, `canari_ios.mm` resizing with no
 * announcement) changes `viewportHeight` alone. Where it covers the page (the Android overlay, a phone
 * browser that pans) the band moves. The Android WebView's two no-op resizes after an overlay
 * announcement change neither: the overlay's visible height is the window less the announced keyboard,
 * and neither number moved.
 */
export function keyboardMoved(
  before: Pick<KeyboardViewportSnapshot, 'insetBottom' | 'viewportHeight'>,
  after: Pick<KeyboardViewportSnapshot, 'insetBottom' | 'viewportHeight'>
): boolean {
  return before.insetBottom !== after.insetBottom || before.viewportHeight !== after.viewportHeight;
}

/**
 * How an update reveals the focused field, or null when it does not.
 *
 * A keyboard OPENING reveals at once (`auto`): the field must be above the keyboard on the frame it
 * arrives, and a smooth scroll in a modal, the PIN dialog or a payment overlay runs under it. With
 * iOS's hand-off (`canariImeTarget` with a bare number) the opening is TWO updates - the announced
 * layout, then the WebView's real resize that spends the target - and both belong to the opening, so
 * the second is `auto` too (review of #3490, S3). An Android overlay is never spent: its opening is
 * one update. A later update with the keyboard up is `smooth` - only when the keyboard MOVED
 * ({@link keyboardMoved}): a `resize` that changes nothing reveals nothing. The Android WebView fires
 * a window and a visual-viewport `resize` ~15 ms after every overlay announcement with no size
 * changed, and each re-revealed the field (three reveals per rise, Mi 9T, #3556, N3). A field gaining
 * focus with the keyboard already up is `handleFocusIn`'s, not this.
 */
export function keyboardRevealOnUpdate(u: {
  isOpen: boolean;
  openedNow: boolean;
  targetSpent: boolean;
  hasFocus: boolean;
  /** The update moved the keyboard: {@link keyboardMoved}. */
  keyboardMoved: boolean;
}): ScrollBehavior | null {
  if (!u.isOpen) return null;
  if (u.openedNow || u.targetSpent) return 'auto';
  return u.hasFocus && u.keyboardMoved ? 'smooth' : null;
}

/**
 * The colour under the keyboard's band to the Android shell (`canariTheme.setGround`), which paints
 * it under the transparent WebView: the strip a keyboard's resize opens below the page is then the
 * page's own ground - read where the keyboard will sit, so a full-bleed black screen (CanaReels,
 * live, camera) gets black and a conversation its grey (keyboard-and-send-motion.md). Read once per
 * rise, when the layout is about to change anyway - never on a theme apply at boot. Absent in the
 * browser and on iOS, where this is a no-op by design, not a fallback.
 */
function postGroundToNative(): void {
  const bridge = (window as unknown as { canariTheme?: { setGround?: (c: string) => void } })
    .canariTheme;
  if (!bridge?.setGround) return;
  const start = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 1);
  const ground = groundOf(start, (el) => getComputedStyle(el).backgroundColor, cssColorToHex);
  if (!ground) {
    Log.w('keyboardViewport', 'no opaque ground under the keyboard band - the native one is kept');
    return;
  }
  bridge.setGround(ground);
}

/**
 * Whether a refused announcement carried an animation (`durationMs` or `curve`): the part of the
 * contract that can break while the height itself is sound.
 */
function carriesAnimation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { durationMs, curve } = value as Record<string, unknown>;
  return durationMs !== undefined || curve !== undefined;
}

/**
 * Tells the Android shell the page is READY to be told the keyboard from scratch
 * (`canariIme.pageReady`, `MainActivity.ImeBridge`): it re-announces the current inset WITHOUT an
 * animation. Called when a document starts, and right after the page refused an ANIMATED
 * announcement (second review of #3556): the shell no longer re-sends a refusal on its next insets
 * pass - with a steady keyboard none came, and the page stayed laid out for the old keyboard - so the
 * page asks. It asks at most once per refusal: the answer carries no animation, and a refusal of
 * that form does not ask again. Absent outside Android, where this does nothing.
 */
function askShellAgain(): void {
  const bridge = (window as unknown as { canariIme?: { pageReady?: () => void } }).canariIme;
  if (!bridge?.pageReady) return;
  Log.d('keyboardViewport', 'asking the shell for the keyboard (pageReady)');
  bridge.pageReady();
}

/**
 * Declares to the engine the contract the Android shell runs on: the keyboard OVERLAYS the content
 * and the page places itself (`navigator.virtualKeyboard.overlaysContent`). Without it Chromium, on
 * the keyboard's show, scrolls the focused field into the visual viewport it has just shrunk - and
 * while the composer RIDES, its caret is still drawn at its old place under the keys, so the visual
 * viewport panned by the whole keyboard on top of the page's own move: the composer stood a keyboard
 * above the keys and the header left the screen (Mi 9T, 2026-11-15, 6 of 6 taps; 0 of 6 with the
 * declaration). A field outside a ride is revealed by the page (`keyboardRevealOnUpdate`), which
 * this does not stop. The shell's bridge (`canariIme`) is the fact that names the Android app;
 * nowhere else is the keyboard the page's to place. Returns whether the declaration was made.
 */
export function declareKeyboardOverlay(win: {
  canariIme?: unknown;
  navigator: { virtualKeyboard?: { overlaysContent: boolean } };
}): boolean {
  if (!win.canariIme) return false;
  const keyboard = win.navigator.virtualKeyboard;
  if (!keyboard) {
    Log.w(
      'keyboardViewport',
      'no navigator.virtualKeyboard in this WebView: the engine will pan to reveal a riding field'
    );
    return false;
  }
  keyboard.overlaysContent = true;
  Log.d('keyboardViewport', 'the keyboard overlays the content (declared to the engine)');
  return true;
}

/**
 * Registers listeners and updates CSS variables. Call once from the root layout.
 * Returns a teardown function.
 */
export function initKeyboardViewport(seams: KeyboardViewportSeams = {}): () => void {
  if (typeof window === 'undefined') return () => {};

  baselineHeight = window.innerHeight;
  /**
   * The window width the baseline was measured at. A keyboard never changes the width; a rotation, a
   * split screen or a desktop resize does, and a baseline from another width is another window's.
   * So a new width starts a new baseline - what a 400 ms timer after `orientationchange` used to
   * guess at (review of #3556, F1) - and the baseline is then the height of each reading at that
   * width until one is SETTLED ({@link isSettledWindow}): that reading's height is the baseline, and
   * from then on only `max()` raises it. Not while pinch-zoomed: WebKit's `innerWidth` follows the
   * zoom.
   */
  let baselineWidth = window.innerWidth;
  /** Whether the baseline came from a settled reading at `baselineWidth` (the first update decides). */
  let baselineSettled = false;

  let keyboardWasOpen = false;
  const afterLayout = seams.afterLayout ?? afterLayoutReactions;
  const now = seams.now ?? (() => performance.now());
  /** A fall the iOS shell announced, captured before its resize (`keyboardRide.ts`), or null. */
  let pendingRide: KeyboardRideCapture | null = null;
  /** The ride waiting for the resize's layout reactions: cancels that wait. */
  let cancelArmedRide: (() => void) | null = null;
  /** The ride running now, cancelled by a rise or a press (`keyboardRide.ts` says why). */
  let runningRide: KeyboardRide | null = null;

  /** Ends every ride, pending, armed or running: each piece jumps to its own place. */
  const endRides = (why: string) => {
    const had = pendingRide !== null || cancelArmedRide !== null || runningRide !== null;
    pendingRide = null;
    cancelArmedRide?.();
    cancelArmedRide = null;
    for (const a of runningRide?.animations ?? []) a.cancel();
    runningRide = null;
    if (had) Log.d('keyboardViewport', `keyboard ride ended: ${why}`);
  };

  /**
   * The new layout is applied (the resize of an announced iOS fall landed, or an Android announcement
   * was taken): ride once its layout reactions have run. `what` names the ride in its log line.
   */
  const armRide = (capture: KeyboardRideCapture, what: string) => {
    cancelArmedRide = afterLayout(
      capture.riders.map((r) => r.el),
      () => {
        cancelArmedRide = null;
        runningRide = startKeyboardRide(capture, now);
        Log.d(
          'keyboardViewport',
          runningRide === null
            ? `${what}: nothing to ride`
            : `${what} ridden over ${capture.durationMs} ms from ${Math.round(runningRide.phaseMs)} ms in: ${runningRide.distances.map(Math.round).join(', ')}px`
        );
      }
    );
  };

  /**
   * Applies the keyboard's state. `w` is the window as it stood BEFORE the caller wrote anything
   * (`WindowReading`): nothing below reads the window or the layout after the variables are written.
   */
  const update = (w: WindowReading = readWindow()) => {
    if (w.scale <= ZOOM_SCALE_EPSILON) {
      if (w.winW !== baselineWidth) {
        Log.d('keyboardViewport', `window width ${baselineWidth} -> ${w.winW}: a new baseline`);
        baselineWidth = w.winW;
        baselineSettled = false;
      }
      if (!baselineSettled) {
        baselineSettled = isSettledWindow(w);
        Log.d(
          'keyboardViewport',
          `baseline ${baselineHeight} -> ${w.winH} (${baselineSettled ? 'settled' : `not settled: visual ${w.vvWidth} x ${w.vvHeight}, layout ${w.winW} x ${w.winH}`})`
        );
        baselineHeight = w.winH;
      }
    }
    const handingOff = imeTarget?.kind === 'handoff';
    const m = measureViewport(w);
    const next = readSnapshot(m);
    const openedNow = next.isOpen && !keyboardWasOpen;
    const closedNow = !next.isOpen && keyboardWasOpen;
    const insetMoved = next.insetBottom !== snapshot.insetBottom;
    const moved = keyboardMoved(snapshot, next);
    snapshot = next;
    applyCssVars(next, m, baselineHeight);
    if (next.keyboardHeight > 0) {
      rememberKeyboardHeight(next.keyboardHeight, orientationOf(w.winW, w.winH));
    }

    if (closedNow && pendingRide) {
      const capture = pendingRide;
      pendingRide = null;
      armRide(capture, 'keyboard fall');
    }

    const reveal = keyboardRevealOnUpdate({
      isOpen: next.isOpen,
      openedNow,
      targetSpent: handingOff && imeTarget === null,
      hasFocus: document.activeElement instanceof HTMLElement,
      keyboardMoved: moved,
    });
    if (reveal) scrollFocusedFieldIntoView(reveal);

    keyboardWasOpen = next.isOpen;

    if (!next.isOpen) {
      baselineHeight = Math.max(baselineHeight, w.winH);
    }
    if (insetMoved) notifyInsetListeners();
  };
  /** `update` as an event listener: the event is not a window reading. */
  const onViewportEvent = () => update();

  // Fix 3: a visual-viewport `scroll` is a PAN, not a resize. Only refresh the overlay offset -
  // never re-evaluate keyboard state, re-pin the shell height, or re-run scrollIntoView (which
  // would fight the user's own scroll and jitter). Height stays owned by the `resize` path.
  const updateOffsetOnly = () => {
    const vv = window.visualViewport;
    if (!vv) return;
    const offsetTop = vv.scale > ZOOM_SCALE_EPSILON ? 0 : vv.offsetTop;
    snapshot = { ...snapshot, offsetTop };
    document.documentElement.style.setProperty('--visual-viewport-offset-top', `${offsetTop}px`);
  };

  const handleFocusIn = (e: FocusEvent) => {
    const target = e.target;
    if (!(target instanceof HTMLElement) || !isFocusableField(target)) return;
    if (!snapshot.isOpen) return;
    scrollFocusedFieldIntoView('smooth');
  };

  const handleTransitionEnd = (e: TransitionEvent) => {
    if (!snapshot.isOpen) return;
    if (!overlaySettledAroundFocus(e.propertyName, e.target, document.activeElement)) return;
    Log.d('keyboardViewport', 'overlay settled - revealing the focused field in its final box');
    scrollFocusedFieldIntoView('smooth');
  };

  /**
   * The ride of an Android announcement, captured where every piece is DRAWN now - a ride still
   * running included, its transform being part of what the reader sees - before its layout is
   * applied; or null when it is not ridden: no animation (a rotation, a page asking again, a
   * gesture-driven one), an instant one, reduced motion, or a screen with no riding piece. A thread
   * rides its rows. Reads only: a glide in flight on the rows is taken off afterwards
   * (`releaseThreadGlides`).
   *
   * @param announcedAt when the announcement arrived, on `now`'s clock: the keyboard's own start.
   */
  const captureAnnouncedRide = (
    px: number,
    animation: ImeAnimation | null,
    announcedAt: number
  ) => {
    if (animation === null || animation.durationMs === 0) return null;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false) {
      Log.d('keyboardViewport', `keyboard to ${px} not ridden: reduced motion`);
      return null;
    }
    return captureKeyboardRide(
      document,
      animation.durationMs,
      animation.easing,
      'rows',
      announcedAt
    );
  };

  /**
   * `window.canariImeTarget`: the native shell's announcement of a keyboard (`imeTarget.ts`).
   *
   * iOS's rise (`CanariHandKeyboardRiseToPage`, a bare number): the layout is applied HERE,
   * synchronously, so the frame the shell waits for before resizing the WebView already holds it.
   *
   * Android (`MainActivity.announceIme`, an object, every change of the keyboard): the layout over
   * the keyboard is applied here too, and the pieces ride from where they stood when the keyboard
   * moves animated, ON THE KEYBOARD'S TIMELINE: the arrival is the keyboard's start, so a ride that
   * can only start a frame later starts that far into the keyboard's curve (`startKeyboardRide`).
   *
   * EVERY READ BEFORE THE FIRST WRITE (review of #3556, D3, F3): the arrival time, the ground under
   * the keyboard, the window's size and where each riding piece is DRAWN - a ride still running
   * included, so a Back mid-rise starts the fall from where the composer was, not from its end - and
   * only then is any ride or glide ended and the variables written. Nothing after reads the layout.
   *
   * `true` tells the shell it was taken.
   */
  const takeImeTarget = (value: unknown): boolean => {
    const target = parseImeTarget(value);
    if (target === null) {
      Log.w('keyboardViewport', `keyboard target refused: ${JSON.stringify(value)}`);
      if (carriesAnimation(value)) askShellAgain();
      return false;
    }
    // Android's ride is phased on the announcement's arrival: taken before anything else costs time.
    const announcedAt = now();
    // A read (a hit test, computed colours): before anything below writes.
    if (target.px > 0) postGroundToNative();
    if (target.kind === 'handoff') {
      Log.d('keyboardViewport', `keyboard target ${target.px} announced ahead of the resize`);
      // A rise ends any fall still waiting for its resize, and any ride still running: the rise's
      // layout, and the screen-update proof the shell takes of it, must carry no stale transform.
      if (target.px > 0) endRides('a rise');
      imeTarget = target;
      update();
      return true;
    }
    Log.d(
      'keyboardViewport',
      `keyboard over the window: ${target.px} (${target.animation ? `${target.animation.durationMs} ms` : 'no animation'})`
    );
    const reading = readWindow();
    const capture = captureAnnouncedRide(target.px, target.animation, announcedAt);
    endRides('a new keyboard announcement');
    if (capture !== null) releaseThreadGlides(capture);
    imeTarget = target;
    update(reading);
    if (capture !== null) armRide(capture, `keyboard to ${target.px}`);
    return true;
  };
  (window as unknown as { canariImeTarget?: (v: unknown) => boolean }).canariImeTarget =
    takeImeTarget;
  const overlayDeclared = declareKeyboardOverlay(
    window as unknown as Parameters<typeof declareKeyboardOverlay>[0]
  );
  // A new document is up: the Android shell announces the keyboard's current inset to it
  // (`MainActivity.ImeBridge`), whatever it told the previous one. Absent outside Android.
  askShellAgain();

  /**
   * `window.canariKeyboardFall`: the iOS shell's announcement of a keyboard fall, with the keyboard's
   * own duration and curve, made BEFORE it resizes the WebView (`CanariHandKeyboardFallToPage`). The
   * riding pieces are captured here, where they still stand; the ride starts in `update` when the
   * resize lands. `true` tells the shell the page rides it.
   */
  const takeKeyboardFall = (value: unknown): boolean => {
    const spec = parseKeyboardFall(value);
    if (spec === null) {
      Log.w('keyboardViewport', `keyboard fall refused: ${JSON.stringify(value)}`);
      return false;
    }
    // A capture must read the pieces where they stand, not where a previous ride is carrying them.
    endRides('a new fall');
    const easing = uikitCurveEasing(spec.curve);
    const refusal = fallRefusal(spec, {
      easing,
      reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      isOpen: snapshot.isOpen,
      openThresholdPx: keyboardOpenThresholdPx(),
    });
    if (refusal !== null || easing === null) {
      const why = refusal?.why ?? 'no easing';
      if (refusal?.level === 'warn') Log.w('keyboardViewport', `keyboard fall not ridden: ${why}`);
      else Log.d('keyboardViewport', `keyboard fall not ridden: ${why}`);
      return false;
    }
    pendingRide = captureKeyboardRide(document, spec.durationMs, easing);
    return pendingRide !== null;
  };
  (window as unknown as { canariKeyboardFall?: (v: unknown) => boolean }).canariKeyboardFall =
    takeKeyboardFall;

  // A press during a ride (a picker opening, a tap on a row) ends it: while a piece rides it is the
  // containing block of its fixed descendants (`keyboardRide.ts`).
  const handlePointerDown = () => {
    if (runningRide !== null) endRides('a press');
  };

  update();
  window.addEventListener('resize', onViewportEvent);
  window.addEventListener('pointerdown', handlePointerDown, true);
  window.addEventListener('focusin', handleFocusIn, true);
  window.addEventListener('transitionend', handleTransitionEnd, true);
  window.visualViewport?.addEventListener('resize', onViewportEvent);
  window.visualViewport?.addEventListener('scroll', updateOffsetOnly);

  return () => {
    window.removeEventListener('resize', onViewportEvent);
    window.removeEventListener('pointerdown', handlePointerDown, true);
    window.removeEventListener('focusin', handleFocusIn, true);
    window.removeEventListener('transitionend', handleTransitionEnd, true);
    window.visualViewport?.removeEventListener('resize', onViewportEvent);
    window.visualViewport?.removeEventListener('scroll', updateOffsetOnly);
    delete (window as unknown as { canariImeTarget?: unknown }).canariImeTarget;
    delete (window as unknown as { canariKeyboardFall?: unknown }).canariKeyboardFall;
    if (overlayDeclared) {
      (
        navigator as unknown as { virtualKeyboard: { overlaysContent: boolean } }
      ).virtualKeyboard.overlaysContent = false;
    }
    imeTarget = null;
    endRides('teardown');
    pinSafeAreaBottom(document.documentElement.style, null);
    document.documentElement.style.removeProperty('--keyboard-inset-bottom');
    document.documentElement.style.removeProperty('--keyboard-layout-inset-bottom');
    document.documentElement.style.removeProperty('--keyboard-occlusion-bottom');
    document.documentElement.style.removeProperty('--visual-viewport-offset-top');
    document.documentElement.style.removeProperty(KEYBOARD_FREE_HEIGHT_PROPERTY);
  };
}
