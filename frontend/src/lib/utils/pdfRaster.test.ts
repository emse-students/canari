import { beforeEach, describe, expect, it, vi } from 'vitest';

const toCanvas = vi.fn(async (_el: HTMLElement, _opts: unknown) => ({}) as HTMLCanvasElement);

vi.mock('@zumer/snapdom', () => ({
  snapdom: { toCanvas: (el: HTMLElement, opts: unknown) => toCanvas(el, opts) },
}));

import { rasterizeElementToCanvas } from './pdfRaster';

/** happy-dom has no font loading; the rasteriser only ever awaits these two. */
function stubFonts(): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve(), load: vi.fn(async () => []) },
  });
}

/** An `<img>` that has not settled yet, so the rasteriser must wait for an event. */
function pendingImage(src: string): HTMLImageElement {
  const img = document.createElement('img');
  img.src = src;
  Object.defineProperty(img, 'complete', { configurable: true, value: false });
  return img;
}

describe('rasterizeElementToCanvas', () => {
  beforeEach(() => {
    toCanvas.mockClear();
    stubFonts();
  });

  it('turns snapdom placeholders off, so an image it cannot inline never draws the word "img"', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    await rasterizeElementToCanvas(el);

    expect(toCanvas).toHaveBeenCalledTimes(1);
    expect(toCanvas.mock.calls[0][1]).toMatchObject({ placeholders: false });
    el.remove();
  });

  it("keeps the call site's own error handler - waiting for an image must not replace it", async () => {
    const el = document.createElement('div');
    const img = pendingImage('/api/users/u1/avatar');
    el.appendChild(img);
    document.body.appendChild(el);

    // The trombinoscope installs exactly this: an inline `onerror` that reveals the initials layer.
    const siteHandler = vi.fn(() => img.remove());
    img.onerror = siteHandler;

    const pending = rasterizeElementToCanvas(el);
    img.dispatchEvent(new Event('error'));
    await pending;

    expect(siteHandler).toHaveBeenCalledTimes(1);
    expect(toCanvas).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it('names an image left in the tree with no pixels, and stays silent about one the call site dropped', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const el = document.createElement('div');
    const kept = pendingImage('/api/associations/a1/logo');
    const dropped = pendingImage('/api/users/u1/avatar');
    dropped.onerror = () => dropped.remove();
    el.append(kept, dropped);
    document.body.appendChild(el);

    const pending = rasterizeElementToCanvas(el);
    kept.dispatchEvent(new Event('error'));
    dropped.dispatchEvent(new Event('error'));
    await pending;

    const reported = debug.mock.calls.filter(([tag]) =>
      String(tag).includes('pdfRaster:missingImages')
    );
    expect(reported).toHaveLength(1);
    expect(reported[0][1]).toMatchObject({ count: 1, srcs: [kept.src] });

    debug.mockRestore();
    el.remove();
  });
});
