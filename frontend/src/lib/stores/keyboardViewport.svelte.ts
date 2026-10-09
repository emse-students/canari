/**
 * Tracks the virtual keyboard via Visual Viewport API and exposes CSS variables +
 * reactive state for chat scroll and fixed bottom UI.
 */

import { detectRuntimeDeviceOs } from '$lib/mls-client/mlsPlatform';
import { rememberKeyboardHeight } from './keyboardHeightMemory';

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

  // A DOUBLE REPORT IS ONE KEYBOARD, NOT TWO (Android WebView, Mi 9T, 2026-10-02). For 60-100 ms of
  // every keyboard rise the layout viewport had ALREADY given up the keyboard's room (`winH` 588 of a
  // 945 baseline) while the visual viewport was reported 230 tall - 945 - 2 x 357: the height taken
  // off twice. Trusted, it pinned the shell at 230 and the composer jumped 358 px up and back. A
  // visual viewport can only be SHORTER than a layout viewport that shrank by a keyboard's worth if
  // it is counting that keyboard again (a pan keeps `winH` full, a pinch-zoom is `scale` and bailed
  // out above), so it is read as the layout viewport's own height.
  const layoutGaveUpKeyboard = baselineHeight - m.winH > thresholdPx;
  const doubleReported = layoutGaveUpKeyboard && m.winH - m.vvHeight > thresholdPx * 0.35;
  const vvHeight = doubleReported ? m.winH : m.vvHeight;

  const insetBottom = Math.max(0, m.winH - vvHeight - m.offsetTop);
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
 * Whether this OS can have an on-screen keyboard at all. A desktop window has none, so a window
 * made shorter than its tallest size is a RESIZE, never a keyboard: it used to read as one past
 * 160px and hid the top bar and the bottom bar while the fixed rail kept its offset, leaving a gap
 * above it (user, 2026-10-04).
 */
export function hasVirtualKeyboard(os: string): boolean {
  return os !== 'windows' && os !== 'macos' && os !== 'linux';
}

function readSnapshot(baselineHeight: number): KeyboardViewportSnapshot {
  const vv = window.visualViewport;
  const winH = window.innerHeight;
  if (!hasVirtualKeyboard(detectRuntimeDeviceOs())) {
    return computeSnapshot(
      { winH, vvHeight: winH, offsetTop: 0, scale: 1 },
      winH,
      keyboardOpenThresholdPx()
    );
  }
  return computeSnapshot(
    {
      winH,
      vvHeight: vv?.height ?? winH,
      offsetTop: vv?.offsetTop ?? 0,
      scale: vv?.scale ?? 1,
    },
    baselineHeight,
    keyboardOpenThresholdPx()
  );
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

function applyCssVars(snapshot: KeyboardViewportSnapshot, baselineHeight: number): void {
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

/** Scrolls the focused field into the visible viewport (above the virtual keyboard). */
export function scrollFocusedFieldIntoView(behavior: ScrollBehavior = 'smooth'): void {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !isFocusableField(el)) return;
  if (el.closest('.chat-composer-footer, .app-layout')) return;
  requestAnimationFrame(() => {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior });
  });
}

/**
 * Registers listeners and updates CSS variables. Call once from the root layout.
 * Returns a teardown function.
 */
export function initKeyboardViewport(): () => void {
  if (typeof window === 'undefined') return () => {};

  let baselineHeight = window.innerHeight;

  let keyboardWasOpen = false;

  const update = () => {
    const next = readSnapshot(baselineHeight);
    const openedNow = next.isOpen && !keyboardWasOpen;
    snapshot = next;
    applyCssVars(next, baselineHeight);
    if (next.keyboardHeight > 0) rememberKeyboardHeight(next.keyboardHeight);

    if (next.isOpen && (openedNow || document.activeElement instanceof HTMLElement)) {
      scrollFocusedFieldIntoView(openedNow ? 'auto' : 'smooth');
    }

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

  const handleOrientationChange = () => {
    setTimeout(() => {
      baselineHeight = window.innerHeight;
      update();
    }, 400);
  };

  update();
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', handleOrientationChange);
  window.addEventListener('focusin', handleFocusIn, true);
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', updateOffsetOnly);

  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', handleOrientationChange);
    window.removeEventListener('focusin', handleFocusIn, true);
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', updateOffsetOnly);
    pinSafeAreaBottom(document.documentElement.style, null);
    document.documentElement.style.removeProperty('--keyboard-inset-bottom');
    document.documentElement.style.removeProperty('--keyboard-layout-inset-bottom');
    document.documentElement.style.removeProperty('--visual-viewport-offset-top');
    document.documentElement.style.removeProperty('--keyboard-baseline-height');
  };
}
