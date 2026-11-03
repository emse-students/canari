/** Where the bubble lands: the side with room, clamped inside the viewport, centred with no target. */
import { describe, expect, it } from 'vitest';
import { placeBubble } from './guidePlacement';

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
