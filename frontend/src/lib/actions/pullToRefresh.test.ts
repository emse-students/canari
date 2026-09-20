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

/**
 * Counts the `touchmove` listeners the action holds on its node.
 *
 * THE COUNT IS THE MEASUREMENT, not whether the handler declines. A bound non-passive `touchmove`
 * takes its scroller off the compositor for as long as it is bound: the engine cannot know the
 * handler will decline, so it routes every move through the main thread first. The action declined
 * correctly all along and still cost `/posts` - which binds it to the app's main scroller - every
 * scroll of the feed.
 */
function trackTouchMove(node: HTMLElement) {
  const state = { bound: 0 };
  const add = node.addEventListener.bind(node) as (...a: unknown[]) => void;
  const remove = node.removeEventListener.bind(node) as (...a: unknown[]) => void;
  node.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'touchmove') state.bound += 1;
    return add(type, ...rest);
  }) as typeof node.addEventListener;
  node.removeEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === 'touchmove') state.bound -= 1;
    return remove(type, ...rest);
  }) as typeof node.removeEventListener;
  return state;
}

/** Moves the scroller and tells it so, the way a real scroll does. */
function scrollTo(node: HTMLElement, top: number) {
  (node as unknown as { scrollTop: number }).scrollTop = top;
  node.dispatchEvent(new Event('scroll'));
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

  describe('the listener exists only where the gesture can begin', () => {
    it('holds one at the top and none once the scroller has moved', () => {
      const node = scroller();
      const moves = trackTouchMove(node);
      pullToRefresh(node, { onRefresh: () => Promise.resolve() });
      expect(moves.bound).toBe(1);

      scrollTo(node, 40);
      expect(moves.bound).toBe(0);
    });

    it('re-arms when the scroller comes back, and the pull still works', () => {
      const node = scroller();
      const moves = trackTouchMove(node);
      pullToRefresh(node, { onRefresh: () => Promise.resolve() });

      scrollTo(node, 40);
      scrollTo(node, 0);
      expect(moves.bound).toBe(1);

      touch(node, 'touchstart', 100);
      expect(touch(node, 'touchmove', 140)).toBe(true);
    });

    it('binds nothing at all when it mounts onto a scroller already away from the top', () => {
      const node = scroller();
      (node as unknown as { scrollTop: number }).scrollTop = 40;
      const moves = trackTouchMove(node);
      pullToRefresh(node, { onRefresh: () => Promise.resolve() });

      expect(moves.bound).toBe(0);
    });

    it('keeps the binding through a pull already under way', () => {
      // A claimed pull is `preventDefault`ed, so no scroll event arrives to re-arm it. Losing the
      // listener here would drop the gesture halfway through, with the indicator on screen.
      const node = scroller();
      const moves = trackTouchMove(node);
      pullToRefresh(node, { onRefresh: () => Promise.resolve() });

      touch(node, 'touchstart', 100);
      touch(node, 'touchmove', 140);
      scrollTo(node, 0);

      expect(moves.bound).toBe(1);
    });

    it('releases the listener on destroy', () => {
      const node = scroller();
      const moves = trackTouchMove(node);
      const { destroy } = pullToRefresh(node, { onRefresh: () => Promise.resolve() });

      destroy();

      expect(moves.bound).toBe(0);
    });
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
