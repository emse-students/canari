// @vitest-environment happy-dom
/** `trackTouchHold`: a hold is the touches themselves, released by the last finger lifting. */
import { describe, expect, it } from 'vitest';
import { trackTouchHold } from './touchHold';

/** A touch event whose `touches` lists `left` fingers still down. */
function touch(type: string, left: number): Event {
  const e = new Event(type);
  Object.defineProperty(e, 'touches', { value: { length: left } });
  return e;
}

describe('trackTouchHold', () => {
  it('nothing held: released at once', async () => {
    const hold = trackTouchHold(document.createElement('div'));
    expect(hold.held).toBe(false);
    await expect(hold.whenReleased()).resolves.toBeUndefined();
  });

  it('a waiter resolves only when the LAST finger lifts', async () => {
    const el = document.createElement('div');
    const hold = trackTouchHold(el);
    el.dispatchEvent(touch('touchstart', 2));
    let released = false;
    void hold.whenReleased().then(() => (released = true));
    el.dispatchEvent(touch('touchend', 1));
    await Promise.resolve();
    expect(released).toBe(false);
    expect(hold.held).toBe(true);
    el.dispatchEvent(touch('touchcancel', 0));
    await Promise.resolve();
    expect(released).toBe(true);
    expect(hold.held).toBe(false);
  });

  it('dispose releases every waiter and stops listening', async () => {
    const el = document.createElement('div');
    const hold = trackTouchHold(el);
    el.dispatchEvent(touch('touchstart', 1));
    let released = false;
    void hold.whenReleased().then(() => (released = true));
    hold.dispose();
    await Promise.resolve();
    expect(released).toBe(true);
    el.dispatchEvent(touch('touchstart', 1));
    expect(hold.held).toBe(false);
  });
});
