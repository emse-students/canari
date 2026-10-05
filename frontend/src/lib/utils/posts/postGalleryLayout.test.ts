import { describe, expect, it } from 'vitest';
import { POST_GALLERY_MAX_CELLS, postGalleryLayout } from './postGalleryLayout';

describe('postGalleryLayout', () => {
  it('draws nothing for no media, and treats a bad count as none', () => {
    for (const count of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(postGalleryLayout(count)).toEqual({ shape: 'none', visible: 0, overflow: 0 });
    }
  });

  it('keeps a lone picture at its own shape', () => {
    expect(postGalleryLayout(1)).toEqual({ shape: 'single', visible: 1, overflow: 0 });
  });

  it('lays two, three and four media out without hiding any', () => {
    expect(postGalleryLayout(2)).toEqual({ shape: 'pair', visible: 2, overflow: 0 });
    expect(postGalleryLayout(3)).toEqual({ shape: 'feature', visible: 3, overflow: 0 });
    expect(postGalleryLayout(4)).toEqual({ shape: 'quad', visible: 4, overflow: 0 });
  });

  it('caps the grid at four cells and counts the rest as the overflow', () => {
    expect(postGalleryLayout(5)).toEqual({ shape: 'quad', visible: 4, overflow: 1 });
    expect(postGalleryLayout(9)).toEqual({
      shape: 'quad',
      visible: POST_GALLERY_MAX_CELLS,
      overflow: 5,
    });
  });

  it('floors a fractional count', () => {
    expect(postGalleryLayout(5.9)).toEqual({ shape: 'quad', visible: 4, overflow: 1 });
  });
});
