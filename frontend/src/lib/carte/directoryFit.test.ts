import { describe, expect, it } from 'vitest';
import { fitDirectoryFont, type FittableDirectory } from './directoryFit';
import { DIRECTORY_BASE_FONT } from './layout';

/**
 * A stand-in for the two boxes, whose content height follows the font size the way a real column's
 * does: `perPx` px of text for every px of font.
 */
function column(bodyHeight: number, perPx: number) {
  const content = {
    style: { fontSize: '' },
    get scrollHeight(): number {
      return Number.parseFloat(content.style.fontSize) * perPx;
    },
    clientHeight: 0,
  };
  const body: FittableDirectory = {
    clientHeight: bodyHeight,
    scrollHeight: 0,
    style: { fontSize: '' },
  };
  return { body, content: content as FittableDirectory };
}

describe('fitDirectoryFont - the roster fits its column, or the fit stops at the floor', () => {
  it('leaves a roster that already fits at the base size', () => {
    const { body, content } = column(DIRECTORY_BASE_FONT * 100, 1);
    expect(fitDirectoryFont(body, content)).toBe(DIRECTORY_BASE_FONT);
  });

  it('steps down until the list fits', () => {
    // Fits at 8 px and not at 8.5.
    const { body, content } = column(8 * 70, 70);
    expect(fitDirectoryFont(body, content)).toBe(8);
  });

  it('stops at half the base rather than shrinking for ever', () => {
    const { body, content } = column(1, 1000);
    expect(fitDirectoryFont(body, content)).toBe(DIRECTORY_BASE_FONT * 0.5);
  });

  // The export calls it after the component's own animation frame may already have run it, so a
  // second call has to answer the same thing rather than compounding the first.
  it('is idempotent', () => {
    const { body, content } = column(8 * 70, 70);
    expect(fitDirectoryFont(body, content)).toBe(fitDirectoryFont(body, content));
  });

  it('writes the size it settled on', () => {
    const { body, content } = column(8 * 70, 70);
    const font = fitDirectoryFont(body, content);
    expect(content.style.fontSize).toBe(`${font}px`);
  });
});
