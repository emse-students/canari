/** The feed's tab row brings the selected tab into full view (Mi 9T, v1.2.9-alpha.4, 2x text). */
import { describe, expect, it } from 'vitest';
import { centredTabScrollLeft } from './feedTabScroll';

// The 2x-text row of the reading: a 300 px scroller over 420 px of tabs.
const row = { left: 16, width: 300 };
const MAX = 120;

describe('centredTabScrollLeft', () => {
  it('scrolls the last tab (then "Tout") flush with the end, out from under the fade', () => {
    // It spans 300-420 in the content, so its left is 316 on screen at scrollLeft 0.
    expect(centredTabScrollLeft(row, { left: 316, width: 120 }, 0, MAX)).toBe(MAX);
  });

  it('scrolls the first tab back to the start', () => {
    expect(centredTabScrollLeft(row, { left: 16 - MAX, width: 150 }, MAX, MAX)).toBe(0);
  });

  it('centres a middle tab, measured from wherever the row is scrolled', () => {
    // A tab at 160-260 in the content: centre 210, row centre 150.
    expect(centredTabScrollLeft(row, { left: 16 + 160 - 40, width: 100 }, 40, MAX)).toBe(60);
  });

  it('leaves a row that does not overflow at 0', () => {
    expect(centredTabScrollLeft(row, { left: 200, width: 100 }, 0, 0)).toBe(0);
  });
});
