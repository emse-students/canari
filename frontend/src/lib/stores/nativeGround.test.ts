// @vitest-environment happy-dom
import { vi } from 'vitest';

/**
 * A GROUND POSTED FOR ONE SURFACE OUTLIVES IT (owner's Pixel 6a, 2026-11-26): a conversation's grey,
 * posted on a keyboard rise, stayed under the feed's white tab bar. The ground is re-read on each
 * change of the bottom surface and follows it; an unchanged colour is not sent again.
 */
vi.mock('./imeGround', async (importOriginal) => {
  const real = await importOriginal<typeof import('./imeGround')>();
  return {
    ...real,
    // happy-dom has no canvas: the engine's conversion is replaced by an rgb() reader.
    cssColorToHex: (css: string): string | null => {
      const m = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(css);
      if (!m || (m[4] !== undefined && Number(m[4]) !== 1)) return null;
      return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
    },
  };
});

import { forgetPostedGroundForTest, syncNativeGround } from './nativeGround';

const GREY = 'rgb(240, 242, 245)';
const WHITE = 'rgb(255, 255, 255)';
const DARK = 'rgb(24, 25, 26)';

let setGround: ReturnType<typeof vi.fn>;

/** Puts `background` at the bottom edge: the element the bottom row's hit test returns. */
function bottomSurface(background: string): HTMLElement {
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.style.backgroundColor = background;
  document.body.appendChild(el);
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(el);
  return el;
}

beforeEach(() => {
  forgetPostedGroundForTest();
  setGround = vi.fn();
  (window as unknown as { canariTheme: unknown }).canariTheme = { setGround };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { canariTheme?: unknown }).canariTheme;
});

describe('syncNativeGround', () => {
  it("follows a route change from a conversation's grey to the feed's tab bar", () => {
    bottomSurface(GREY);
    syncNativeGround('keyboard-rise');
    bottomSurface(WHITE);
    syncNativeGround('navigation');
    expect(setGround.mock.calls).toEqual([['#f0f2f5'], ['#ffffff']]);
  });

  it('follows a theme switch on the same surface', () => {
    const bar = bottomSurface(WHITE);
    syncNativeGround('bottom-bar');
    bar.style.backgroundColor = DARK;
    syncNativeGround('theme');
    expect(setGround.mock.calls).toEqual([['#ffffff'], ['#18191a']]);
  });

  it('does not send a repeat of the colour last posted', () => {
    bottomSurface(WHITE);
    syncNativeGround('navigation');
    syncNativeGround('theme');
    syncNativeGround('bottom-bar');
    expect(setGround).toHaveBeenCalledTimes(1);
  });

  it('keeps the native ground when nothing at the bottom edge is opaque', () => {
    bottomSurface(WHITE);
    syncNativeGround('navigation');
    bottomSurface('rgba(0, 0, 0, 0)');
    syncNativeGround('navigation');
    expect(setGround.mock.calls).toEqual([['#ffffff']]);
  });

  it('is a no-op without the Android bridge (browser, iOS)', () => {
    delete (window as unknown as { canariTheme?: unknown }).canariTheme;
    const hit = vi.spyOn(document, 'elementFromPoint');
    syncNativeGround('navigation');
    expect(hit).not.toHaveBeenCalled();
  });
});
