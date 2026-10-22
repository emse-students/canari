import { describe, expect, it } from 'vitest';
import { imageSrcOrNull } from './imageSrc';

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

  it('drops null and undefined', () => {
    expect(imageSrcOrNull(null)).toBeNull();
    expect(imageSrcOrNull(undefined)).toBeNull();
  });
});
