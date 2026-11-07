import { describe, it, expect } from 'vitest';
import { pageScrollPaddingClass } from './pageScrollPadding';

describe('pageScrollPaddingClass', () => {
  it('reserves the bottom navigation only where the page has one', () => {
    expect(pageScrollPaddingClass(true)).toBe('pb-(--bottom-nav-reserve) md:pb-0');
    // No chrome (guest form, login, legal): a reserve would park a sticky bar above the bottom.
    expect(pageScrollPaddingClass(false)).toBe('');
  });
});
