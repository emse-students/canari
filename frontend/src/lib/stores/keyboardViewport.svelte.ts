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
};

function keyboardOpenThresholdPx(): number {
  const ua = navigator.userAgent.toLowerCase();
  const isIos = /iphone|ipad|ipod/.test(ua);
  if (isIos) return 100;
  return 160;
}

function readSnapshot(baselineHeight: number): KeyboardViewportSnapshot {
  const vv = window.visualViewport;
  const winH = window.innerHeight;
  const viewportHeight = vv?.height ?? winH;
  const offsetTop = vv?.offsetTop ?? 0;
  const insetBottom = Math.max(0, winH - viewportHeight - offsetTop);
  const delta = Math.max(baselineHeight - viewportHeight, winH - viewportHeight);
  const isOpen = delta > keyboardOpenThresholdPx();
  const layoutShrunk =
    baselineHeight - winH > keyboardOpenThresholdPx() * 0.35 ||
    winH - viewportHeight > keyboardOpenThresholdPx() * 0.35;
  const layoutInsetBottom = isOpen && !layoutShrunk ? insetBottom : 0;

  return { isOpen, viewportHeight, offsetTop, insetBottom, layoutInsetBottom };
}

function applyCssVars(snapshot: KeyboardViewportSnapshot, baselineHeight: number): void {
  document.documentElement.style.setProperty(
    '--app-viewport-height',
    `${snapshot.viewportHeight}px`
  );
  document.documentElement.style.setProperty(
    '--keyboard-inset-bottom',
    `${snapshot.insetBottom}px`
  );
  document.documentElement.style.setProperty(
    '--keyboard-layout-inset-bottom',
    `${snapshot.layoutInsetBottom}px`
  );
  document.documentElement.style.setProperty(
    '--visual-viewport-offset-top',
    `${snapshot.offsetTop}px`
  );
  document.documentElement.style.setProperty('--keyboard-baseline-height', `${baselineHeight}px`);
}

let snapshot = $state<KeyboardViewportSnapshot>({
  isOpen: false,
  viewportHeight: 0,
  offsetTop: 0,
  insetBottom: 0,
  layoutInsetBottom: 0,
});

/** Reactive keyboard / viewport snapshot for components. */
export function getKeyboardViewport(): KeyboardViewportSnapshot {
  return snapshot;
}

/**
 * Padding for portaled overlays aligned to the visual viewport (see Modal overlay styles).
 * Does not add `--keyboard-inset-bottom` — the overlay box already matches `--app-viewport-height`.
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
  window.visualViewport?.addEventListener('scroll', update);

  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', handleOrientationChange);
    window.removeEventListener('focusin', handleFocusIn, true);
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', update);
    document.documentElement.style.removeProperty('--keyboard-inset-bottom');
    document.documentElement.style.removeProperty('--keyboard-layout-inset-bottom');
    document.documentElement.style.removeProperty('--visual-viewport-offset-top');
    document.documentElement.style.removeProperty('--keyboard-baseline-height');
  };
}
