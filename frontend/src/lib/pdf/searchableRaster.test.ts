import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rasterizeElementToCanvas, textCalls, textAngles, rasterState } = vi.hoisted(() => ({
  textCalls: [] as string[],
  textAngles: [] as (number | undefined)[],
  rasterState: { markedDuringRaster: null as string | null, hideRule: '' },
  rasterizeElementToCanvas: vi.fn(),
}));

rasterizeElementToCanvas.mockImplementation(async (el: HTMLElement) => {
  // Captured at raster time: proves the emoji node is exempt from the hide rule right when the
  // background is actually painted, not merely before or after.
  rasterState.markedDuringRaster =
    el.querySelector('[data-pdf-text-raster-only]')?.textContent ?? null;
  rasterState.hideRule = Array.from(document.head.querySelectorAll('style'))
    .map((st) => st.textContent ?? '')
    .join('');
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
    getTextWidth(text: string) {
      return text.length;
    }
    text(lines: string | string[], _x: number, _y: number, opts?: { angle?: number }) {
      const all = typeof lines === 'string' ? [lines] : lines;
      textCalls.push(...all);
      textAngles.push(...all.map(() => opts?.angle));
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
    textAngles.length = 0;
    rasterState.markedDuringRaster = null;
    rasterState.hideRule = '';
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

  // Since 2026-09-25 an export's emoji is a PICTURE (`emojiHtml`), absent from `textContent`: the
  // node reads as plain text, and hiding it for the vector pass would hide its picture with it.
  it('keeps a node holding an emoji PICTURE in the raster, not as vector text', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    const pictureNode = textNode('titre ');
    const img = document.createElement('img');
    img.className = 'emoji';
    img.alt = '🎉';
    pictureNode.appendChild(img);
    root.appendChild(pictureNode);
    document.body.appendChild(root);

    await exportSearchablePdf(root, {
      filename: 'test',
      format: 'a4',
      orientation: 'portrait',
      naturalWidth: 1000,
      naturalHeight: 1000,
    });

    expect(rasterState.markedDuringRaster).toBe('titre ');
    expect(textCalls).not.toContain('titre');
    root.remove();
  });

  // The calendar sheet's display text carries a hard-offset text-shadow that IS its design: the
  // raster keeps it and only the glyph fill goes (2026-09-27).
  it('hides the glyph fill for the raster pass but keeps the text shadow', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    root.appendChild(textNode('Octobre'));
    document.body.appendChild(root);

    await exportSearchablePdf(root, {
      filename: 'test',
      format: 'a4',
      orientation: 'portrait',
      naturalWidth: 1000,
      naturalHeight: 1000,
    });

    expect(rasterState.hideRule).toContain('color: rgba(0,0,0,0)');
    expect(rasterState.hideRule).not.toContain('text-shadow');
    root.remove();
  });

  // The break stamp is written at -20deg in CSS; drawn flat, it sat level over its own tilted shadow.
  it('draws a rotated run at its CSS angle, counter-clockwise as jsPDF counts it', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    const stamp = textNode('Vacances');
    const rad = (-20 * Math.PI) / 180;
    stamp.style.transform = `matrix(${Math.cos(rad)}, ${Math.sin(rad)}, ${-Math.sin(rad)}, ${Math.cos(rad)}, 0, 0)`;
    root.append(stamp, textNode('Lundi'));
    document.body.appendChild(root);

    await exportSearchablePdf(root, {
      filename: 'test',
      format: 'a4',
      orientation: 'portrait',
      naturalWidth: 1000,
      naturalHeight: 1000,
    });

    expect(textAngles[textCalls.indexOf('Vacances')]).toBeCloseTo(20);
    expect(textAngles[textCalls.indexOf('Lundi')]).toBeUndefined();
    root.remove();
  });
});
