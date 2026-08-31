import { describe, it, expect } from 'vitest';
import { formatTabTitle, formatUnreadCount, TAB_COUNT_CAP } from './tabTitle';

/**
 * The tab's title, and the one property that keeps it from drifting: it is DERIVED, never edited.
 *
 * The web had exactly one out-of-page unread signal until 2026-08-31 and it needed a permission the
 * browser spends the first message asking for. This is the one that asks nobody, so the thing worth
 * pinning is that applying it repeatedly - which a reactive effect does - says the same thing every
 * time and leaves nothing behind when the count reaches zero.
 */
describe('formatTabTitle', () => {
  const BASE = 'Communautes - Canari';

  it('leaves the page title alone when there is nothing to announce', () => {
    expect(formatTabTitle(BASE, 0, false)).toBe(BASE);
  });

  it('prefixes the count when messages are waiting', () => {
    expect(formatTabTitle(BASE, 3, false)).toBe(`(3) ${BASE}`);
  });

  /** THE FAILURE MODE OF PREPENDING IN PLACE, which is why this takes a base and returns a whole. */
  it('is idempotent on its own output being recomputed from the same base', () => {
    const once = formatTabTitle(BASE, 3, false);
    expect(formatTabTitle(BASE, 3, false)).toBe(once);
    expect(formatTabTitle(BASE, 0, false)).toBe(BASE);
  });

  it('collapses a count no tab strip could show', () => {
    expect(formatTabTitle(BASE, TAB_COUNT_CAP, false)).toBe(`(99) ${BASE}`);
    expect(formatTabTitle(BASE, TAB_COUNT_CAP + 1, false)).toBe(`(99+) ${BASE}`);
    expect(formatUnreadCount(4000)).toBe('99+');
  });

  /** A call is answered in seconds and unread messages are not, so it takes the tab while it rings. */
  it('lets a ringing call outrank the count', () => {
    expect(formatTabTitle(BASE, 12, true)).toBe(`\u{1F514} ${BASE}`);
    expect(formatTabTitle(BASE, 0, true)).toBe(`\u{1F514} ${BASE}`);
  });

  /** A count that is not a count says nothing, rather than `(NaN)`. */
  it('says nothing for a value that is not a positive number', () => {
    expect(formatTabTitle(BASE, Number.NaN, false)).toBe(BASE);
    expect(formatTabTitle(BASE, -1, false)).toBe(BASE);
    expect(formatTabTitle(BASE, Number.POSITIVE_INFINITY, false)).toBe(BASE);
  });
});
