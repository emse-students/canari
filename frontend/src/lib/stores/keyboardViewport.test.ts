// @vitest-environment happy-dom
import {
  computeSnapshot,
  hasVirtualKeyboard,
  isDoubleReport,
  keyboardSafeAreaBottomOverride,
  overlaySettledAroundFocus,
  pinSafeAreaBottom,
  revealBehavior,
  scrollFocusedFieldIntoView,
  type ViewportMeasurement,
} from './keyboardViewport.svelte';
import { readFileSync } from 'node:fs';

describe('hasVirtualKeyboard', () => {
  it('is false on desktop, where a shorter window is a resize and not a keyboard', () => {
    for (const os of ['windows', 'macos', 'linux']) expect(hasVirtualKeyboard(os)).toBe(false);
  });

  it('is true on phones and tablets', () => {
    for (const os of ['android', 'ios']) expect(hasVirtualKeyboard(os)).toBe(true);
  });
});

const IOS_THRESHOLD = 100;
const baseline = 800;

/** Builds a measurement with sensible defaults (at-rest, no keyboard, no zoom). */
function measure(overrides: Partial<ViewportMeasurement> = {}): ViewportMeasurement {
  return { winH: baseline, vvHeight: baseline, offsetTop: 0, scale: 1, ...overrides };
}

describe('computeSnapshot', () => {
  it('reports closed at rest', () => {
    const snap = computeSnapshot(measure(), baseline, IOS_THRESHOLD);
    expect(snap.isOpen).toBe(false);
    expect(snap.zoomed).toBe(false);
    expect(snap.viewportHeight).toBe(baseline);
    expect(snap.insetBottom).toBe(0);
  });

  it('detects an open keyboard when the visual viewport shrinks (adjustResize)', () => {
    // winH also shrank: adjustResize resized the layout viewport.
    const snap = computeSnapshot(measure({ winH: 480, vvHeight: 480 }), baseline, IOS_THRESHOLD);
    expect(snap.isOpen).toBe(true);
    expect(snap.zoomed).toBe(false);
    expect(snap.viewportHeight).toBe(480);
    // Layout shrank -> fixed UI needs no extra lift.
    expect(snap.layoutInsetBottom).toBe(0);
  });

  it('leaves no band below the shell once the native layer resizes (iOS keyboard)', () => {
    // THE GEOMETRY THAT WAS WRONG ON iOS, and the one property that separates the two worlds.
    // WKWebView is not resized for the keyboard on its own: `winH` stays full while only the
    // visual viewport shrinks, so the shell gets pinned to 480 inside a document still 800 tall
    // and a keyboard-tall empty band opens below it - which WebKit then scrolls onto when it
    // reveals the focused field. Both worlds report `layoutInsetBottom: 0`, so that field cannot
    // tell them apart; what can is whether the shell height IS the layout viewport.
    const withoutNativeResize = computeSnapshot(
      measure({ vvHeight: 480 }),
      baseline,
      IOS_THRESHOLD
    );
    expect(withoutNativeResize.isOpen).toBe(true);
    expect(withoutNativeResize.viewportHeight).toBeLessThan(800); // shell 480, document 800

    // With canari_ios.mm's CanariApplyKeyboardLayout shrinking the WebView, the layout viewport
    // itself moves, so the two agree and the band cannot exist.
    const withNativeResize = computeSnapshot(
      measure({ winH: 480, vvHeight: 480 }),
      baseline,
      IOS_THRESHOLD
    );
    expect(withNativeResize.viewportHeight).toBe(480);
    expect(withNativeResize.insetBottom).toBe(0);
    expect(withNativeResize.layoutInsetBottom).toBe(0);
  });

  it('carries the pan offset through when the page is panned (adjustPan)', () => {
    // winH stays full, only the visual viewport shrinks and is offset (iOS adjustPan).
    const snap = computeSnapshot(
      measure({ vvHeight: 480, offsetTop: 40 }),
      baseline,
      IOS_THRESHOLD
    );
    expect(snap.isOpen).toBe(true);
    expect(snap.insetBottom).toBe(280); // 800 - 480 - 40
    expect(snap.offsetTop).toBe(40);
  });

  it('root-cause guard: a pinch-zoom (scale > 1) is NOT a keyboard', () => {
    // Same shrink as a keyboard, but the user zoomed in. Must stay closed + full height.
    const snap = computeSnapshot(
      measure({ vvHeight: 480, offsetTop: 120, scale: 2.3 }),
      baseline,
      IOS_THRESHOLD
    );
    expect(snap.zoomed).toBe(true);
    expect(snap.isOpen).toBe(false);
    // Shell height is left at the baseline (never collapsed onto the zoomed viewport).
    expect(snap.viewportHeight).toBe(baseline);
    expect(snap.offsetTop).toBe(0);
    expect(snap.insetBottom).toBe(0);
    expect(snap.layoutInsetBottom).toBe(0);
  });

  it('treats a scale barely above 1 as at rest, not zoomed', () => {
    const snap = computeSnapshot(measure({ scale: 1.005 }), baseline, IOS_THRESHOLD);
    expect(snap.zoomed).toBe(false);
  });
});

describe('computeSnapshot - keyboardHeight', () => {
  it('is what the keyboard took from the baseline, on every platform shape', () => {
    // The app shrinks the layout viewport too (iOS native, Android padding)...
    expect(
      computeSnapshot(measure({ winH: 464, vvHeight: 464 }), baseline, IOS_THRESHOLD).keyboardHeight
    ).toBe(336);
    // ...a phone browser only the visual one.
    expect(
      computeSnapshot(measure({ vvHeight: 464 }), baseline, IOS_THRESHOLD).keyboardHeight
    ).toBe(336);
  });

  it('is zero while closed (a URL bar sliding is not a keyboard) and while zoomed', () => {
    expect(
      computeSnapshot(measure({ vvHeight: 744 }), baseline, IOS_THRESHOLD).keyboardHeight
    ).toBe(0);
    expect(
      computeSnapshot(measure({ vvHeight: 400, scale: 2 }), baseline, IOS_THRESHOLD).keyboardHeight
    ).toBe(0);
  });
});

describe('computeSnapshot - the Android double report (Mi 9T, 2026-10-02 and 2026-10-13)', () => {
  const ANDROID_THRESHOLD = 160;
  const androidBaseline = 945;

  it('reads a visual viewport that counts the keyboard again as the layout viewport', () => {
    // 945 - 357 = 588: the layout already gave up the keyboard's room; the visual viewport then
    // read 230 = 588 - 358 for 60-100 ms. Trusted, it pinned the shell at 230 and the composer
    // jumped 358 px up and back.
    const snap = computeSnapshot(
      { winH: 588, vvHeight: 230, offsetTop: 0, scale: 1 },
      androidBaseline,
      ANDROID_THRESHOLD
    );
    expect(snap.isOpen).toBe(true);
    expect(snap.viewportHeight).toBe(588);
    expect(snap.insetBottom).toBe(0);
    expect(snap.layoutInsetBottom).toBe(0);
    expect(snap.keyboardHeight).toBe(357);
  });

  it('gives the same snapshot before and during the double report', () => {
    const settled = computeSnapshot(
      { winH: 588, vvHeight: 588, offsetTop: 0, scale: 1 },
      androidBaseline,
      ANDROID_THRESHOLD
    );
    const doubled = computeSnapshot(
      { winH: 588, vvHeight: 230, offsetTop: 0, scale: 1 },
      androidBaseline,
      ANDROID_THRESHOLD
    );
    expect(doubled).toEqual(settled);
  });

  it('leaves a pan alone: the layout did not shrink, so a short visual viewport is real', () => {
    const snap = computeSnapshot(
      { winH: androidBaseline, vvHeight: 588, offsetTop: 0, scale: 1 },
      androidBaseline,
      ANDROID_THRESHOLD
    );
    expect(snap.viewportHeight).toBe(588);
    expect(snap.insetBottom).toBe(357);
  });

  /**
   * Replays one rise, event by event, and returns the distinct shell heights it would pin, to the
   * whole CSS px (the settled visual viewport reads 587.9 against a layout of 588).
   */
  function shellHeights(rise: Array<[winH: number, vvHeight: number]>): number[] {
    const heights = rise.map(
      ([winH, vvHeight]) =>
        computeSnapshot(
          { winH, vvHeight, offsetTop: 0, scale: 1 },
          androidBaseline,
          ANDROID_THRESHOLD
        ).viewportHeight
    );
    return [...new Set(heights.map((h) => Math.round(h)))];
  }

  it('absorbs the double report of the system keyboard as read on the bench (LatinIME, 2026-10-13)', () => {
    // checkW-mi9t.json, rises 1-4: rest 945 / 945.5, one frame 588 / 230.3, settled 588 / 587.9.
    expect(
      shellHeights([
        [945, 945.5],
        [588, 230.3],
        [588, 587.9],
      ])
    ).toEqual([946, 588]);
  });

  it('absorbs the double report of a 90 px keyboard, which the old 160 px gate let through', () => {
    // The bench's ADB keyboard: the layout gives up 90, the visual viewport reads 90 below it.
    // Trusted, the shell went to 765 for one frame and the composer drew at 702 before 792.
    const doubled = computeSnapshot(
      { winH: 855, vvHeight: 765, offsetTop: 0, scale: 1 },
      androidBaseline,
      ANDROID_THRESHOLD
    );
    const settled = computeSnapshot(
      { winH: 855, vvHeight: 855, offsetTop: 0, scale: 1 },
      androidBaseline,
      ANDROID_THRESHOLD
    );
    expect(doubled).toEqual(settled);
    expect(
      shellHeights([
        [945, 945],
        [855, 765],
        [855, 855],
      ])
    ).toEqual([945, 855]);
  });

  it('recognises the double report at every keyboard height, with no size in the decision', () => {
    for (const keyboard of [40, 90, 159, 160, 161, 250, 357, 450]) {
      const winH = androidBaseline - keyboard;
      expect(
        isDoubleReport({ winH, vvHeight: winH - keyboard, offsetTop: 0, scale: 1 }, androidBaseline)
      ).toBe(true);
      // The same frame with its device-pixel rounding (0.4 CSS px on the Mi 9T) still is one.
      expect(
        isDoubleReport(
          { winH, vvHeight: winH - keyboard - 0.7, offsetTop: 0, scale: 1 },
          androidBaseline
        )
      ).toBe(true);
      // And the settled frame never is.
      expect(
        isDoubleReport({ winH, vvHeight: winH, offsetTop: 0, scale: 1 }, androidBaseline)
      ).toBe(false);
    }
  });

  it('trusts a visual viewport that moves first, before the layout gives anything up', () => {
    // The other order seen on the bench: `innerHeight` still 945 while the visual viewport already
    // reads 855. Nothing was given up, so nothing can have been counted twice.
    expect(
      isDoubleReport({ winH: 945, vvHeight: 855, offsetTop: 0, scale: 1 }, androidBaseline)
    ).toBe(false);
  });

  it('trusts a keyboard over a layout that is short for another reason (a URL bar)', () => {
    // A phone browser: the bar slid in (layout 56 short) and a 300 px keyboard covers the visual
    // viewport only. Below the layout is the keyboard, above it the bar: not the same height.
    const snap = computeSnapshot(
      { winH: 889, vvHeight: 589, offsetTop: 0, scale: 1 },
      androidBaseline,
      ANDROID_THRESHOLD
    );
    expect(snap.viewportHeight).toBe(589);
    expect(snap.isOpen).toBe(true);
  });
});

describe('keyboardSafeAreaBottomOverride and pinSafeAreaBottom - the iOS stale inset', () => {
  it('pins 0 only while an iOS keyboard is open', () => {
    expect(keyboardSafeAreaBottomOverride(true, 'ios')).toBe('0px');
    expect(keyboardSafeAreaBottomOverride(false, 'ios')).toBeNull();
    expect(keyboardSafeAreaBottomOverride(true, 'android')).toBeNull();
  });

  it('puts back the inline value it replaced (app.html pins 0px outside Tauri)', () => {
    const root = document.createElement('div').style;
    root.setProperty('--safe-area-inset-bottom', '12px');
    pinSafeAreaBottom(root, '0px');
    expect(root.getPropertyValue('--safe-area-inset-bottom')).toBe('0px');
    pinSafeAreaBottom(root, null);
    expect(root.getPropertyValue('--safe-area-inset-bottom')).toBe('12px');

    const bare = document.createElement('div').style;
    pinSafeAreaBottom(bare, '0px');
    pinSafeAreaBottom(bare, null);
    expect(bare.getPropertyValue('--safe-area-inset-bottom')).toBe('');
  });
});

describe('overlaySettledAroundFocus - the reveal redone once the overlay stops moving (iPhone 12, 2026-10-15)', () => {
  function overlayWithField(): { overlay: HTMLElement; field: HTMLInputElement } {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-keyboard-aware-overlay', '');
    const field = document.createElement('input');
    overlay.appendChild(field);
    return { overlay, field };
  }

  it('is true when the overlay holding the focused field ends its HEIGHT transition', () => {
    const { overlay, field } = overlayWithField();
    expect(overlaySettledAroundFocus('height', overlay, field)).toBe(true);
  });

  it('is false for another property, another element, or a focus outside the overlay', () => {
    const { overlay, field } = overlayWithField();
    expect(overlaySettledAroundFocus('padding-bottom', overlay, field)).toBe(false);
    expect(overlaySettledAroundFocus('height', field, field)).toBe(false);
    expect(overlaySettledAroundFocus('height', overlay, document.createElement('input'))).toBe(
      false
    );
    expect(overlaySettledAroundFocus('height', overlay, null)).toBe(false);
  });
});

describe('the reveal of a focused field (iPhone 12, v1.2.9-alpha.4)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function focusedModalField(): ReturnType<typeof vi.fn> {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
    const overlay = document.createElement('div');
    overlay.setAttribute('data-keyboard-aware-overlay', '');
    const field = document.createElement('input');
    const scrollIntoView = vi.fn();
    field.scrollIntoView = scrollIntoView;
    overlay.appendChild(field);
    document.body.appendChild(overlay);
    field.focus();
    return scrollIntoView;
  }

  it('stays `nearest` inside a modal, so a field already in view never jumps', () => {
    const scrollIntoView = focusedModalField();
    scrollFocusedFieldIntoView('auto');
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'auto',
    });
  });

  it('never animates for someone who asked for reduced motion', () => {
    expect(revealBehavior('smooth', true)).toBe('auto');
    expect(revealBehavior('smooth', false)).toBe('smooth');
    expect(revealBehavior('auto', false)).toBe('auto');
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query.includes('reduce'), media: query }) as MediaQueryList
    );
    const scrollIntoView = focusedModalField();
    scrollFocusedFieldIntoView('smooth');
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });

  // WHY A SOURCE TEST (WP-T5: keep). `scroll-margin` is a CSS rule and happy-dom computes no style,
  // so the scroll above is driven and the margin it relies on is read from `app.css`.
  it('a modal field carries the scroll margin that keeps the NEXT field above the footer', () => {
    const css = readFileSync('src/app.css', 'utf8');
    const rule = css.match(/\[data-keyboard-aware-overlay\]\s*:is\(([^{]+)\)\s*\{([^}]*)\}/);
    expect(rule, 'the overlay field rule is gone from app.css').not.toBeNull();
    expect(rule![1]).toContain('input');
    expect(rule![2]).toMatch(/scroll-margin-block-end:\s*6\.5rem/);
  });
});
