import { describe, expect, it, vi } from 'vitest';
import { renderEditedReelMedia, type ReelEdits } from './reelEditor';

describe('renderEditedReelMedia', () => {
  it('renders a decorated image to WebP with its source dimensions', async () => {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'width', { value: 120, writable: true });
    Object.defineProperty(canvas, 'height', { value: 80, writable: true });
    vi.spyOn(document, 'createElement').mockImplementation((name) => {
      if (name === 'canvas') return canvas;
      return document.createElementNS('http://www.w3.org/1999/xhtml', name) as never;
    });
    vi.spyOn(canvas, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, 'toBlob').mockImplementation((callback) =>
      callback(new Blob(['edited'], { type: 'image/webp' }))
    );
    const image = { naturalWidth: 120, naturalHeight: 80 } as HTMLImageElement;
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = image.naturalWidth;
        naturalHeight = image.naturalHeight;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          this.onload?.();
        }
      }
    );
    const edits: ReelEdits = { strokes: [], texts: [] };
    const result = await renderEditedReelMedia(new Blob(['source'], { type: 'image/jpeg' }), edits);
    expect(result.width).toBe(120);
    expect(result.height).toBe(80);
    expect(result.blob.type).toBe('image/webp');
  });
});
