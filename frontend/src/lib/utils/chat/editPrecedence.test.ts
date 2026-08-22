import { describe, expect, it } from 'vitest';
import { editSupersedes } from './editPrecedence';

/**
 * The property these tests are really about is not any single verdict - it is that TWO devices
 * holding the same pair reach the same answer regardless of the order they saw it in. The last
 * describe block asserts exactly that, by running each pair both ways round.
 */
describe('editSupersedes', () => {
  it('applies an edit to a row that carries none', () => {
    expect(editSupersedes({ editedAt: 100, content: 'a' }, undefined)).toBe(true);
    expect(editSupersedes({ editedAt: 100, content: 'a' }, { content: 'orig' })).toBe(true);
  });

  it('takes a strictly later edit', () => {
    expect(editSupersedes({ editedAt: 200, content: 'b' }, { editedAt: 100, content: 'a' })).toBe(
      true
    );
  });

  it('REFUSES an edit older than the one already applied - the defect MUT-18 caught', () => {
    expect(editSupersedes({ editedAt: 100, content: 'a' }, { editedAt: 200, content: 'b' })).toBe(
      false
    );
  });

  it('reads editedAt as a Date as happily as a number, since memory holds one and storage the other', () => {
    expect(
      editSupersedes({ editedAt: 200, content: 'b' }, { editedAt: new Date(100), content: 'a' })
    ).toBe(true);
    expect(
      editSupersedes({ editedAt: 100, content: 'a' }, { editedAt: new Date(200), content: 'b' })
    ).toBe(false);
  });

  it('breaks a tie on the content, so the same millisecond is still a decision', () => {
    expect(editSupersedes({ editedAt: 100, content: 'b' }, { editedAt: 100, content: 'a' })).toBe(
      true
    );
    expect(editSupersedes({ editedAt: 100, content: 'a' }, { editedAt: 100, content: 'b' })).toBe(
      false
    );
  });

  it('is not superseded by itself - re-reading a log already followed changes nothing', () => {
    expect(editSupersedes({ editedAt: 100, content: 'a' }, { editedAt: 100, content: 'a' })).toBe(
      false
    );
  });

  it('refuses an undated incoming edit against a dated one, rather than clobbering it', () => {
    expect(
      editSupersedes({ editedAt: Number.NaN, content: 'a' }, { editedAt: 100, content: 'b' })
    ).toBe(false);
  });
});

describe('editSupersedes converges - the property, not the verdicts', () => {
  const PAIRS: Array<
    [{ editedAt: number; content: string }, { editedAt: number; content: string }]
  > = [
    [
      { editedAt: 100, content: 'from-W1' },
      { editedAt: 200, content: 'from-A1' },
    ],
    // The same millisecond on both devices: the tie rule is what carries these.
    [
      { editedAt: 100, content: 'from-W1' },
      { editedAt: 100, content: 'from-A1' },
    ],
    // A skewed clock: A1 is five minutes behind, so its LATER edit carries the SMALLER stamp. The
    // winner is then arguably wrong and is still the same on both devices, which is the point.
    [
      { editedAt: 300_000, content: 'from-W1' },
      { editedAt: 100, content: 'from-A1' },
    ],
  ];

  for (const [x, y] of PAIRS) {
    it(`two devices agree on {${x.content} @${x.editedAt}} vs {${y.content} @${y.editedAt}}`, () => {
      // Device 1 applied x, then y arrived. Device 2 applied y, then x arrived.
      const oneEndsOn = editSupersedes(y, x) ? y.content : x.content;
      const twoEndsOn = editSupersedes(x, y) ? x.content : y.content;
      expect(oneEndsOn).toBe(twoEndsOn);
    });
  }
});
