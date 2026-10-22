import { describe, expect, it, vi } from 'vitest';
import { imageSrcOrNull } from './imageSrc';
import { Log } from './Log';

describe('imageSrcOrNull', () => {
  it.each([
    '/api/media/public/m-1?v=3',
    'https://example.org/logo.png',
    'http://example.org/logo.png',
  ])('keeps %s', (value) => {
    expect(imageSrcOrNull(value)).toBe(value);
  });

  it('trims surrounding whitespace', () => {
    expect(imageSrcOrNull('  /api/media/public/m-1  ')).toBe('/api/media/public/m-1');
  });

  it.each([
    'javascript:alert(1)',
    ' JaVaScRiPt:alert(1)',
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'vbscript:x',
    '//example.org/logo.png',
    'logo.png',
    '',
    '   ',
  ])('drops %s', (value) => {
    expect(imageSrcOrNull(value)).toBeNull();
  });

  it('says so through the project logger, without printing the value', () => {
    const info = vi.spyOn(Log, 'i').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(imageSrcOrNull('javascript:alert(1)')).toBeNull();
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toBe('imageSrc');
      expect(String(info.mock.calls[0][1])).not.toContain('javascript');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it('drops null and undefined', () => {
    expect(imageSrcOrNull(null)).toBeNull();
    expect(imageSrcOrNull(undefined)).toBeNull();
  });
});
