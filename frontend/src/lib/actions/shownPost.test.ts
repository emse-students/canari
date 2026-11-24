// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shownPost } from './shownPost';

type Entry = {
  isIntersecting: boolean;
  intersectionRatio: number;
  intersectionRect: { height: number };
  rootBounds: { height: number } | null;
};

let callback: ((entries: Entry[]) => void) | null = null;
const disconnect = vi.fn();

class FakeObserver {
  constructor(cb: (entries: Entry[]) => void) {
    callback = cb;
  }
  observe() {}
  disconnect = disconnect;
}

const entry = (over: Partial<Entry>): Entry => ({
  isIntersecting: true,
  intersectionRatio: 0,
  intersectionRect: { height: 0 },
  rootBounds: { height: 800 },
  ...over,
});

describe('a post card counts as displayed once most of it is on screen', () => {
  beforeEach(() => {
    callback = null;
    disconnect.mockReset();
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('fires ONCE when half of the card is visible, then disconnects', () => {
    const onshown = vi.fn();
    shownPost(document.createElement('div'), { onshown });
    callback?.([entry({ intersectionRatio: 0.2 })]);
    expect(onshown).not.toHaveBeenCalled();
    callback?.([entry({ intersectionRatio: 0.6 })]);
    callback?.([entry({ intersectionRatio: 1 })]);
    expect(onshown).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
  });

  it('does not count a card that only touches the edge', () => {
    const onshown = vi.fn();
    shownPost(document.createElement('div'), { onshown });
    callback?.([entry({ isIntersecting: false, intersectionRatio: 0 })]);
    expect(onshown).not.toHaveBeenCalled();
  });

  it('counts a card taller than the scrolling box once it fills half of that box', () => {
    const onshown = vi.fn();
    shownPost(document.createElement('div'), { onshown });
    callback?.([entry({ intersectionRatio: 0.3, intersectionRect: { height: 450 } })]);
    expect(onshown).toHaveBeenCalledTimes(1);
  });

  it('fires at once without IntersectionObserver - a capability check, the card is drawn', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onshown = vi.fn();
    shownPost(document.createElement('div'), { onshown });
    expect(onshown).toHaveBeenCalledTimes(1);
  });
});
