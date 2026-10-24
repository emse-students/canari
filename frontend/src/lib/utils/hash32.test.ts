import { mixedHash32 } from './hash32';

/**
 * `mixedHash32` is part of a protocol - two devices slicing a history (`historyRangeOf`) must agree
 * - so its values are pinned. They were computed by the implementation `historyRangeOf` carried
 * inline before it was extracted, so a change here is a change of the wire, never a refactor.
 */
describe('mixedHash32', () => {
  it.each([
    ['', 0xab3e7c0b],
    ['a', 0x1a80b1b3],
    ['msg-1', 0x18a9a900],
    ['0b6f2c1e-5d0e-4c43-9a51-6f7f0f1b2c3d', 0x912ee239],
  ])('hashes %j to its pinned value', (text, expected) => {
    expect(mixedHash32(text)).toBe(expected);
  });

  it('is an unsigned 32-bit integer', () => {
    const h = mixedHash32('anything');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });
});
