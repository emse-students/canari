import { FLOOR_VERSION_PATTERN, compareSemver } from './semver';

describe('compareSemver - precedence, pre-releases included', () => {
  it('orders a pre-release below its own stable', () => {
    expect(compareSemver('1.8.3-alpha.1', '1.8.3')).toBe(-1);
    expect(compareSemver('1.8.3', '1.8.3-alpha.9')).toBe(1);
  });

  it('orders alphas numerically, not lexically', () => {
    expect(compareSemver('1.8.3-alpha.2', '1.8.3-alpha.1')).toBe(1);
    expect(compareSemver('1.8.3-alpha.10', '1.8.3-alpha.9')).toBe(1);
    expect(compareSemver('1.8.3-alpha.1', '1.8.3-alpha.1')).toBe(0);
  });

  it('lets the core decide before any pre-release', () => {
    expect(compareSemver('1.8.4-alpha.1', '1.8.3')).toBe(1);
    expect(compareSemver('1.8.2', '1.8.3-alpha.1')).toBe(-1);
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1);
  });
});

describe('FLOOR_VERSION_PATTERN', () => {
  it('matches a stable and an alpha only', () => {
    expect(FLOOR_VERSION_PATTERN.test('1.8.3')).toBe(true);
    expect(FLOOR_VERSION_PATTERN.test('1.8.3-alpha.1')).toBe(true);
    expect(FLOOR_VERSION_PATTERN.test('1.8.3-alpha')).toBe(false);
  });
});

describe('compareSemver - edges', () => {
  it('ranks a bare alpha below alpha.1', () => {
    expect(compareSemver('1.8.3-alpha', '1.8.3-alpha.1')).toBe(-1);
  });

  it('pads a short core with zeros', () => {
    expect(compareSemver('1.8', '1.8.0')).toBe(0);
  });

  it('strips build metadata', () => {
    expect(compareSemver('1.8.3+abc', '1.8.3')).toBe(0);
  });
});
