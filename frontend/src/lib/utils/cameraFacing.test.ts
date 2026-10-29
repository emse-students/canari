import { afterEach, describe, expect, it, vi } from 'vitest';
import { facingConstraint, lensIsExact } from './cameraFacing';
import { callVideoConstraints } from './callVideo';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('facingConstraint', () => {
  it('is IDEAL for a first capture and EXACT for an explicit switch', () => {
    expect(facingConstraint('user', false)).toEqual({ ideal: 'user' });
    expect(facingConstraint('environment', true)).toEqual({ exact: 'environment' });
  });
});

describe('callVideoConstraints', () => {
  it('shares the builder: ideal by default, exact on a switch', () => {
    expect(callVideoConstraints('user').facingMode).toEqual({ ideal: 'user' });
    expect(callVideoConstraints('environment', true).facingMode).toEqual({ exact: 'environment' });
  });
});

describe('lensIsExact', () => {
  it('is exact on a switch whatever the device', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(lensIsExact(true)).toBe(true);
  });

  it('is exact on a phone (coarse pointer) and ideal on a desktop first capture', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(lensIsExact(false)).toBe(true);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(lensIsExact(false)).toBe(false);
  });

  it('is ideal when the pointer cannot be asked', () => {
    vi.stubGlobal('window', undefined);
    expect(lensIsExact(false)).toBe(false);
  });
});
