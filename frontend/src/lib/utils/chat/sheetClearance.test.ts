/**
 * The arithmetic of the lift, pinned on the numbers that were actually measured.
 *
 * The A1 case is the first test and it is not a round number on purpose: it is what the phone
 * reported on 2026-09-14, so a change that "simplifies" the rule has to explain that screen.
 */
import { describe, it, expect } from 'vitest';
import { sheetClearance, sheetRestingTop, SHEET_CLEARANCE_GAP_PX } from './sheetClearance';

describe('sheetClearance', () => {
  it('lifts the A1 bubble exactly clear of the sheet that was covering its lower half', () => {
    // Measured on A1, 2026-09-14: bubble 731-767, the sheet's reaction strip starting at 749.
    const { padBy, scrollBy } = sheetClearance({
      bubbleTop: 731,
      bubbleBottom: 767,
      sheetTop: 749,
      scrollerTop: 120,
      scrollRemaining: 0,
    });

    // 767 + 8 - 749: the covered 18 px, plus the gap that keeps the bubble off the sheet's edge.
    expect(scrollBy).toBe(26);
    // The thread was at its maximum - which is the ordinary case, since the message someone
    // long-presses at the bottom of the screen is usually the last one - so every pixel of the
    // lift has to be borrowed before it can be scrolled into.
    expect(padBy).toBe(26);
  });

  it('borrows only the room the scroller does not already have', () => {
    const { padBy, scrollBy } = sheetClearance({
      bubbleTop: 731,
      bubbleBottom: 767,
      sheetTop: 749,
      scrollerTop: 120,
      scrollRemaining: 10,
    });

    expect(scrollBy).toBe(26);
    expect(padBy).toBe(16);
  });

  it('borrows nothing when the thread can already scroll far enough', () => {
    expect(
      sheetClearance({
        bubbleTop: 731,
        bubbleBottom: 767,
        sheetTop: 749,
        scrollerTop: 120,
        scrollRemaining: 4000,
      })
    ).toEqual({ padBy: 0, scrollBy: 26 });
  });

  it('does nothing at all when the sheet already clears the bubble', () => {
    // A message in the middle of the thread: the sheet is a long way below it.
    expect(
      sheetClearance({
        bubbleTop: 300,
        bubbleBottom: 336,
        sheetTop: 749,
        scrollerTop: 120,
        scrollRemaining: 4000,
      })
    ).toEqual({ padBy: 0, scrollBy: 0 });
  });

  it('does nothing when the bubble ends exactly one gap above the sheet', () => {
    expect(
      sheetClearance({
        bubbleTop: 700,
        bubbleBottom: 749 - SHEET_CLEARANCE_GAP_PX,
        sheetTop: 749,
        scrollerTop: 120,
        scrollRemaining: 4000,
      })
    ).toEqual({ padBy: 0, scrollBy: 0 });
  });

  it('stops the lift at the bubble’s own head rather than scrolling its first line away', () => {
    // A long message: 600 px of bubble against 380 px of room above the sheet. Clearing its bottom
    // would take 259 px of lift and put its top 129 px above the scroller - the beginning of the
    // text, gone, to reveal the end of it.
    const { padBy, scrollBy } = sheetClearance({
      bubbleTop: 120,
      bubbleBottom: 1000,
      sheetTop: 749,
      scrollerTop: 120,
      scrollRemaining: 4000,
    });

    // The bubble's top is already at the scroller's top: there is no lift to take.
    expect(scrollBy).toBe(0);
    expect(padBy).toBe(0);
  });

  it('lifts a long message as far as its head allows and no further', () => {
    const { scrollBy } = sheetClearance({
      bubbleTop: 200,
      bubbleBottom: 1000,
      sheetTop: 749,
      scrollerTop: 120,
      scrollRemaining: 4000,
    });

    // Wants 259, may have 80 - the distance between the bubble's top and the scroller's.
    expect(scrollBy).toBe(80);
  });

  it('rounds the lift UP, because a fraction of a pixel short is a visible sliver', () => {
    const { scrollBy, padBy } = sheetClearance({
      bubbleTop: 731.5,
      bubbleBottom: 767.4,
      sheetTop: 749,
      scrollerTop: 120,
      scrollRemaining: 0,
    });

    // 767.4 + 8 - 749 = 26.4
    expect(scrollBy).toBe(27);
    expect(padBy).toBe(27);
  });
});

describe('sheetRestingTop', () => {
  it('reads the resting top from layout, so a transition in flight cannot change the answer', () => {
    // A 945 px screen, the sheet 180 px tall sitting 16 px off the bottom.
    expect(sheetRestingTop(945, 16, 180)).toBe(749);
  });

  it('measures against the overlay it is positioned in, not against the window', () => {
    // The overlay is the containing block for the sheet's `bottom`, so a shorter one moves the
    // sheet with it - which is what happens when the keyboard shrinks the visual viewport.
    expect(sheetRestingTop(600, 16, 180)).toBe(404);
  });
});
