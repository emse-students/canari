import { appVersionAtLeast } from './app-version';

describe('appVersionAtLeast', () => {
  it('compares the three numbers, not the strings', () => {
    expect(appVersionAtLeast('1.5.4', '1.5.4')).toBe(true);
    expect(appVersionAtLeast('1.10.0', '1.5.4')).toBe(true);
    expect(appVersionAtLeast('1.5.3', '1.5.4')).toBe(false);
    expect(appVersionAtLeast('0.99.99', '1.5.4')).toBe(false);
  });

  it('ignores a pre-release suffix', () => {
    expect(appVersionAtLeast('1.5.4-alpha.2', '1.5.4')).toBe(true);
    expect(appVersionAtLeast('1.5.3-alpha.9', '1.5.4')).toBe(false);
  });

  it('answers null when the build is unknown or unreadable', () => {
    expect(appVersionAtLeast(null, '1.5.4')).toBeNull();
    expect(appVersionAtLeast(undefined, '1.5.4')).toBeNull();
    expect(appVersionAtLeast('abc', '1.5.4')).toBeNull();
  });
});
