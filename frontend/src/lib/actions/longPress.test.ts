// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { longPress, LONG_PRESS_MS, type LongPressParams } from './longPress';

/**
 * The shared hold (2026-10-13): the "who reacted" list and the community rail's menu. What must not
 * break is the pair that makes a hold safe - the click ending it is swallowed, the native menu is
 * refused - and the line between a touch hold's `contextmenu` and a right click's.
 */

function pointer(type: string, init: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerType: 'touch',
    button: 0,
    clientX: 0,
    clientY: 0,
    ...init,
  });
}

let node: HTMLButtonElement;
let destroy: () => void;
let activated: number;

function wire(params: LongPressParams) {
  node = document.createElement('button');
  document.body.appendChild(node);
  activated = 0;
  // A delegated handler, as Svelte's `onclick` is: it is reached only by bubbling.
  document.body.addEventListener('click', onBodyClick);
  destroy = longPress(node, params).destroy;
}

function onBodyClick() {
  activated++;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  destroy?.();
  document.body.removeEventListener('click', onBodyClick);
  document.body.innerHTML = '';
});

describe('longPress', () => {
  it('a hold calls onHold once and swallows the click that ends it', () => {
    const onHold = vi.fn();
    wire({ onHold });
    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    node.dispatchEvent(pointer('pointerup'));
    node.dispatchEvent(new Event('click', { bubbles: true }));

    expect(onHold).toHaveBeenCalledExactlyOnceWith(node);
    expect(activated).toBe(0);
    // The NEXT click is a tap again.
    node.dispatchEvent(new Event('click', { bubbles: true }));
    expect(activated).toBe(1);
  });

  it('a tap is a click and never a hold', () => {
    const onHold = vi.fn();
    wire({ onHold });
    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    node.dispatchEvent(pointer('pointerup'));
    vi.advanceTimersByTime(1000);
    node.dispatchEvent(new Event('click', { bubbles: true }));

    expect(onHold).not.toHaveBeenCalled();
    expect(activated).toBe(1);
  });

  it('a press that travels is a scroll or a drag, and holds nothing', () => {
    const onHold = vi.fn();
    wire({ onHold, slopPx: 3 });
    node.dispatchEvent(pointer('pointerdown'));
    node.dispatchEvent(pointer('pointermove', { clientX: 4 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('a hold the caller declined leaves the click alone', () => {
    wire({ onHold: () => false });
    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    node.dispatchEvent(new Event('click', { bubbles: true }));
    expect(activated).toBe(1);
  });

  it('holds only with the pointer types it is given', () => {
    const onHold = vi.fn();
    wire({ onHold, pointerTypes: ['touch', 'pen'] });
    node.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse' }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(onHold).not.toHaveBeenCalled();
    node.dispatchEvent(pointer('pointerdown', { pointerType: 'pen' }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(onHold).toHaveBeenCalledOnce();
  });

  it('a right click asks for the menu, and the native one is refused', () => {
    const onContextMenu = vi.fn();
    wire({ onHold: vi.fn(), onContextMenu });
    const menu = new Event('contextmenu', { bubbles: true, cancelable: true });
    node.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(node);
  });

  it('the contextmenu a touch hold raises is the hold, not a second request', () => {
    const onHold = vi.fn();
    const onContextMenu = vi.fn();
    wire({ onHold, onContextMenu });
    node.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    const menu = new Event('contextmenu', { bubbles: true, cancelable: true });
    node.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(onHold).toHaveBeenCalledOnce();
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('a right click after a touch whose release never came still opens the menu', () => {
    const onContextMenu = vi.fn();
    wire({ onHold: vi.fn(), onContextMenu });
    // A touch press, carried away by a drag: no pointerup reaches the node.
    node.dispatchEvent(pointer('pointerdown'));
    node.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse', button: 2 }));
    node.dispatchEvent(new Event('contextmenu', { bubbles: true, cancelable: true }));
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(node);
  });

  it('a mouse right button never starts a hold', () => {
    const onHold = vi.fn();
    wire({ onHold });
    node.dispatchEvent(pointer('pointerdown', { pointerType: 'mouse', button: 2 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    expect(onHold).not.toHaveBeenCalled();
  });
});
