/**
 * THE DEFECT THESE PIN WAS INVISIBLE AT EVERY WIDTH ANYONE DEVELOPS AT.
 *
 * The full reaction picker chose its anchor by querying the DOM for the hover toolbar's icon strip.
 * The strip is in the tree at every width - `hidden md:block` - so below 768px the query succeeded
 * and returned a `display: none` node, and the panel was positioned against a zero rect at the
 * window origin. Measured 2026-09-09: correct at 1920px, correct at 900px, in the top-left corner at
 * 620px. A test that runs at one width would have agreed with the bug.
 *
 * Making the choice a pure function of the ORIGIN removes the width from the question entirely,
 * which is the only reason it can be pinned here at all.
 */
import { describe, it, expect } from 'vitest';
import { pickerAnchor, pickerAlignsToEnd } from './reactionPicker';

const ROW = 'row';
const STRIP = 'strip';

describe('pickerAnchor', () => {
  it('anchors to the icon strip when the toolbar "+" opened it', () => {
    expect(pickerAnchor('toolbar', ROW, STRIP)).toBe(STRIP);
  });

  it('anchors to the message row when the long-press sheet opened it, STRIP OR NO STRIP', () => {
    // The whole defect in one line: the strip is present in the DOM here too, and it is the wrong
    // answer anyway. Passing it in and still getting the row is the property that matters.
    expect(pickerAnchor('sheet', ROW, STRIP)).toBe(ROW);
  });

  it('has nothing to anchor when the panel is closed', () => {
    expect(pickerAnchor(null, ROW, STRIP)).toBe(ROW);
  });
});

describe('pickerAlignsToEnd', () => {
  it('mirrors the side when the anchor is the strip, because the strip sits in the far gutter', () => {
    // An own message is right-aligned, so against the ROW its panel pins its right edge. Against the
    // STRIP the popovers grow the other way - the quick bar beside this one is `left-0` when `isOwn`
    // - and pinning the right edge there put the panel 174px from the button that opened it.
    expect({
      ownFromToolbar: pickerAlignsToEnd('toolbar', true),
      receivedFromToolbar: pickerAlignsToEnd('toolbar', false),
      ownFromSheet: pickerAlignsToEnd('sheet', true),
      receivedFromSheet: pickerAlignsToEnd('sheet', false),
    }).toEqual({
      ownFromToolbar: false,
      receivedFromToolbar: true,
      ownFromSheet: true,
      receivedFromSheet: false,
    });
  });

  it('grows in the same direction as the quick bar it replaces, for both authors', () => {
    // Stated as the invariant rather than as four booleans: the bar and the panel hang off the same
    // strip, so a reader must never see one open left and the other right.
    for (const isOwn of [true, false]) {
      const quickBarPinsLeftEdge = isOwn; // `left-0` when own, `right-0` when received
      expect(pickerAlignsToEnd('toolbar', isOwn)).toBe(!quickBarPinsLeftEdge);
    }
  });
});
