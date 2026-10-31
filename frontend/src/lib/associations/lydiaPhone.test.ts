import { describe, expect, it } from 'vitest';
import { toE164Phone } from './lydiaPhone';

describe('toE164Phone', () => {
  it('converts French national formats', () => {
    expect(toE164Phone('06 12 34 56 78')).toBe('+33612345678');
    expect(toE164Phone('06.12.34.56.78')).toBe('+33612345678');
    expect(toE164Phone('06-12-34-56-78')).toBe('+33612345678');
  });
  it('keeps E.164, tolerating separators', () => {
    expect(toE164Phone('+33612345678')).toBe('+33612345678');
    expect(toE164Phone('+33 6 12 34 56 78')).toBe('+33612345678');
  });
  it('rejects anything else', () => {
    for (const bad of [
      '',
      'abc',
      '0612',
      '06123456789',
      '+123',
      '+1234567890123456',
      '33612345678',
    ])
      expect(toE164Phone(bad)).toBeNull();
  });
});
