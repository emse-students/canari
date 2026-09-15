import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rasterizeElementToCanvas, textCalls, rasterState } = vi.hoisted(() => ({
  textCalls: [] as string[],
  rasterState: { markedDuringRaster: null as string | null },
  rasterizeElementToCanvas: vi.fn(),
}));

rasterizeElementToCanvas.mockImplementation(async (el: HTMLElement) => {
  // Captured at raster time: proves the emoji node is exempt from the hide rule right when the
  // background is actually painted, not merely before or after.
  rasterState.markedDuringRaster =
    el.querySelector('[data-pdf-text-raster-only]')?.textContent ?? null;
  return {
    width: 100,
    height: 100,
    toDataURL: () => 'data:image/jpeg;base64,x',
  } as unknown as HTMLCanvasElement;
});

vi.mock('$lib/utils/pdfRaster', () => ({ rasterizeElementToCanvas }));
vi.mock('./appFonts', () => ({
  registerAppFonts: vi.fn(async () => {}),
  pickAppFont: vi.fn(() => null),
}));

vi.mock('jspdf', () => ({
  default: class FakeJsPDF {
    internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
    setFont() {}
    setFontSize() {}
    setTextColor() {}
    addImage() {}
    addPage() {}
    save() {}
    splitTextToSize(text: string) {
      return [text];
    }
    text(lines: string[]) {
      textCalls.push(...lines);
    }
  },
}));

import { exportSearchablePdf } from './searchableRaster';

function textNode(text: string): HTMLElement {
  const span = document.createElement('span');
  span.dataset.pdfText = 'true';
  span.textContent = text;
  Object.defineProperty(span, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20 }),
  });
  return span;
}

describe('exportSearchablePdf - emoji nodes are rasterized, not vector-drawn', () => {
  beforeEach(() => {
    textCalls.length = 0;
    rasterState.markedDuringRaster = null;
  });

  it('marks an emoji node as raster-only during the raster pass, then clears the marker', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    const emojiNode = textNode('🎉 titre');
    root.appendChild(emojiNode);
    document.body.appendChild(root);

    await exportSearchablePdf(root, {
      filename: 'test',
      format: 'a4',
      orientation: 'portrait',
      naturalWidth: 1000,
      naturalHeight: 1000,
    });

    expect(rasterState.markedDuringRaster).toBe('🎉 titre');
    expect(emojiNode.dataset.pdfTextRasterOnly).toBeUndefined();
    root.remove();
  });

  it('does not draw vector text for an emoji node, but does for a plain one', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    const emojiNode = textNode('🎉 titre');
    const plainNode = textNode('sous-titre');
    root.append(emojiNode, plainNode);
    document.body.appendChild(root);

    await exportSearchablePdf(root, {
      filename: 'test',
      format: 'a4',
      orientation: 'portrait',
      naturalWidth: 1000,
      naturalHeight: 1000,
    });

    expect(textCalls).not.toContain('🎉 titre');
    expect(textCalls).toContain('sous-titre');
    root.remove();
  });
});
