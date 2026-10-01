import { floatingDateIndex, stickyDateIndex } from './stickyDate';

/**
 * THE BINARY SEARCH HAS TO GIVE THE SAME ANSWER AS THE WALK IT REPLACED, including at both ends -
 * an off-by-one here names the wrong day on a pill the reader is looking straight at. The last
 * test asserts the point of the change: how many separators are actually measured.
 */
const search = (tops: number[], line = 40) => stickyDateIndex(tops.length, (i) => tops[i], line);

describe('stickyDateIndex', () => {
  it('names the last separator at or above the line', () => {
    expect(search([-500, -200, -10, 120, 400])).toBe(2);
  });

  it('counts a separator exactly on the line as above it', () => {
    expect(search([-100, 40, 300])).toBe(1);
  });

  it('names the first separator when none is above the line', () => {
    // The reader is at the very top of the history, which is what the old walk's seed value said.
    expect(search([60, 200, 900])).toBe(0);
  });

  it('names the last separator when all of them are above the line', () => {
    expect(search([-900, -600, -300, -40])).toBe(3);
  });

  it('handles a single separator either way', () => {
    expect(search([-5])).toBe(0);
    expect(search([500])).toBe(0);
  });

  it('agrees with a linear walk over every prefix boundary', () => {
    const tops = [-400, -300, -200, -100, 0, 40, 41, 200, 800];
    const walk = () => {
      let found = 0;
      for (let i = 0; i < tops.length; i += 1) {
        if (tops[i] <= 40) found = i;
        else break;
      }
      return found;
    };
    expect(search(tops)).toBe(walk());
  });

  it('measures a logarithmic number of separators, which is the whole point', () => {
    const tops = Array.from({ length: 512 }, (_, i) => i * 100 - 40_000);
    let measured = 0;
    stickyDateIndex(tops.length, (i) => {
      measured += 1;
      return tops[i];
    });
    // 512 separators: 9 or 10 reads rather than 400.
    expect(measured).toBeLessThanOrEqual(10);
  });
});

describe('floatingDateIndex', () => {
  /** Separators 26px tall, given by their tops. */
  const floating = (tops: number[], covered = 0) =>
    floatingDateIndex(tops.length, (i) => ({ top: tops[i], bottom: tops[i] + 26 }), covered);

  it('names the day whose separator has scrolled out of sight', () => {
    expect(floating([-500, -100, 300])).toBe(1);
  });

  it('stays hidden while the separator it would name is still on screen, so no day is drawn twice', () => {
    expect(floating([-500, 10, 300])).toBeNull();
  });

  it('stays hidden at the top of the history, where the first separator is visible', () => {
    expect(floating([60, 400])).toBeNull();
  });

  it('counts a separator hidden under a banner as out of sight, and moves the band below it', () => {
    // A 28px banner covers 0..28: the separator at 0..26 is behind it, so the pill names its day.
    expect(floating([-400, 0, 300], 28)).toBe(1);
    // One at 50 sits in the pill's band under the banner (28..68) and is still visible.
    expect(floating([-400, 50, 300], 28)).toBeNull();
  });
});
