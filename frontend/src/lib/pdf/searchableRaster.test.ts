import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rasterizeElementToCanvas, textCalls, textAngles, rasterState, downloads } = vi.hoisted(
  () => ({
    textCalls: [] as string[],
    textAngles: [] as (number | undefined)[],
    rasterState: { markedDuringRaster: null as string | null, hideRule: '' },
    rasterizeElementToCanvas: vi.fn(),
    // The saved file, as the ONE download path sees it. `pdf.save()` is an `<a download>` click,
    // which a WebView drops on the floor - so the assertion below is that this exporter never
    // reaches for it again.
    downloads: [] as { fileName: string; isBlob: boolean }[],
  })
);

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
vi.mock('$lib/utils/fileDownload', () => ({
  downloadDecryptedFile: async (source: string | Blob, fileName: string) => {
    downloads.push({ fileName, isBlob: source instanceof Blob });
  },
}));
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
    save() {
      throw new Error('pdf.save() is dead on mobile - the export must go through fileDownload');
    }
    output() {
      return new Blob(['%PDF'], { type: 'application/pdf' });
    }
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

import { exportSearchablePdf, groupCharsIntoLines, type MeasuredChar } from './searchableRaster';

/** Builds the per-character boxes a browser would report for `text` laid out on the given lines. */
function charsOn(lines: { text: string; top: number; startLeft?: number }[]): MeasuredChar[] {
  const out: MeasuredChar[] = [];
  for (const line of lines) {
    let left = line.startLeft ?? 0;
    for (const ch of line.text) {
      out.push({ ch, rect: { top: line.top, left, right: left + 10, height: 20 } });
      left += 10;
    }
  }
  return out;
}

describe('groupCharsIntoLines - the browser decides where a line breaks', () => {
  // The defect this pipeline exists to prevent: jsPDF re-wrapped in its own metrics and split
  // "Lounes BRIAND--RAVIDAT" as "BRIAND--R / AVIDAT", mid-word, while the preview showed it whole.
  it('keeps each line exactly as it was laid out, breaking no word', () => {
    const lines = groupCharsIntoLines(
      charsOn([
        { text: 'Lounes', top: 0 },
        { text: 'BRIAND--RAVIDAT', top: 20 },
      ])
    );

    expect(lines.map((l) => l.text)).toEqual(['Lounes', 'BRIAND--RAVIDAT']);
  });

  it('starts a new line only on a real vertical step, not on a glyph jitter', () => {
    const chars: MeasuredChar[] = [
      { ch: 'a', rect: { top: 0, left: 0, right: 10, height: 20 } },
      // Sub-pixel drift within one line: a taller glyph, same line.
      { ch: 'b', rect: { top: 0.4, left: 10, right: 20, height: 20 } },
      { ch: 'c', rect: { top: 20, left: 0, right: 10, height: 20 } },
    ];

    expect(groupCharsIntoLines(chars).map((l) => l.text)).toEqual(['ab', 'c']);
  });

  // A space AT a wrap collapses: the browser gives it no box at all. It must not open a line of
  // its own, and it must not survive into the drawn text.
  it('absorbs the collapsed space at a wrap instead of making it a line', () => {
    const chars: MeasuredChar[] = [
      ...charsOn([{ text: 'Jeanne', top: 0 }]),
      { ch: ' ', rect: null },
      ...charsOn([{ text: 'BOUSSONNIERE', top: 20 }]),
    ];

    expect(groupCharsIntoLines(chars).map((l) => l.text)).toEqual(['Jeanne', 'BOUSSONNIERE']);
  });

  // A centred line is anchored on its midpoint, so a trailing space that hangs past the edge would
  // drag every centred line off-centre if it counted.
  it('measures a line across its inked glyphs only, ignoring a trailing space', () => {
    const chars: MeasuredChar[] = [
      ...charsOn([{ text: 'ab', top: 0 }]),
      { ch: ' ', rect: { top: 0, left: 20, right: 30, height: 20 } },
    ];
    const [line] = groupCharsIntoLines(chars);

    expect(line.text).toBe('ab');
    expect(line.right).toBe(20);
  });

  it('reports nothing for text the browser laid out nowhere', () => {
    expect(groupCharsIntoLines([{ ch: 'a', rect: null }])).toEqual([]);
  });
});

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
    downloads.length = 0;
  });

  /*
   * THE EXPORT IS SAVED THE WAY EVERY OTHER FILE IN THIS APP IS SAVED, and nothing else will do.
   * jsPDF's own `save()` builds an object URL and clicks an `<a download>`; Tauri installs no
   * download handler in either WebView, so on Android and iOS that click dispatches, resolves, and
   * produces no file, no error and no console line - which is exactly how the agenda export's
   * button looked broken on a phone (user, 2026-09-29). The fake `save()` above throws, so a
   * regression to it fails here rather than on a device.
   */
  it('hands the PDF to the shared download path instead of jsPDF save()', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    document.body.appendChild(root);

    await exportSearchablePdf(root, {
      filename: 'canari-agenda-2026-10',
      format: 'a4',
      orientation: 'landscape',
      naturalWidth: 1000,
      naturalHeight: 1000,
    });

    expect(downloads).toEqual([{ fileName: 'canari-agenda-2026-10.pdf', isBlob: true }]);
    root.remove();
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

  /**
   * jsdom lays nothing out, so a wrapped run can only be exercised by handing the exporter the
   * boxes a browser would have reported. `layout` is the lines, in order; every character gets a
   * 10x20 box on its line. The node is made tall enough that the exporter treats it as wrapped.
   */
  function withBrowserLayout(layout: string[]): { node: HTMLElement; restore: () => void } {
    const node = document.createElement('span');
    node.dataset.pdfText = 'true';
    node.textContent = layout.join(' ');
    Object.defineProperty(node, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 100, height: 200, right: 100, bottom: 200 }),
    });
    // Character index -> its line and column, following the same joining as the node's text.
    const place = new Map<number, { line: number; col: number }>();
    let index = 0;
    layout.forEach((line, lineIdx) => {
      for (let col = 0; col < line.length; col++) place.set(index++, { line: lineIdx, col });
      if (lineIdx < layout.length - 1) index++; // the space that collapses at the wrap
    });

    const realCreateRange = document.createRange.bind(document);
    let offset = 0;
    document.createRange = () =>
      ({
        setStart: (_n: Node, o: number) => {
          offset = o;
        },
        setEnd: () => {},
        getBoundingClientRect: () => {
          const p = place.get(offset);
          // The collapsed wrap space: the browser reports no box for it at all.
          if (!p) return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
          return {
            top: p.line * 20,
            left: p.col * 10,
            right: p.col * 10 + 10,
            bottom: p.line * 20 + 20,
            width: 10,
            height: 20,
          };
        },
      }) as unknown as Range;

    return { node, restore: () => (document.createRange = realCreateRange) };
  }

  // The defect the pipeline exists to prevent, end to end: jsPDF re-wrapped in its own metrics and
  // printed "BRIAND--R / AVIDAT". Each line must be drawn exactly as the browser broke it.
  it('draws each line the browser produced, and breaks no word itself', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    const { node, restore } = withBrowserLayout(['Lounes BRIAND--', 'RAVIDAT']);
    root.appendChild(node);
    document.body.appendChild(root);

    try {
      await exportSearchablePdf(root, {
        filename: 'test',
        format: 'a4',
        orientation: 'portrait',
        naturalWidth: 1000,
        naturalHeight: 1000,
      });
    } finally {
      restore();
    }

    expect(textCalls).toContain('Lounes BRIAND--');
    expect(textCalls).toContain('RAVIDAT');
    // The whole string drawn as one run would mean jsPDF was left to break it again.
    expect(textCalls).not.toContain('Lounes BRIAND--RAVIDAT');
    root.remove();
  });

  // A measured line's text comes from the DOM text node, which holds the ORIGINAL case, while the
  // glyphs on screen are the transformed ones - so an uppercased run must not be drawn lowercase.
  it('draws an uppercased MEASURED line in upper case', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    const { node, restore } = withBrowserLayout(['jeanne', 'boussonniere']);
    node.style.textTransform = 'uppercase';
    root.appendChild(node);
    document.body.appendChild(root);

    try {
      await exportSearchablePdf(root, {
        filename: 'test',
        format: 'a4',
        orientation: 'portrait',
        naturalWidth: 1000,
        naturalHeight: 1000,
      });
    } finally {
      restore();
    }

    expect(textCalls).toContain('BOUSSONNIERE');
    expect(textCalls).not.toContain('boussonniere');
    root.remove();
  });

  it('draws an uppercased run in upper case', async () => {
    const root = document.createElement('div');
    Object.defineProperty(root, 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    });
    const node = textNode('lundi');
    node.style.textTransform = 'uppercase';
    root.appendChild(node);
    document.body.appendChild(root);

    await exportSearchablePdf(root, {
      filename: 'test',
      format: 'a4',
      orientation: 'portrait',
      naturalWidth: 1000,
      naturalHeight: 1000,
    });

    expect(textCalls).toContain('LUNDI');
    expect(textCalls).not.toContain('lundi');
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
