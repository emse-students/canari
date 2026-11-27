// @vitest-environment happy-dom
/**
 * The shutter's slide-to-lock gesture (owner, 2026-11-27): hold -> release stops; hold -> slide onto the
 * padlock -> lift locks (no release); sliding back off before the lift locks nothing; a locked take
 * ends by ONE tap on the stop. The padlock's rectangle is stubbed (happy-dom lays nothing out).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelShutter from './ReelShutter.svelte';

const mounted: Record<string, unknown>[] = [];

/**
 * `recording` is the SCREEN's state: a press starts with it false and it turns true when the hold
 * threshold fires, so `begin` mimics that (press, then the take starts under the finger).
 */
function render(initial: { recording: boolean; locked?: boolean }) {
  const props = $state({ fraction: 0, timeLabel: '0:00', disabled: false, ...initial });
  const calls = {
    onpress: vi.fn(),
    onrelease: vi.fn(),
    oncancel: vi.fn(),
    onlock: vi.fn(),
    onstop: vi.fn(),
  };
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(ReelShutter, { target, props: Object.assign(props, calls) }));
  flushSync();
  const shutter = target.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
  const fire = (type: string, x = 0, y = 0, extra: PointerEventInit = {}) => {
    shutter.dispatchEvent(
      new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, ...extra })
    );
    flushSync();
  };
  /** A finger goes down on the idle shutter and the take starts under it. */
  const begin = (x = 200, y = 200) => {
    fire('pointerdown', x, y);
    props.recording = true;
    flushSync();
  };
  return { target, calls, fire, begin, props, shutter };
}

/** The padlock sits at x 0-40, y 0-40 whatever the layout says. */
function stubPadlockRect() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 40,
    top: 0,
    bottom: 40,
    width: 40,
    height: 40,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('ReelShutter slide to lock', () => {
  it('the padlock appears reactively once the take starts under the finger, with an accessible name', () => {
    const { target, fire, props } = render({ recording: false });
    fire('pointerdown', 200, 200);
    // Pressing, no take yet: no padlock.
    expect(target.querySelector('[data-reel-padlock]')).toBeNull();
    props.recording = true;
    flushSync();
    const lock = target.querySelector('[data-reel-padlock]')!;
    expect(lock.getAttribute('aria-label')).toBeTruthy();
  });

  it('hold then release stops, as before', () => {
    stubPadlockRect();
    const { calls, fire, begin } = render({ recording: false });
    begin();
    fire('pointerup', 200, 200);
    expect(calls.onrelease).toHaveBeenCalledTimes(1);
    expect(calls.onlock).not.toHaveBeenCalled();
  });

  it('hold, slide onto the padlock, lift: locks and does NOT release', () => {
    stubPadlockRect();
    const { target, calls, fire, begin } = render({ recording: false });
    begin();
    fire('pointermove', 20, 20);
    expect(target.querySelector('[data-reel-padlock]')!.getAttribute('data-engaged')).toBe('true');
    fire('pointerup', 20, 20);
    expect(calls.onlock).toHaveBeenCalledTimes(1);
    expect(calls.onrelease).not.toHaveBeenCalled();
  });

  it('slide back off the padlock before lifting: not locked, the lift releases', () => {
    stubPadlockRect();
    const { calls, fire, begin } = render({ recording: false });
    begin();
    fire('pointermove', 20, 20);
    fire('pointermove', 200, 200);
    fire('pointerup', 200, 200);
    expect(calls.onlock).not.toHaveBeenCalled();
    expect(calls.onrelease).toHaveBeenCalledTimes(1);
  });

  it('a press before the take exists never locks, wherever the finger lifts', () => {
    stubPadlockRect();
    const { calls, fire } = render({ recording: false });
    fire('pointerdown', 200, 200);
    fire('pointerup', 20, 20);
    expect(calls.onlock).not.toHaveBeenCalled();
    expect(calls.onrelease).toHaveBeenCalledTimes(1);
  });

  it('a finger landing on a take that already runs (volume key) gets no padlock and never locks', () => {
    stubPadlockRect();
    const { target, calls, fire } = render({ recording: true });
    fire('pointerdown', 200, 200);
    expect(target.querySelector('[data-reel-padlock]')).toBeNull();
    fire('pointermove', 20, 20);
    fire('pointerup', 20, 20);
    expect(calls.onlock).not.toHaveBeenCalled();
    expect(calls.onrelease).toHaveBeenCalledTimes(1);
  });

  it('on a locked take one tap stops it and is not a new press', () => {
    const { target, calls, fire } = render({ recording: true, locked: true });
    expect(target.querySelector('[data-reel-padlock]')).toBeNull();
    fire('pointerdown', 200, 200);
    fire('pointerup', 200, 200);
    expect(calls.onstop).toHaveBeenCalledTimes(1);
    expect(calls.onpress).not.toHaveBeenCalled();
    expect(calls.onrelease).not.toHaveBeenCalled();
  });

  it('the keyboard stops a locked take, and the lock is announced', () => {
    const { target, calls } = render({ recording: true, locked: true });
    target
      .querySelector('[data-reel-shutter]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(calls.onstop).toHaveBeenCalledTimes(1);
    expect(target.querySelector('[data-reel-lock-live]')!.textContent!.trim()).not.toBe('');
  });

  it('a non-primary mouse button starts nothing', () => {
    const { calls, fire } = render({ recording: false });
    fire('pointerdown', 200, 200, { button: 2, pointerType: 'mouse' });
    expect(calls.onpress).not.toHaveBeenCalled();
  });

  it('a lost pointer capture frees the shutter: a stop tap cut short, then a new press works', () => {
    const { calls, fire, props } = render({ recording: true, locked: true });
    fire('pointerdown', 200, 200);
    fire('lostpointercapture', 200, 200);
    expect(calls.onstop).not.toHaveBeenCalled();
    props.locked = false;
    props.recording = false;
    flushSync();
    fire('pointerdown', 200, 200);
    expect(calls.onpress).toHaveBeenCalledTimes(1);
  });

  it('a hold whose capture is lost ends like a cancelled touch', () => {
    const { calls, fire, begin } = render({ recording: false });
    begin();
    fire('lostpointercapture');
    expect(calls.oncancel).toHaveBeenCalledTimes(1);
  });

  it('going disabled under a followed pointer resets it (the take is finishing)', () => {
    const { calls, fire, props } = render({ recording: true, locked: true });
    fire('pointerdown', 200, 200);
    props.disabled = true;
    flushSync();
    props.disabled = false;
    props.locked = false;
    props.recording = false;
    flushSync();
    fire('pointerdown', 200, 200);
    expect(calls.onpress).toHaveBeenCalledTimes(1);
  });

  it('aiming left toward the padlock stops the zoom reports', () => {
    stubPadlockRect();
    const onmove = vi.fn();
    const { fire, begin, props } = render({ recording: false });
    Object.assign(props, { onmove });
    begin(200, 200);
    fire('pointermove', 190, 150);
    expect(onmove).toHaveBeenCalledTimes(1);
    fire('pointermove', 100, 120);
    expect(onmove).toHaveBeenCalledTimes(1);
  });
});
