import { describe, expect, it } from 'vitest';
import { gridDragHint } from './gridHint';
import { m } from '$lib/paraglide/messages';

describe('gridDragHint', () => {
  it('tells a mouse to drag, with no mention of a long press', () => {
    const text = gridDragHint(false, false);
    expect(text).toBe(m.bookings_grid_drag_hint_pointer());
    expect(text).not.toMatch(/appui|long-press|mobile/i);
  });

  it('tells a finger to hold first', () => {
    expect(gridDragHint(false, true)).toBe(m.bookings_grid_drag_hint_touch());
  });

  it('words the block drag the same way, per pointer', () => {
    expect(gridDragHint(true, false)).toBe(m.bookings_grid_block_hint_pointer());
    expect(gridDragHint(true, true)).toBe(m.bookings_grid_block_hint_touch());
    expect(gridDragHint(true, false)).not.toBe(gridDragHint(true, true));
  });

  it('never names the other device in any of the four sentences', () => {
    for (const block of [false, true]) {
      for (const coarse of [false, true]) {
        expect(gridDragHint(block, coarse)).not.toMatch(
          /\(.*(mobile|ordinateur|phone|desktop).*\)/i
        );
      }
    }
  });
});
