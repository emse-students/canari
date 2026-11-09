/** Where the bubble lands: the side with room, clamped inside the viewport, centred with no target. */
import { describe, expect, it } from 'vitest';
import { placeBubble, ringRadius } from './guidePlacement';

describe('ringRadius', () => {
  const box = { width: 100, height: 40 };

  it('grows the control radius by the padding', () => {
    expect(ringRadius(['8px', '8px', '8px', '8px'], box, 6)).toBe(14);
  });

  it('reads a percentage against the box, not as px', () => {
    // 50% of a 100x40 box is the ellipse 50x20: the smaller axis is 20, grown to 26 and capped at 26.
    expect(ringRadius(['50%', '50%', '50%', '50%'], box, 6)).toBe(26);
    expect(ringRadius(['10%', '10%', '10%', '10%'], box, 0)).toBe(4);
  });

  it('takes the smallest of the four corners', () => {
    expect(ringRadius(['12px', '0px', '12px', '12px'], box, 6)).toBe(6);
  });

  it('is null when nothing parses', () => {
    expect(ringRadius(['', '', '', ''], box, 6)).toBeNull();
  });
});

const PHONE = { width: 390, height: 844 };
const BUBBLE = { width: 320, height: 160 };

describe('placeBubble', () => {
  it('goes above a bottom-bar tab, inside the gutter', () => {
    const tab = { left: 100, top: 790, width: 90, height: 48 };
    const p = placeBubble(tab, BUBBLE, PHONE, 'auto', 12, 16);
    expect(p.side).toBe('top');
    expect(p.top).toBe(790 - 12 - 160);
    expect(p.left).toBeGreaterThanOrEqual(16);
    expect(p.left + BUBBLE.width).toBeLessThanOrEqual(PHONE.width - 16);
  });

  it('goes below a header control', () => {
    const avatar = { left: 340, top: 6, width: 44, height: 44 };
    const p = placeBubble(avatar, BUBBLE, PHONE, 'auto', 12, 16);
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(62);
    // Clamped against the right edge: the avatar sits in the corner.
    expect(p.left).toBe(PHONE.width - 16 - BUBBLE.width);
  });

  it('goes beside a target when neither vertical side fits', () => {
    const rail = { left: 12, top: 150, width: 48, height: 48 };
    const p = placeBubble(rail, BUBBLE, { width: 1440, height: 360 }, 'auto', 12, 16);
    expect(p.side).toBe('right');
    expect(p.left).toBe(72);
  });

  it('centres a step with no target', () => {
    const p = placeBubble(null, BUBBLE, PHONE, 'auto', 12, 16);
    expect(p).toEqual({ left: 35, top: 342, side: 'center' });
  });

  it('honours a declared side, still clamped', () => {
    const p = placeBubble({ left: 0, top: 0, width: 10, height: 10 }, BUBBLE, PHONE, 'top', 12, 16);
    expect(p.side).toBe('top');
    expect(p.top).toBe(16);
  });
});
