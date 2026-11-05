// @vitest-environment happy-dom
/**
 * THE MOVE FOLLOWER: an element that MOVES with its size untouched is reported, and the follower
 * re-frames itself around the new box so the NEXT move is reported too. The observer is a fake that
 * records the root margin it was armed with - the real one is exercised in a browser (see the wiki).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeElementMoves } from './guideAnchorFollow';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {} } }));

interface FakeObserver {
  options: IntersectionObserverInit;
  callback: IntersectionObserverCallback;
  disconnected: boolean;
}
const observers: FakeObserver[] = [];

beforeEach(() => {
  observers.length = 0;
  class Fake {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      observers.push({ options, callback, disconnected: false });
      this.record = observers[observers.length - 1];
    }
    record: FakeObserver;
    observe() {}
    disconnect() {
      this.record.disconnected = true;
    }
  }
  vi.stubGlobal('IntersectionObserver', Fake);
  resizeCallbacks.length = 0;
  class FakeResize {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(callback);
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', FakeResize);
  setViewport(1280, 800);
});

const resizeCallbacks: ResizeObserverCallback[] = [];

function setViewport(width: number, height: number): void {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    value: height,
    configurable: true,
  });
}

/** Delivers a resize observation for `node`, as the browser does when its size changes. */
function fireResize(node: Element): void {
  for (const callback of resizeCallbacks) {
    callback([{ target: node } as ResizeObserverEntry], {} as ResizeObserver);
  }
}

afterEach(() => vi.unstubAllGlobals());

function target(box: { left: number; top: number; width: number; height: number }) {
  const el = document.createElement('button');
  const state = { ...box };
  el.getBoundingClientRect = () => state as DOMRect;
  return { el, state };
}

/** Delivers one observation: the ratio the browser would report for the latest observer. */
function fire(ratio: number): void {
  const last = observers[observers.length - 1];
  last.callback([{ intersectionRatio: ratio } as IntersectionObserverEntry], {} as never);
}

describe('observeElementMoves', () => {
  it('frames the viewport to exactly the element box', () => {
    const { el } = target({ left: 300, top: 10, width: 120, height: 40 });
    observeElementMoves(el, () => {});
    // top right bottom left, as negative insets: 10, 1280-420, 800-50, 300.
    expect(observers[0].options.rootMargin).toBe('-10px -860px -750px -300px');
  });

  it('reports a move that changed no size, and re-frames around the new box', () => {
    const { el, state } = target({ left: 300, top: 50, width: 120, height: 40 });
    const onMove = vi.fn();
    observeElementMoves(el, onMove);
    fire(1); // the state at observation time: not a move
    expect(onMove).not.toHaveBeenCalled();

    state.top = 10; // content above settled: the button moved up, same size
    fire(0.5);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(observers[0].disconnected).toBe(true);
    expect(observers[1].options.rootMargin).toBe('-10px -860px -750px -300px');

    fire(1);
    state.left = 333;
    fire(0.4); // and the next move is seen too
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it('stops for good', () => {
    const { el } = target({ left: 0, top: 0, width: 10, height: 10 });
    const stop = observeElementMoves(el, () => {});
    stop();
    expect(observers[0].disconnected).toBe(true);
  });

  it('observes nothing for an element with no box', () => {
    const { el } = target({ left: 0, top: 0, width: 0, height: 0 });
    observeElementMoves(el, () => {});
    expect(observers).toHaveLength(0);
  });

  it('re-frames when the window grows, which the old frame cannot see', () => {
    const { el } = target({ left: 300, top: 10, width: 120, height: 40 });
    const onMove = vi.fn();
    observeElementMoves(el, onMove);
    fireResize(document.documentElement); // nothing changed yet: the frame still fits
    expect(onMove).not.toHaveBeenCalled();

    setViewport(1600, 900);
    fireResize(document.documentElement);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(observers[observers.length - 1].options.rootMargin).toBe('-10px -1180px -850px -300px');
  });

  it('re-frames an element that had no box when it gains one', () => {
    const { el, state } = target({ left: 0, top: 0, width: 0, height: 0 });
    const onMove = vi.fn();
    observeElementMoves(el, onMove);
    fireResize(el); // still no box: nothing to frame
    expect(observers).toHaveLength(0);

    Object.assign(state, { left: 300, top: 10, width: 120, height: 40 });
    fireResize(el);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(observers).toHaveLength(1);
    expect(observers[0].options.rootMargin).toBe('-10px -860px -750px -300px');
  });

  it('settles on the ratio of a target clipped by an ancestor scroller', () => {
    const { el, state } = target({ left: 300, top: 10, width: 120, height: 40 });
    const onMove = vi.fn();
    observeElementMoves(el, onMove);
    fire(0.6); // clipped from the start: the baseline is the ratio seen, not a move
    expect(onMove).not.toHaveBeenCalled();
    expect(observers).toHaveLength(2);
    expect(observers[1].options.threshold).toBe(0.6);

    fire(0.6); // the re-armed observer's own first report: settled after two arms
    expect(observers).toHaveLength(2);

    state.top = 20; // a move is still seen against the clipped ratio
    fire(0.3);
    expect(onMove).toHaveBeenCalledTimes(1);
  });
});
