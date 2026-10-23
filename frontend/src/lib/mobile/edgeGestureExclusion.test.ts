// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearEdgeExclusionsForNewDocument,
  excludeLeftEdgeOver,
  excludeRightEdgeOver,
  wantsFeedLeftEdgeExclusion,
} from './edgeGestureExclusion';

function makeList(top: number, bottom: number, paddingBottom: string): HTMLElement {
  const el = document.createElement('div');
  el.style.paddingBottom = paddingBottom;
  document.body.appendChild(el);
  el.getBoundingClientRect = () => ({ top, bottom }) as DOMRect;
  return el;
}

function install() {
  const bridge = {
    setRightBand: vi.fn(),
    clearRightBand: vi.fn(),
    setLeftBand: vi.fn(),
    clearLeftBand: vi.fn(),
  };
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

  it('reports the feed on the LEFT edge, bottom bar padding removed, and only there', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    // The Mi 9T's WebView scale: 74 physical px is the 30 CSS px band the system took as Back.
    Object.defineProperty(window, 'devicePixelRatio', { value: 2.475, configurable: true });
    const bridge = install();
    const cleanup = excludeLeftEdgeOver(makeList(100, 900, '80px'));
    expect(bridge.setLeftBand).toHaveBeenCalledWith(248, 2030);
    expect(bridge.setRightBand).not.toHaveBeenCalled();
    cleanup();
    expect(bridge.clearLeftBand).toHaveBeenCalledTimes(1);
    expect(bridge.clearRightBand).not.toHaveBeenCalled();
  });

  it('calls the bridge methods on the bridge, as an injected Android interface requires', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    const receivers: unknown[] = [];
    const bridge = {
      setLeftBand(this: unknown) {
        receivers.push(this);
      },
      clearLeftBand(this: unknown) {
        receivers.push(this);
      },
    };
    (window as unknown as { canariGestures?: unknown }).canariGestures = bridge;
    excludeLeftEdgeOver(makeList(0, 500, '0px'))();
    expect(receivers).toEqual([bridge, bridge]);
  });

  it('clears both edges for a new document, and does nothing without a bridge', () => {
    const bridge = install();
    clearEdgeExclusionsForNewDocument();
    expect(bridge.clearLeftBand).toHaveBeenCalledTimes(1);
    expect(bridge.clearRightBand).toHaveBeenCalledTimes(1);
    delete (window as unknown as { canariGestures?: unknown }).canariGestures;
    expect(() => clearEdgeExclusionsForNewDocument()).not.toThrow();
  });
});

describe('wantsFeedLeftEdgeExclusion', () => {
  it('holds on the feed while its swipe to the camera can happen', () => {
    expect(wantsFeedLeftEdgeExclusion('/posts', true, false, false)).toBe(true);
  });

  it('never holds elsewhere, so the left-edge Back keeps working there', () => {
    for (const path of [
      '/posts/abc',
      '/camera',
      '/chat',
      '/communities',
      '/calendar',
      '/settings',
    ]) {
      expect(wantsFeedLeftEdgeExclusion(path, true, false, false)).toBe(false);
    }
  });

  it('stands down when the swipe cannot happen: not armed, or the keyboard up', () => {
    expect(wantsFeedLeftEdgeExclusion('/posts', false, false, false)).toBe(false);
    expect(wantsFeedLeftEdgeExclusion('/posts', true, true, false)).toBe(false);
  });

  it('stands down under a full-screen overlay, whose Back must close it', () => {
    // A reel viewer, a media viewer, a modal or the composer's camera over the feed.
    expect(wantsFeedLeftEdgeExclusion('/posts', true, false, true)).toBe(false);
  });
});
