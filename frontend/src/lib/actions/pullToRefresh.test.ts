import { pullToRefresh } from './pullToRefresh';

/**
 * Dispatches a touch event carrying the one field the action reads, and reports whether the action
 * claimed the gesture by calling `preventDefault` - which is the whole question: a claimed gesture
 * never reaches the scroller.
 */
function touch(node: HTMLElement, type: 'touchstart' | 'touchmove' | 'touchend', clientY: number) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const list = [{ clientY }];
  Object.defineProperty(e, 'touches', { value: list });
  Object.defineProperty(e, 'changedTouches', { value: list });
  node.dispatchEvent(e);
  return e.defaultPrevented;
}

/** A node at the top of its scroll, which is the only state the gesture arms in. */
function scroller() {
  const node = document.createElement('div');
  document.body.appendChild(node);
  Object.defineProperty(node, 'scrollTop', { value: 0, writable: true });
  return node;
}

describe('pullToRefresh', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('claims a downward pull from the top and shows the indicator', () => {
    const node = scroller();
    pullToRefresh(node, { onRefresh: () => Promise.resolve() });

    touch(node, 'touchstart', 100);
    const claimed = touch(node, 'touchmove', 140);

    expect(claimed).toBe(true);
    expect(node.querySelector('div')).not.toBeNull();
  });

  it('leaves an upward drag to the scroller', () => {
    // The half of the report that turned out NOT to be this action's doing: scrolling the list
    // down is `dy < 0`, and the action releases it untouched. Pinned so a later guard cannot
    // quietly start swallowing the one gesture that must always reach the scroller.
    const node = scroller();
    pullToRefresh(node, { onRefresh: () => Promise.resolve() });

    touch(node, 'touchstart', 400);
    const claimed = touch(node, 'touchmove', 300);

    expect(claimed).toBe(false);
  });

  it('never claims a gesture when the node is already scrolled', () => {
    const node = scroller();
    (node as unknown as { scrollTop: number }).scrollTop = 40;
    pullToRefresh(node, { onRefresh: () => Promise.resolve() });

    touch(node, 'touchstart', 100);

    expect(touch(node, 'touchmove', 200)).toBe(false);
  });

  describe('the spinner appears if and only if work follows it', () => {
    it('declines the gesture entirely when there is nothing to refresh', async () => {
      const onRefresh = vi.fn(() => Promise.resolve());
      const node = scroller();
      pullToRefresh(node, { onRefresh, enabled: () => false });

      touch(node, 'touchstart', 100);
      const claimed = touch(node, 'touchmove', 300);
      touch(node, 'touchend', 300);

      // Not claimed, no indicator, and - past the threshold though the pull was - no refresh.
      expect(claimed).toBe(false);
      expect(node.querySelector('div')).toBeNull();
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it('asks again on the next gesture rather than answering once at mount', () => {
      // The gate is a property of the moment, not of the binding: the socket goes down between two
      // pulls and the second one must arm. An `enabled` read once at mount would refuse for ever.
      let offline = false;
      const node = scroller();
      pullToRefresh(node, { onRefresh: () => Promise.resolve(), enabled: () => offline });

      touch(node, 'touchstart', 100);
      expect(touch(node, 'touchmove', 200)).toBe(false);

      offline = true;
      touch(node, 'touchstart', 100);
      expect(touch(node, 'touchmove', 200)).toBe(true);
    });

    it('runs the refresh when the pull passes the threshold and the gate allows it', () => {
      const onRefresh = vi.fn(() => Promise.resolve());
      const node = scroller();
      pullToRefresh(node, { onRefresh, enabled: () => true, threshold: 72 });

      touch(node, 'touchstart', 100);
      touch(node, 'touchmove', 200);
      touch(node, 'touchend', 200);

      expect(onRefresh).toHaveBeenCalledOnce();
    });

    it('does not run the refresh for a pull short of the threshold', () => {
      const onRefresh = vi.fn(() => Promise.resolve());
      const node = scroller();
      pullToRefresh(node, { onRefresh, threshold: 72 });

      touch(node, 'touchstart', 100);
      touch(node, 'touchmove', 130);
      touch(node, 'touchend', 130);

      expect(onRefresh).not.toHaveBeenCalled();
    });
  });
});
