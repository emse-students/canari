// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { excludeRightEdgeOver } from './edgeGestureExclusion';

function makeList(top: number, bottom: number, paddingBottom: string): HTMLElement {
  const el = document.createElement('div');
  el.style.paddingBottom = paddingBottom;
  document.body.appendChild(el);
  el.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
  return el;
}

function install() {
  const bridge = { setRightBand: vi.fn(), clearRightBand: vi.fn() };
  (window as unknown as { canariGestures?: unknown }).canariGestures = bridge;
  return bridge;
}

describe('excludeRightEdgeOver', () => {
  afterEach(() => {
    delete (window as unknown as { canariGestures?: unknown }).canariGestures;
    vi.unstubAllGlobals();
  });

  it('reports the bubbles span, composer padding removed, in physical px', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const bridge = install();
    excludeRightEdgeOver(makeList(100, 800, '120px'));
    expect(bridge.setRightBand).toHaveBeenCalledWith(200, 1360);
  });

  it('clears on cleanup and does nothing without a bridge', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    const bridge = install();
    excludeRightEdgeOver(makeList(0, 500, '0px'))();
    expect(bridge.clearRightBand).toHaveBeenCalledTimes(1);

    delete (window as unknown as { canariGestures?: unknown }).canariGestures;
    expect(() => excludeRightEdgeOver(makeList(0, 500, '0px'))()).not.toThrow();
    expect(bridge.setRightBand).toHaveBeenCalledTimes(1);
  });
});
