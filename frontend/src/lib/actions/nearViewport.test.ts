// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { nearViewport } from './nearViewport';

/**
 * A stand-in for the real observer that keeps what the action does OBSERVABLE: which callback was
 * registered, with which margin, and whether it was disconnected.
 */
class FakeObserver {
  static last: FakeObserver | null = null;
  static all: FakeObserver[] = [];
  observed: Element[] = [];
  disconnected = 0;

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit
  ) {
    FakeObserver.last = this;
    FakeObserver.all.push(this);
  }

  observe(el: Element) {
    this.observed.push(el);
  }

  disconnect() {
    this.disconnected += 1;
  }

  /** Reports the node as intersecting, the way a scroll into range would. */
  enter() {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }

  /** Reports it leaving, which must decide nothing. */
  leave() {
    this.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
}

const realObserver = globalThis.IntersectionObserver;

function useFakeObserver() {
  FakeObserver.last = null;
  FakeObserver.all = [];
  vi.stubGlobal('IntersectionObserver', FakeObserver);
}

afterEach(() => {
  vi.stubGlobal('IntersectionObserver', realObserver);
  vi.unstubAllGlobals();
});

describe('nearViewport', () => {
  it('does not call back before the node is anywhere near', () => {
    useFakeObserver();
    const onnear = vi.fn();
    nearViewport(document.createElement('a'), { onnear });

    expect(onnear).not.toHaveBeenCalled();
    expect(FakeObserver.last?.observed).toHaveLength(1);
  });

  it('calls back once the node comes near', () => {
    useFakeObserver();
    const onnear = vi.fn();
    nearViewport(document.createElement('a'), { onnear });

    FakeObserver.last!.enter();

    expect(onnear).toHaveBeenCalledTimes(1);
  });

  it('fires ONCE and disconnects, so scrolling past does not re-ask', () => {
    useFakeObserver();
    const onnear = vi.fn();
    nearViewport(document.createElement('a'), { onnear });

    FakeObserver.last!.enter();
    FakeObserver.last!.enter();

    expect(onnear).toHaveBeenCalledTimes(1);
    expect(FakeObserver.last!.disconnected).toBe(1);
  });

  it('decides nothing on a node leaving the viewport', () => {
    useFakeObserver();
    const onnear = vi.fn();
    nearViewport(document.createElement('a'), { onnear });

    FakeObserver.last!.leave();

    expect(onnear).not.toHaveBeenCalled();
  });

  it('looks ahead of the viewport rather than at its edge', () => {
    useFakeObserver();
    nearViewport(document.createElement('a'), { onnear: () => {} });

    expect(FakeObserver.last?.options?.rootMargin).toBe('400px');
  });

  it('honours a caller that asks for a different distance', () => {
    useFakeObserver();
    nearViewport(document.createElement('a'), { onnear: () => {}, rootMargin: '0px' });

    expect(FakeObserver.last?.options?.rootMargin).toBe('0px');
  });

  it('disconnects when the node goes away, even having never fired', () => {
    useFakeObserver();
    const handle = nearViewport(document.createElement('a'), { onnear: () => {} });

    handle.destroy();

    expect(FakeObserver.last!.disconnected).toBe(1);
  });

  it('calls the callback the component most recently handed it', () => {
    useFakeObserver();
    const first = vi.fn();
    const second = vi.fn();
    const handle = nearViewport(document.createElement('a'), { onnear: first });

    handle.update({ onnear: second });
    FakeObserver.last!.enter();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  /**
   * TWO-WAY WHEN THE CALLER HAS SOMETHING TO GIVE BACK: a feed video releases its stream and its
   * decoder on leaving the band, and takes them again on return (reels audit, 2026-10-11).
   */
  it('with onleave, stays connected and reports each entry and each exit once', () => {
    useFakeObserver();
    const onnear = vi.fn();
    const onleave = vi.fn();
    nearViewport(document.createElement('a'), { onnear, onleave });
    const [near, far] = FakeObserver.all;

    far.leave();
    expect(onleave).not.toHaveBeenCalled();

    near.enter();
    near.enter();
    far.leave();
    far.leave();
    near.enter();

    expect(onnear).toHaveBeenCalledTimes(2);
    expect(onleave).toHaveBeenCalledTimes(1);
    expect(near.disconnected + far.disconnected).toBe(0);
  });

  /**
   * HYSTERESIS (review of #1744): with one edge, a card resting on it reopened its stream and
   * refetched its 2 MiB head on every small scroll. It leaves only past a FARTHER edge.
   */
  it('leaves only past a farther edge than the one it entered by', () => {
    useFakeObserver();
    const onnear = vi.fn();
    const onleave = vi.fn();
    nearViewport(document.createElement('a'), { onnear, onleave });
    const [near, far] = FakeObserver.all;

    expect(near.options?.rootMargin).toBe('400px');
    expect(far.options?.rootMargin).toBe('1200px');

    near.enter();
    // Back out past the entry edge, still inside the exit edge: the near observer reports it,
    // and nothing is given back.
    near.leave();
    near.enter();
    expect(onleave).not.toHaveBeenCalled();
    expect(onnear).toHaveBeenCalledTimes(1);

    far.leave();
    expect(onleave).toHaveBeenCalledTimes(1);
  });

  it('observes in the scrolling box the node moves in, so the margin is not clipped away', () => {
    useFakeObserver();
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const node = document.createElement('a');
    scroller.appendChild(node);
    document.body.appendChild(scroller);

    nearViewport(node, { onnear: () => {} });

    expect(FakeObserver.last?.options?.root).toBe(scroller);
    scroller.remove();
  });

  /**
   * NOT A FALLBACK PATH: no primary path failed, the environment simply cannot answer. Saying "yes"
   * is what every caller did before this action existed, and it is what keeps a preview from never
   * loading at all where the API is absent.
   */
  it('fires immediately where the browser has no observer at all', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onnear = vi.fn();

    nearViewport(document.createElement('a'), { onnear });

    expect(onnear).toHaveBeenCalledTimes(1);
  });
});
