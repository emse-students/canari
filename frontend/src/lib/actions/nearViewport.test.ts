import { describe, it, expect, vi, afterEach } from 'vitest';
import { nearViewport } from './nearViewport';

/**
 * A stand-in for the real observer that keeps what the action does OBSERVABLE: which callback was
 * registered, with which margin, and whether it was disconnected.
 */
class FakeObserver {
  static last: FakeObserver | null = null;
  observed: Element[] = [];
  disconnected = 0;

  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit
  ) {
    FakeObserver.last = this;
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
