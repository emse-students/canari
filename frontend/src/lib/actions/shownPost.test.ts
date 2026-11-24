// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shownPost as shown } from './shownPost';

type Entry = {
  target: Element;
  isIntersecting: boolean;
  intersectionRatio: number;
  intersectionRect: { height: number };
  rootBounds: { height: number } | null;
};

const observers: FakeObserver[] = [];
const actions: { destroy(): void }[] = [];
// The observers are shared at module level: each test lets go of its cards, as a page does.
const shownPost = (...args: Parameters<typeof shown>) => {
  const action = shown(...args);
  actions.push(action);
  return action;
};

class FakeObserver {
  observed = new Set<Element>();
  disconnected = false;
  constructor(readonly cb: (entries: Entry[]) => void) {
    observers.push(this);
  }
  observe(node: Element) {
    this.observed.add(node);
  }
  unobserve(node: Element) {
    this.observed.delete(node);
  }
  disconnect() {
    this.disconnected = true;
  }
}

const entry = (target: Element, over: Partial<Entry>): Entry => ({
  target,
  isIntersecting: true,
  intersectionRatio: 0,
  intersectionRect: { height: 0 },
  rootBounds: { height: 800 },
  ...over,
});

describe('a post card counts as displayed once most of it is on screen', () => {
  beforeEach(() => {
    observers.length = 0;
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  });
  afterEach(() => {
    for (const action of actions.splice(0)) action.destroy();
    vi.unstubAllGlobals();
  });

  it('fires ONCE when half of the card is visible, then leaves the observer', () => {
    const onshown = vi.fn();
    const node = document.createElement('div');
    shownPost(node, { onshown });
    const [observer] = observers;
    observer.cb([entry(node, { intersectionRatio: 0.2 })]);
    expect(onshown).not.toHaveBeenCalled();
    observer.cb([entry(node, { intersectionRatio: 0.6 }), entry(node, { intersectionRatio: 1 })]);
    observer.cb([entry(node, { intersectionRatio: 1 })]);
    expect(onshown).toHaveBeenCalledTimes(1);
    expect(observer.disconnected).toBe(true);
  });

  it('does not count a card that only touches the edge', () => {
    const onshown = vi.fn();
    const node = document.createElement('div');
    shownPost(node, { onshown });
    observers[0].cb([entry(node, { isIntersecting: false })]);
    expect(onshown).not.toHaveBeenCalled();
  });

  it('counts a card taller than the scrolling box once it fills half of that box', () => {
    const onshown = vi.fn();
    const node = document.createElement('div');
    shownPost(node, { onshown });
    observers[0].cb([entry(node, { intersectionRatio: 0.3, intersectionRect: { height: 450 } })]);
    expect(onshown).toHaveBeenCalledTimes(1);
  });

  it('shares ONE observer between the cards of a scroll root, and notes those crossing together in one callback', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const nodes = [1, 2, 3].map(() => document.createElement('div'));
    shownPost(nodes[0], { onshown: a });
    shownPost(nodes[1], { onshown: b });
    shownPost(nodes[2], { onshown: c });
    expect(observers).toHaveLength(1);
    observers[0].cb([
      entry(nodes[0], { intersectionRatio: 1 }),
      entry(nodes[1], { intersectionRatio: 0.7 }),
    ]);
    expect([a, b, c].map((f) => f.mock.calls.length)).toEqual([1, 1, 0]);
    // The group stays while a card is still watched, and goes with the last one.
    expect(observers[0].disconnected).toBe(false);
  });

  it('stops watching a card that is destroyed before it was shown', () => {
    const onshown = vi.fn();
    const node = document.createElement('div');
    const action = shownPost(node, { onshown });
    action.destroy();
    expect(observers[0].observed.has(node)).toBe(false);
    expect(observers[0].disconnected).toBe(true);
  });

  it('fires at once without IntersectionObserver - a capability check, the card is drawn', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onshown = vi.fn();
    shownPost(document.createElement('div'), { onshown });
    expect(onshown).toHaveBeenCalledTimes(1);
  });
});
