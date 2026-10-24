// @vitest-environment happy-dom
/**
 * `--text-zoom` is the factor by which FONT sizes outgrow LENGTHS - 2 on Android's WebView at a 200 %
 * system text size, 1 on a desktop whose default font was raised (both grow together there).
 * jsdom lays nothing out, so the two measurements are stubbed.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  publishTextZoom,
  iosTypeScale,
  publishIosTypeScale,
  followIosDynamicType,
  DYNAMIC_TYPE_EVENT,
  IOS_TYPE_SCALE_MAX,
  IOS_DEFAULT_BODY_PX,
} from './textZoom';

function stub(remBoxPx: number, rootFontPx: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width: remBoxPx }) as DOMRect
  );
  const real = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
    el === document.documentElement
      ? ({ fontSize: `${rootFontPx}px` } as CSSStyleDeclaration)
      : real(el)
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--text-zoom');
});

describe('publishTextZoom', () => {
  it('publishes 2 when fonts doubled and a rem box did not (Android WebView at 200 %)', () => {
    stub(16, 32);
    expect(publishTextZoom()).toBe(2);
    expect(document.documentElement.style.getPropertyValue('--text-zoom')).toBe('2');
  });

  it('publishes 1 when a raised default font grew the rem box with it', () => {
    stub(20, 20);
    expect(publishTextZoom()).toBe(1);
    expect(document.documentElement.style.getPropertyValue('--text-zoom')).toBe('1');
  });

  it('publishes nothing when there is no layout to measure', () => {
    stub(0, 16);
    expect(publishTextZoom()).toBe(1);
    expect(document.documentElement.style.getPropertyValue('--text-zoom')).toBe('');
  });

  it('leaves no probe behind', () => {
    stub(16, 32);
    const before = document.body.childElementCount;
    publishTextZoom();
    expect(document.body.childElementCount).toBe(before);
  });
});

describe('iosTypeScale', () => {
  it.each([
    [17, 1],
    [14, 1],
    [19, 1.12],
    [23, 1.35],
    [34, 2],
    [53, IOS_TYPE_SCALE_MAX],
    [0, 1],
    [NaN, 1],
  ])('maps a %s px body to %s', (px, scale) => {
    expect(iosTypeScale(px)).toBe(scale);
  });
});

describe('publishIosTypeScale', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--type-scale');
  });

  it('publishes the scale and the exemption factor from the probe, and removes the probe', () => {
    const real = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el instanceof HTMLElement && el.style.cssText.includes('apple-system-body')
        ? ({ fontSize: '25.5px' } as CSSStyleDeclaration)
        : real(el)
    );
    const before = document.body.childElementCount;
    expect(publishIosTypeScale()).toBe(1.5);
    expect(document.documentElement.style.getPropertyValue('--type-scale')).toBe('1.5');
    expect(document.documentElement.style.getPropertyValue('--text-zoom')).toBe('');
    expect(document.body.childElementCount).toBe(before);
  });
});

describe('followIosDynamicType', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--type-scale');
    document.documentElement.style.removeProperty('--text-zoom');
  });

  it('publishes nothing and listens to nothing when not on iOS (Android keeps its measured --text-zoom)', () => {
    document.documentElement.style.setProperty('--text-zoom', '2');
    const add = vi.spyOn(window, 'addEventListener');
    const dispose = followIosDynamicType(false);
    expect(document.documentElement.style.getPropertyValue('--type-scale')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--text-zoom')).toBe('2');
    expect(add).not.toHaveBeenCalledWith(DYNAMIC_TYPE_EVENT, expect.anything());
    expect(() => dispose()).not.toThrow();
  });

  it('on iOS publishes the probe now, then the size native reports on each change, until disposed', () => {
    const real = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el instanceof HTMLElement && el.style.cssText.includes('apple-system-body')
        ? ({ fontSize: '17px' } as CSSStyleDeclaration)
        : real(el)
    );
    const dispose = followIosDynamicType(true);
    expect(document.documentElement.style.getPropertyValue('--type-scale')).toBe('1');
    // What canari_ios.mm sends on return from Settings - the probe still reads the OLD size there.
    window.dispatchEvent(new CustomEvent(DYNAMIC_TYPE_EVENT, { detail: { bodyPx: 25.5 } }));
    expect(document.documentElement.style.getPropertyValue('--type-scale')).toBe('1.5');
    dispose();
    window.dispatchEvent(new CustomEvent(DYNAMIC_TYPE_EVENT, { detail: { bodyPx: 34 } }));
    expect(document.documentElement.style.getPropertyValue('--type-scale')).toBe('1.5');
  });

  it('on iOS does not re-read the probe on visibilitychange (it read the old size, 3 of 3)', () => {
    let body = '17px';
    const real = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el instanceof HTMLElement && el.style.cssText.includes('apple-system-body')
        ? ({ fontSize: body } as CSSStyleDeclaration)
        : real(el)
    );
    const dispose = followIosDynamicType(true);
    body = '34px';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.documentElement.style.getPropertyValue('--type-scale')).toBe('1');
    dispose();
  });

  it('starts from the size native already published, for a page loaded after it', () => {
    (window as unknown as Record<string, unknown>).__canariDynamicTypeBodyPx = 34;
    try {
      const dispose = followIosDynamicType(true);
      expect(document.documentElement.style.getPropertyValue('--type-scale')).toBe('2');
      dispose();
    } finally {
      delete (window as unknown as Record<string, unknown>).__canariDynamicTypeBodyPx;
    }
  });

  it('ignores an event that carries no size', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dispose = followIosDynamicType(true);
    const before = document.documentElement.style.getPropertyValue('--type-scale');
    window.dispatchEvent(new CustomEvent(DYNAMIC_TYPE_EVENT, { detail: {} }));
    expect(document.documentElement.style.getPropertyValue('--type-scale')).toBe(before);
    expect(warn).toHaveBeenCalled();
    dispose();
  });

  it('app.html (the pre-paint copy) uses the same default body and cap', () => {
    const html = readFileSync('src/app.html', 'utf8');
    expect(html).toContain(`px / ${IOS_DEFAULT_BODY_PX}`);
    expect(html).toContain(`Math.min(${IOS_TYPE_SCALE_MAX},`);
  });
});

/** Runs app.html's pre-paint Dynamic Type script against fake globals and returns what it published. */
function runPrePaint(opts: { tauri: boolean; ua: string; touch?: number; bodyPx: string }) {
  const html = readFileSync('src/app.html', 'utf8');
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script\s*>/gi)]
    .map((m) => m[1])
    .find((c) => c.includes('apple-system-body'))!;
  const props: Record<string, string> = {};
  const probe = { style: { cssText: '' }, remove: () => {} };
  const fakeDocument = {
    createElement: () => probe,
    documentElement: {
      appendChild: () => {},
      style: { setProperty: (k: string, v: string) => (props[k] = v) },
    },
  };
  new Function('window', 'navigator', 'document', 'getComputedStyle', code)(
    opts.tauri ? { __TAURI_INTERNALS__: {} } : {},
    { userAgent: opts.ua, maxTouchPoints: opts.touch ?? 0 },
    fakeDocument,
    () => ({ fontSize: opts.bodyPx })
  );
  return props;
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

describe('the pre-paint script in app.html', () => {
  it('publishes the scale on a Tauri iPhone', () => {
    expect(runPrePaint({ tauri: true, ua: IPHONE_UA, bodyPx: '25.5px' })).toEqual({
      '--type-scale': '1.5',
    });
  });

  it('recognises an iPad that reports a Macintosh user agent', () => {
    const props = runPrePaint({
      tauri: true,
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      touch: 5,
      bodyPx: '34px',
    });
    expect(props['--type-scale']).toBe('2');
  });

  it('does nothing on Android in Tauri, which would read ~32px at 200 % and scale twice', () => {
    expect(runPrePaint({ tauri: true, ua: ANDROID_UA, bodyPx: '32px' })).toEqual({});
  });

  it('does nothing in a browser, even an iPhone one, and on a touchless Mac', () => {
    expect(runPrePaint({ tauri: false, ua: IPHONE_UA, bodyPx: '25.5px' })).toEqual({});
    expect(
      runPrePaint({ tauri: true, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', bodyPx: '25.5px' })
    ).toEqual({});
  });
});

describe('the root layout', () => {
  it('hands the iOS gate the Tauri iOS runtime answer', () => {
    const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
    expect(layout).toMatch(/const isIosApp = isIosTauriRuntime\(\)/);
    expect(layout).toContain('followIosDynamicType(isIosApp)');
  });
});

describe('the native side (canari_ios.mm)', () => {
  const native = readFileSync('src-tauri/gen/apple/Sources/canari/canari_ios.mm', 'utf8');

  it('dispatches the event and writes the global this module reads', () => {
    expect(native).toContain(`CustomEvent('${DYNAMIC_TYPE_EVENT}'`);
    expect(native).toContain('window.__canariDynamicTypeBodyPx=');
  });

  it('publishes on the change, on every activation and after every page load', () => {
    expect(native).toMatch(
      /UIContentSizeCategoryDidChangeNotification[\s\S]{0,200}CanariPublishDynamicType\(\)/
    );
    const active = native.slice(native.indexOf('static void CanariOnDidBecomeActive'));
    expect(active.slice(0, active.indexOf('\n}\n'))).toContain('CanariPublishDynamicType();');
    const load = native.slice(native.indexOf('@implementation CanariLoadObserver'));
    expect(load.slice(0, load.indexOf('@end'))).toContain('CanariPublishDynamicType();');
  });
});
