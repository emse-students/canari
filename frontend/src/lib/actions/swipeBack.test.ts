import { swipeBack } from './swipeBack';

/**
 * Dispatches a touch event carrying the one field the action reads (`clientX`/`clientY`), the
 * same minimal shape `pullToRefresh.test.ts` uses - happy-dom has no real `TouchEvent`
 * constructor, and the action only ever reads `touches[0]`/`changedTouches[0]`.
 */
function touch(
  target: HTMLElement,
  type: 'touchstart' | 'touchmove' | 'touchend',
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
});
