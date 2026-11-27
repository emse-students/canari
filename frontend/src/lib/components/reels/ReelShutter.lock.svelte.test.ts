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

function render(props: { recording: boolean; locked?: boolean }) {
  const calls = {
    onpress: vi.fn(),
    onrelease: vi.fn(),
    oncancel: vi.fn(),
    onlock: vi.fn(),
    onstop: vi.fn(),
  };
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelShutter, { target, props: { fraction: 0, timeLabel: '0:00', ...props, ...calls } })
  );
  flushSync();
  const shutter = target.querySelector<HTMLButtonElement>('[data-reel-shutter]')!;
  const fire = (type: string, x = 0, y = 0) => {
    shutter.dispatchEvent(
      new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true })
    );
    flushSync();
  };
  return { target, calls, fire };
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
  it('offers the padlock only while a take is held, with an accessible name', () => {
    const { target, fire } = render({ recording: true });
    expect(target.querySelector('[data-reel-padlock]')).toBeNull();
    fire('pointerdown', 200, 200);
    const lock = target.querySelector('[data-reel-padlock]')!;
    expect(lock.getAttribute('aria-label')).toBeTruthy();
  });

  it('hold then release stops, as before', () => {
    stubPadlockRect();
    const { calls, fire } = render({ recording: true });
    fire('pointerdown', 200, 200);
    fire('pointerup', 200, 200);
    expect(calls.onrelease).toHaveBeenCalledTimes(1);
    expect(calls.onlock).not.toHaveBeenCalled();
  });

  it('hold, slide onto the padlock, lift: locks and does NOT release', () => {
    stubPadlockRect();
    const { target, calls, fire } = render({ recording: true });
    fire('pointerdown', 200, 200);
    fire('pointermove', 20, 20);
    expect(target.querySelector('[data-reel-padlock]')!.getAttribute('data-engaged')).toBe('true');
    fire('pointerup', 20, 20);
    expect(calls.onlock).toHaveBeenCalledTimes(1);
    expect(calls.onrelease).not.toHaveBeenCalled();
  });

  it('slide back off the padlock before lifting: not locked, the lift releases', () => {
    stubPadlockRect();
    const { calls, fire } = render({ recording: true });
    fire('pointerdown', 200, 200);
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

  it('on a locked take one tap stops it and is not a new press', () => {
    const { target, calls, fire } = render({ recording: true, locked: true });
    expect(target.querySelector('[data-reel-padlock]')).toBeNull();
    fire('pointerdown', 200, 200);
    fire('pointerup', 200, 200);
    expect(calls.onstop).toHaveBeenCalledTimes(1);
    expect(calls.onpress).not.toHaveBeenCalled();
    expect(calls.onrelease).not.toHaveBeenCalled();
  });

  it('the keyboard stops a locked take', () => {
    const { target, calls } = render({ recording: true, locked: true });
    target
      .querySelector('[data-reel-shutter]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(calls.onstop).toHaveBeenCalledTimes(1);
  });
});
