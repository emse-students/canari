/**
 * `--text-zoom` is the factor by which FONT sizes outgrow LENGTHS - 2 on Android's WebView at a 200 %
 * system text size, 1 on a desktop whose default font was raised (both grow together there).
 * jsdom lays nothing out, so the two measurements are stubbed.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { publishTextZoom } from './textZoom';

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
