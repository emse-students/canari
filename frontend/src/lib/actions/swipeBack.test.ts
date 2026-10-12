import { swipeBack } from './swipeBack';

/**
 * Dispatches a touch event carrying the one field the action reads (`clientX`/`clientY`), the
 * same minimal shape `pullToRefresh.test.ts` uses - happy-dom has no real `TouchEvent`
 * constructor, and the action only ever reads `touches[0]`/`changedTouches[0]`.
 */
function touch(
  target: HTMLElement,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  clientX: number,
  clientY = 0
) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = [{ clientX, clientY }];
  Object.defineProperty(e, 'touches', { value: list });
  Object.defineProperty(e, 'changedTouches', { value: list });
  target.dispatchEvent(e);
}

describe('swipeBack', () => {
  it('does not arm on a touch that starts on a button, even inside the edge zone', () => {
    const node = document.createElement('section');
    const button = document.createElement('button');
    node.appendChild(button);
    document.body.appendChild(node);
    const onBack = vi.fn();
    swipeBack(node, { onBack, enabled: true });

    // Starts at clientX=10 - well inside the default 28px edge zone - on the button itself.
    touch(button, 'touchstart', 10);
    touch(button, 'touchmove', 60);
    touch(button, 'touchend', 60);

    // Neither the gesture's own elastic drag nor a commit should ever have started: the guard
    // declines at touchstart, so tracking never arms and every later handler no-ops.
    expect(node.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
  });

  it('does not arm on a message bubble, whose own reply swipe is the same stroke', () => {
    const node = document.createElement('section');
    const bubble = document.createElement('div');
    bubble.setAttribute('data-swipe-reply', '');
    node.appendChild(bubble);
    document.body.appendChild(node);
    const onBack = vi.fn();
    swipeBack(node, { onBack, enabled: true });

    // A received bubble sits against the left edge, so it is inside the 28px strip; dragging it
    // right to reply used to carry past this action's 90px and dismiss the thread underneath.
    touch(bubble, 'touchstart', 12);
    touch(bubble, 'touchmove', 120);
    touch(bubble, 'touchend', 120);
    node.dispatchEvent(new Event('transitionend'));

    expect(node.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
  });

  it('still commits when the touch starts on plain space inside the edge zone', () => {
    const node = document.createElement('section');
    node.appendChild(document.createElement('div'));
    document.body.appendChild(node);
    const onBack = vi.fn();
    swipeBack(node, { onBack, enabled: true });

    touch(node, 'touchstart', 5);
    touch(node, 'touchmove', 120); // past the 90px default threshold
    touch(node, 'touchend', 120);
    // The commit itself fires once the slide-out CSS transition ends, not synchronously - see
    // `onTouchEnd`'s `transitionend` listener. Dispatched here rather than awaited: this stays
    // deterministic instead of depending on a real animation frame happy-dom never renders.
    node.dispatchEvent(new Event('transitionend'));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does not arm while text is selected, and abandons a drag a selection takes over', () => {
    const node = document.createElement('section');
    node.appendChild(document.createElement('div'));
    document.body.appendChild(node);
    const onBack = vi.fn();
    swipeBack(node, { onBack, enabled: true });
    const selecting = { rangeCount: 1, isCollapsed: false, toString: () => 'copy me' };
    const none = { rangeCount: 0, isCollapsed: true, toString: () => '' };
    const spy = vi.spyOn(window, 'getSelection');

    // A selection that exists at touchstart: the touch is a handle drag, nothing arms.
    spy.mockReturnValue(selecting as unknown as Selection);
    touch(node, 'touchstart', 5);
    touch(node, 'touchmove', 120);
    touch(node, 'touchend', 120);
    node.dispatchEvent(new Event('transitionend'));
    expect(node.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();

    // A selection that appears mid-drag: the page snaps back and the release cannot go back.
    spy.mockReturnValue(none as unknown as Selection);
    touch(node, 'touchstart', 5);
    touch(node, 'touchmove', 60);
    expect(node.style.transform).toContain('translate3d');
    spy.mockReturnValue(selecting as unknown as Selection);
    touch(node, 'touchmove', 120);
    touch(node, 'touchend', 120);
    node.dispatchEvent(new Event('transitionend'));
    expect(node.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('forgets an edge touch the system cancelled, so the next scroll is not read as a swipe back', () => {
    const node = document.createElement('section');
    document.body.appendChild(node);
    const onBack = vi.fn();
    swipeBack(node, { onBack, enabled: true });

    // The Android system back gesture takes the edge touch: touchcancel, never touchend.
    touch(node, 'touchstart', 2, 1200);
    touch(node, 'touchmove', 40, 1200);
    touch(node, 'touchcancel', 40, 1200);

    // A vertical scroll at mid-screen, as the next stroke of the same finger session.
    touch(node, 'touchstart', 540, 700);
    touch(node, 'touchmove', 540, 1200);
    touch(node, 'touchend', 540, 1700);

    expect(onBack).not.toHaveBeenCalled();
    expect(node.style.transform).toBe('');
  });

  it('says what it did with an edge touch, so a device log can tell a cancelled touch from a lifted one', () => {
    const node = document.createElement('section');
    document.body.appendChild(node);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    swipeBack(node, { onBack: vi.fn(), enabled: true });

    touch(node, 'touchstart', 2, 1200);
    touch(node, 'touchcancel', 40, 1200);
    touch(node, 'touchstart', 3, 1200);
    touch(node, 'touchend', 10, 1200);

    const lines = debug.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      '[swipeBack] armed at x=2',
      '[swipeBack] touch cancelled (tracking=true, committed=false)',
      '[swipeBack] armed at x=3',
      '[swipeBack] released dx=7 -> snap',
    ]);
    debug.mockRestore();
  });

  it('forgets an unfinished edge touch when a new touch starts away from the edge', () => {
    const node = document.createElement('section');
    document.body.appendChild(node);
    const onBack = vi.fn();
    swipeBack(node, { onBack, enabled: true });

    touch(node, 'touchstart', 2, 1200);
    // No touchend and no touchcancel at all: the next touch must still start clean.
    touch(node, 'touchstart', 540, 700);
    touch(node, 'touchmove', 700, 700);
    touch(node, 'touchend', 700, 700);

    expect(onBack).not.toHaveBeenCalled();
  });
});
