import {
  DEFAULT_MEDIA_ASPECT,
  mediaAspectStyle,
  normalizedAspectRatio,
  resolveMediaType,
  reservesAspectRatio,
} from './mediaLayout';

describe('mediaLayout', () => {
  it('uses fallback when dimensions are missing', () => {
    expect(normalizedAspectRatio(undefined, undefined)).toBe(DEFAULT_MEDIA_ASPECT);
    expect(mediaAspectStyle()).toBe(`aspect-ratio: ${DEFAULT_MEDIA_ASPECT}`);
  });

  it('computes ratio from width and height', () => {
    expect(normalizedAspectRatio(800, 600)).toBeCloseTo(4 / 3);
    expect(mediaAspectStyle(800, 600)).toBe('aspect-ratio: 1.3333333333333333');
  });

  it('clamps extreme ratios', () => {
    expect(normalizedAspectRatio(100, 1000)).toBe(0.25);
    expect(normalizedAspectRatio(4000, 100)).toBe(4);
  });

  describe('resolveMediaType', () => {
    it('trusts the explicit type over the mime type', () => {
      expect(resolveMediaType({ type: 'file', mimeType: 'image/png' })).toBe('file');
    });

    it('falls back to the mime type for legacy media carrying none', () => {
      expect(resolveMediaType({ mimeType: 'image/jpeg' })).toBe('image');
      expect(resolveMediaType({ mimeType: 'video/mp4' })).toBe('video');
      expect(resolveMediaType({ mimeType: 'audio/ogg' })).toBe('audio');
    });

    it('calls anything else a file - a PDF has no shape to display', () => {
      expect(resolveMediaType({ mimeType: 'application/pdf' })).toBe('file');
      expect(resolveMediaType({ mimeType: '' })).toBe('file');
    });
  });

  describe('reservesAspectRatio', () => {
    it('reserves a box only for picture-shaped media', () => {
      expect(reservesAspectRatio('image')).toBe(true);
      expect(reservesAspectRatio('video')).toBe(true);
    });

    it('reserves nothing for a self-sizing card, which would strand it in empty space', () => {
      expect(reservesAspectRatio('file')).toBe(false);
      expect(reservesAspectRatio('audio')).toBe(false);
    });
  });
});
