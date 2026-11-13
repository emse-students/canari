/**
 * Tracks the virtual keyboard via Visual Viewport API and exposes CSS variables +
 * reactive state for chat scroll and fixed bottom UI.
 */

import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
import { rememberKeyboardHeight } from './keyboardHeightMemory';
import { cssColorToHex, groundOf } from './imeGround';
import { parseImeTarget, resolveImeTarget } from './imeTarget';
import {
  afterLayoutReactions,
  captureKeyboardRide,
  fallRefusal,
  parseKeyboardFall,
  startKeyboardRide,
  uikitCurveEasing,
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
   * Extra bottom offset for `position: fixed` UI when the layout viewport did not shrink
   * (adjustPan). Zero when adjustResize already resized the window.
   */
  layoutInsetBottom: number;
  /**
   * True when the user has pinch-zoomed in (visual viewport scale > 1). A zoomed-in visual
   * viewport shrinks exactly like a keyboard opening, so we must NOT treat it as one:
   * doing so collapses the app shell (white gaps) and hides the nav bars (reframing).
   */
  zoomed: boolean;
  /**
   * How tall the keyboard is, measured as what it took from the screen: the baseline height (the
   * tallest the viewport has been with no keyboard) minus the visible height. Zero while closed or
   * zoomed - a URL bar sliding is not a keyboard. ONE NUMBER FOR EVERY PLATFORM, because each of them
   * shrinks the VISUAL viewport whatever else it does: iOS's native layer resizes the WebView, the
   * Android app pads its content, a phone browser shrinks only the visual viewport. The composer's
   * GIF panel takes exactly this room (`composerSurface.ts`).
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
 * THE VISUAL VIEWPORT KNOWS FIRST. On Android 15+ (edge-to-edge, `adjustResize` inert) the layout
 * viewport gives up the keyboard's room only when `MainActivity` pads its content by the IME inset;
 * the visual viewport has already shrunk by then. Mi 9T, `1.6.9`, 2026-11-10: `visualViewport`
 * resize to 588 at +357 ms after the focus, `innerHeight` still 945 until +1000 ms - and a phone
 * browser never shrinks the layout viewport at all. Zero when pinch-zoomed (a zoom is not a
 * keyboard) and once the layout viewport has caught up; the double report is absorbed as in
 * `computeSnapshot`, so its one bogus frame is never a 357 px band.
 *
 * @param m the raw viewport measurement.
 * @param baselineHeight the tallest the layout viewport has been with no keyboard.
 */
export function keyboardInsetBottom(m: ViewportMeasurement, baselineHeight: number): number {
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
 */
export function computeSnapshot(
  m: ViewportMeasurement,
  baselineHeight: number,
  thresholdPx: number
): KeyboardViewportSnapshot {
  if (m.scale > ZOOM_SCALE_EPSILON) {
    return {
      isOpen: false,
      viewportHeight: baselineHeight,
      offsetTop: 0,
      insetBottom: 0,
      layoutInsetBottom: 0,
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
 * Android is left alone: its inset was not measured to lag.
 */
export function keyboardSafeAreaBottomOverride(isOpen: boolean, os: string): string | null {
  return isOpen && os === 'ios' ? '0px' : null;
}

/**
 * The viewport height a keyboard-free page would have, while a keyboard has taken it from the LAYOUT
 * viewport - or null when nothing has (the CSS then keeps its own `100svh`).
 *
 * WHY IT EXISTS: `--media-max-height` is `60svh`, meant to be stable, and in a phone BROWSER it is -
 * the keyboard shrinks only the visual viewport there. In the app it is not: Android pads the
 * WebView by the IME inset (`MainActivity.applyKeyboardInsets`) and iOS shrinks the WebView's frame
 * (`CanariApplyKeyboardLayout`), so the layout viewport itself shrinks and EVERY viewport unit
 * (`svh`, `lvh`, `dvh`, `vh`) shrinks with it. Measured on the Mi 9T (`1.6.11-alpha.5`, LatinIME):
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
 * Reads the viewport now. A desktop OS has no on-screen keyboard, so its visual viewport is read as
 * the layout viewport: a shorter window there is a resize (`hasVirtualKeyboard`). While the native
 * shell has announced a keyboard the WebView has not been resized for yet, the measurement is the
 * one that resize will produce (`resolveImeTarget`).
 */
function measureViewport(): ViewportMeasurement {
  const vv = window.visualViewport;
  const winH = window.innerHeight;
  if (!hasVirtualKeyboard(detectRuntimeDeviceOs())) {
    return { winH, vvHeight: winH, offsetTop: 0, scale: 1 };
  }
  const raw = {
    winH,
    vvHeight: vv?.height ?? winH,
    offsetTop: vv?.offsetTop ?? 0,
    scale: vv?.scale ?? 1,
  };
  const { measurement, drop } = resolveImeTarget(raw, baselineHeight, imeTargetPx);
  if (drop) {
    Log.d(
      'keyboardViewport',
      `keyboard target ${imeTargetPx} spent (layout ${winH}, visual ${raw.vvHeight})`
    );
    imeTargetPx = null;
  }
  return measurement;
}

/** The keyboard height the native shell announced ahead of its resize (`imeTarget.ts`), or null. */
let imeTargetPx: number | null = null;

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
    root.setProperty('--app-viewport-height', `${snapshot.viewportHeight}px`);
  } else {
    root.removeProperty('--app-viewport-height');
  }
  // Inline on the root, so it outranks the `:root` declaration. `app.html` already pins the same
  // property inline outside Tauri, so what was there is put BACK on release, never just removed.
  pinSafeAreaBottom(root, keyboardSafeAreaBottomOverride(snapshot.isOpen, detectRuntimeDeviceOs()));
  root.setProperty('--keyboard-inset-bottom', `${snapshot.insetBottom}px`);
  root.setProperty('--keyboard-layout-inset-bottom', `${snapshot.layoutInsetBottom}px`);
  root.setProperty('--visual-viewport-offset-top', `${snapshot.offsetTop}px`);
  root.setProperty('--keyboard-baseline-height', `${baselineHeight}px`);
  const keyboardFree = keyboardFreeViewportHeight(snapshot.isOpen, m.winH, baselineHeight);
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
};

/**
 * How an update reveals the focused field, or null when it does not.
 *
 * A keyboard OPENING reveals at once (`auto`): the field must be above the keyboard on the frame it
 * arrives, and a smooth scroll in a modal, the PIN dialog or a payment overlay runs under it. With
 * the Android hand-off (`canariImeTarget`) the opening is TWO updates - the announced layout, then
 * the WebView's real resize that spends the target - and both belong to the opening, so the second
 * is `auto` too (review of #3490, S3). Any later update with the keyboard up is `smooth`.
 */
export function keyboardRevealOnUpdate(u: {
  isOpen: boolean;
  openedNow: boolean;
  targetSpent: boolean;
  hasFocus: boolean;
}): ScrollBehavior | null {
  if (!u.isOpen) return null;
  if (u.openedNow || u.targetSpent) return 'auto';
  return u.hasFocus ? 'smooth' : null;
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
 * Registers listeners and updates CSS variables. Call once from the root layout.
 * Returns a teardown function.
 */
export function initKeyboardViewport(seams: KeyboardViewportSeams = {}): () => void {
  if (typeof window === 'undefined') return () => {};

  baselineHeight = window.innerHeight;

  let keyboardWasOpen = false;
  const afterLayout = seams.afterLayout ?? afterLayoutReactions;
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

  /** The resize of an announced fall landed: ride once its layout reactions have run. */
  const armRide = (capture: KeyboardRideCapture) => {
    cancelArmedRide = afterLayout(
      capture.riders.map((r) => r.el),
      () => {
        cancelArmedRide = null;
        runningRide = startKeyboardRide(capture);
        Log.d(
          'keyboardViewport',
          runningRide === null
            ? 'keyboard fall: no piece moved - nothing to ride'
            : `keyboard fall ridden over ${capture.durationMs} ms: ${runningRide.distances.map(Math.round).join(', ')}px`
        );
      }
    );
  };

  const update = () => {
    const announced = imeTargetPx !== null;
    const m = measureViewport();
    const next = readSnapshot(m);
    const openedNow = next.isOpen && !keyboardWasOpen;
    const closedNow = !next.isOpen && keyboardWasOpen;
    snapshot = next;
    applyCssVars(next, m, baselineHeight);
    if (next.keyboardHeight > 0) rememberKeyboardHeight(next.keyboardHeight);

    if (closedNow && pendingRide) {
      const capture = pendingRide;
      pendingRide = null;
      armRide(capture);
    }

    const reveal = keyboardRevealOnUpdate({
      isOpen: next.isOpen,
      openedNow,
      targetSpent: announced && imeTargetPx === null,
      hasFocus: document.activeElement instanceof HTMLElement,
    });
    if (reveal) scrollFocusedFieldIntoView(reveal);

    keyboardWasOpen = next.isOpen;

    if (!next.isOpen) {
      baselineHeight = Math.max(baselineHeight, window.innerHeight);
    }
  };

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

  const handleOrientationChange = () => {
    setTimeout(() => {
      baselineHeight = window.innerHeight;
      update();
    }, 400);
  };

  /**
   * `window.canariImeTarget`: the native shell's announcement of a keyboard (Android's
   * `MainActivity.handOffIme`, iOS's `CanariHandKeyboardRiseToPage`). The layout is applied HERE,
   * synchronously, so the frame the shell waits for before resizing the WebView already holds it;
   * `true` tells the shell it was taken.
   */
  const takeImeTarget = (value: unknown): boolean => {
    const px = parseImeTarget(value);
    if (px === null) {
      Log.w('keyboardViewport', `keyboard target refused: ${String(value)}`);
      return false;
    }
    Log.d('keyboardViewport', `keyboard target ${px} announced ahead of the resize`);
    if (px > 0) postGroundToNative();
    imeTargetPx = px;
    // A rise ends any fall still waiting for its resize, and any ride still running: the rise's
    // layout, and the screen-update proof the shell takes of it, must carry no stale transform.
    if (px > 0) endRides('a rise');
    update();
    return true;
  };
  (window as unknown as { canariImeTarget?: (v: unknown) => boolean }).canariImeTarget =
    takeImeTarget;
  // A new document is up: a hand-off the shell asked of the previous one ends, and the keyboard's
  // current inset is handed to this one (`MainActivity.ImeBridge`). Absent outside Android.
  (window as unknown as { canariIme?: { pageReady?: () => void } }).canariIme?.pageReady?.();

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
  window.addEventListener('resize', update);
  window.addEventListener('pointerdown', handlePointerDown, true);
  window.addEventListener('orientationchange', handleOrientationChange);
  window.addEventListener('focusin', handleFocusIn, true);
  window.addEventListener('transitionend', handleTransitionEnd, true);
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', updateOffsetOnly);

  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('pointerdown', handlePointerDown, true);
    window.removeEventListener('orientationchange', handleOrientationChange);
    window.removeEventListener('focusin', handleFocusIn, true);
    window.removeEventListener('transitionend', handleTransitionEnd, true);
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', updateOffsetOnly);
    delete (window as unknown as { canariImeTarget?: unknown }).canariImeTarget;
    delete (window as unknown as { canariKeyboardFall?: unknown }).canariKeyboardFall;
    imeTargetPx = null;
    endRides('teardown');
    pinSafeAreaBottom(document.documentElement.style, null);
    document.documentElement.style.removeProperty('--keyboard-inset-bottom');
    document.documentElement.style.removeProperty('--keyboard-layout-inset-bottom');
    document.documentElement.style.removeProperty('--visual-viewport-offset-top');
    document.documentElement.style.removeProperty('--keyboard-baseline-height');
    document.documentElement.style.removeProperty(KEYBOARD_FREE_HEIGHT_PROPERTY);
  };
}
