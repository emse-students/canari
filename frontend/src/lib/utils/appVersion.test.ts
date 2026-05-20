import { describe, expect, it } from 'vitest';
import { compareSemver, getClientAppVersion, getReleasePageUrl } from './appVersion';

describe('compareSemver', () => {
  it('orders versions correctly', () => {
    expect(compareSemver('0.3.4', '0.3.5')).toBeLessThan(0);
    expect(compareSemver('0.3.5', '0.3.5')).toBe(0);
    expect(compareSemver('1.0.0', '0.9.9')).toBeGreaterThan(0);
  });
});

describe('getClientAppVersion', () => {
  it('returns a non-empty semver string', () => {
    expect(getClientAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('getReleasePageUrl', () => {
  it('builds a tag URL for semver', () => {
    expect(getReleasePageUrl('0.3.6')).toBe(
      'https://github.com/emse-students/canari/releases/tag/v0.3.6'
    );
  });

  it('accepts a leading v', () => {
    expect(getReleasePageUrl('v1.0.0')).toBe(
      'https://github.com/emse-students/canari/releases/tag/v1.0.0'
    );
  });

  it('falls back to latest when version is missing', () => {
    expect(getReleasePageUrl(null)).toBe('https://github.com/emse-students/canari/releases/latest');
  });
});
