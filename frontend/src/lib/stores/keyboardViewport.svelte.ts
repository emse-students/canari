/**
 * Tracks the virtual keyboard via Visual Viewport API and exposes CSS variables +
 * reactive state for chat scroll and fixed bottom UI.
 */

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

function keyboardOpenThresholdPx(): number {
  const ua = navigator.userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  if (isIos) return 100;
  return 160;
}

/**
 * Pure geometry: turns raw viewport numbers into a keyboard snapshot.
 * Fix (root cause): when `scale > 1` the visual viewport shrank because of a pinch-zoom, not a
 * keyboard - bail out with `zoomed: true` and a full-height, closed snapshot so the shell is
 * left untouched (see the desktop-zoom / iOS-keyboard white-gap bug).
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
    };
  }

  const insetBottom = Math.max(0, m.winH - m.vvHeight - m.offsetTop);
  const delta = Math.max(baselineHeight - m.vvHeight, m.winH - m.vvHeight);
  const isOpen = delta > thresholdPx;
  const layoutShrunk =
    baselineHeight - m.winH > thresholdPx * 0.35 || m.winH - m.vvHeight > thresholdPx * 0.35;
  const layoutInsetBottom = isOpen && !layoutShrunk ? insetBottom : 0;

  return {
    isOpen,
    viewportHeight: m.vvHeight,
    offsetTop: m.offsetTop,
    insetBottom,
    layoutInsetBottom,
    zoomed: false,
  };
}

function readSnapshot(baselineHeight: number): KeyboardViewportSnapshot {
  const vv = window.visualViewport;
  const winH = window.innerHeight;
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
});

/** Reactive keyboard / viewport snapshot for components. */
export function getKeyboardViewport(): KeyboardViewportSnapshot {
  return snapshot;
}

/**
 * Padding for portaled overlays aligned to the visual viewport (see Modal overlay styles).
 * Does not add `--keyboard-inset-bottom` - the overlay box already matches `--app-viewport-height`.
 */
export const keyboardAwareOverlayPadding =
  'max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)';

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
    document.documentElement.style.removeProperty('--keyboard-inset-bottom');
    document.documentElement.style.removeProperty('--keyboard-layout-inset-bottom');
    document.documentElement.style.removeProperty('--visual-viewport-offset-top');
    document.documentElement.style.removeProperty('--keyboard-baseline-height');
  };
}
