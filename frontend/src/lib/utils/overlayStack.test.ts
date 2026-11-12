import { describe, expect, it, vi } from 'vitest';

vi.mock('./Log', () => ({ Log: { d: vi.fn(), i: vi.fn(), w: vi.fn() } }));

import { Log } from './Log';
import {
  OVERLAY_CAPACITY,
  OVERLAY_Z_BASE,
  OVERLAY_Z_LIMIT,
  OVERLAY_Z_STRIDE,
  OverlayStack,
} from './overlayStack';

const z = (stack: OverlayStack, id: number) => stack.placeOf(id)!.z;

describe('OverlayStack', () => {
  it('puts the overlay opened last on top', () => {
    const stack = new OverlayStack();
    const first = stack.register('first');
    const second = stack.register('second');
    const third = stack.register('third');

    expect(z(stack, first)).toBeLessThan(z(stack, second));
    expect(z(stack, second)).toBeLessThan(z(stack, third));
    expect(z(stack, first)).toBe(OVERLAY_Z_BASE);
  });

  it('keeps a nested open above its parent, however deep', () => {
    const stack = new OverlayStack();
    const ids = ['viewer', 'dialog', 'picker', 'popover'].map((label) => stack.register(label));

    const zs = ids.map((id) => z(stack, id));
    expect([...zs].sort((a, b) => a - b)).toEqual(zs);
    expect(new Set(zs).size).toBe(zs.length);
  });

  it('gives each overlay a second z-index just above its own, below the next overlay', () => {
    const stack = new OverlayStack();
    const first = stack.register('panel');
    const second = stack.register('next');

    const place = stack.placeOf(first)!;
    expect(place.zAbove).toBe(place.z + 1);
    expect(place.zAbove).toBeLessThan(z(stack, second));
  });

  it('closes ranks when an overlay below the top closes, and a later open still lands on top', () => {
    const stack = new OverlayStack();
    const a = stack.register('a');
    const b = stack.register('b');
    const c = stack.register('c');

    stack.release(b);
    expect(stack.placeOf(b)).toBeNull();
    expect(z(stack, a)).toBeLessThan(z(stack, c));

    const d = stack.register('d');
    expect(z(stack, d)).toBeGreaterThan(z(stack, c));
    expect(new Set([a, c, d].map((id) => z(stack, id))).size).toBe(3);
  });

  it('releases the top, then reopens above what remains', () => {
    const stack = new OverlayStack();
    const a = stack.register('a');
    const b = stack.register('b');

    stack.release(b);
    expect(stack.depth).toBe(1);
    const again = stack.register('b again');
    expect(z(stack, again)).toBeGreaterThan(z(stack, a));
  });

  it('is idempotent on release and ignores an id it never issued', () => {
    const stack = new OverlayStack();
    const a = stack.register('a');

    stack.release(a);
    stack.release(a);
    stack.release(9999);

    expect(stack.depth).toBe(0);
  });

  it('stays below the toast whatever the depth, and says so when it overflows', () => {
    const stack = new OverlayStack();
    const ids = Array.from({ length: OVERLAY_CAPACITY + 5 }, (_, i) => stack.register(`o${i}`));

    for (const id of ids) expect(stack.placeOf(id)!.zAbove).toBeLessThan(OVERLAY_Z_LIMIT);
    expect(OVERLAY_Z_STRIDE).toBe(2);
    expect(Log.w).toHaveBeenCalled();
  });

  it('logs every register and release', () => {
    const stack = new OverlayStack();
    vi.mocked(Log.d).mockClear();
    const id = stack.register('modal');
    stack.release(id);

    expect(vi.mocked(Log.d).mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining('register modal'),
      expect.stringContaining('release modal'),
    ]);
  });
});
