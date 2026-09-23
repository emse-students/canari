import { forgetReaderCaches, registerPerReaderCache, SharedCache } from './sharedCache';

/**
 * THE TWO MECHANISMS ARE ASSERTED SEPARATELY, because they cover different defects and a test that
 * conflated them would pass with either one missing: the TTL is what makes a tab switch free, the
 * in-flight join is what collapses N tiles mounting in the same frame into one request.
 *
 * The third assertion is the one that matters most in the field: a rejection is never held.
 */
describe('SharedCache', () => {
  it('asks once and serves the held answer while it is fresh', async () => {
    const cache = new SharedCache<number>(10_000);
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return Promise.resolve(42);
    };

    expect(await cache.load('k', fetcher)).toBe(42);
    expect(await cache.load('k', fetcher)).toBe(42);
    expect(calls).toBe(1);
  });

  it('joins callers that arrive while a request is in flight', async () => {
    const cache = new SharedCache<string>(10_000);
    let calls = 0;
    let release: (v: string) => void = () => {};
    const fetcher = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };

    const a = cache.load('k', fetcher);
    const b = cache.load('k', fetcher);
    const c = cache.load('k', fetcher);
    expect(calls).toBe(1);

    release('one answer');
    expect(await Promise.all([a, b, c])).toEqual(['one answer', 'one answer', 'one answer']);
  });

  it('never holds a rejection, and the next caller asks again', async () => {
    const cache = new SharedCache<number>(10_000);
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('link dropped')) : Promise.resolve(7);
    };

    await expect(cache.load('k', fetcher)).rejects.toThrow('link dropped');
    expect(await cache.load('k', fetcher)).toBe(7);
    expect(calls).toBe(2);
  });

  it('keys are independent', async () => {
    const cache = new SharedCache<string>(10_000);
    expect(await cache.load('a', () => Promise.resolve('A'))).toBe('A');
    expect(await cache.load('b', () => Promise.resolve('B'))).toBe('B');
    expect(await cache.load('a', () => Promise.reject(new Error('not asked')))).toBe('A');
  });

  it('expires an answer once its window has passed', async () => {
    vi.useFakeTimers();
    try {
      const cache = new SharedCache<number>(1_000);
      let calls = 0;
      const fetcher = () => {
        calls += 1;
        return Promise.resolve(calls);
      };

      expect(await cache.load('k', fetcher)).toBe(1);
      vi.advanceTimersByTime(999);
      expect(await cache.load('k', fetcher)).toBe(1);
      vi.advanceTimersByTime(2);
      expect(await cache.load('k', fetcher)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('put seeds the answer a write already holds, with no request at all', async () => {
    const cache = new SharedCache<string>(10_000);
    cache.put('k', 'the row the server just wrote');
    expect(await cache.load('k', () => Promise.reject(new Error('not asked')))).toBe(
      'the row the server just wrote'
    );
  });

  it('a per-reader cache is forgotten when the reader changes, and a plain one is not', async () => {
    const mine = new SharedCache<string>(10_000, { perReader: true });
    const everyones = new SharedCache<string>(10_000);
    mine.put('me', 'my memberships');
    everyones.put('all', 'the directory');

    forgetReaderCaches();

    expect(await mine.load('me', () => Promise.resolve('asked again'))).toBe('asked again');
    expect(await everyones.load('all', () => Promise.reject(new Error('not asked')))).toBe(
      'the directory'
    );
  });

  it('forgets state that is not a cache at all, once registered', () => {
    let probe: string | null = 'the previous account';
    registerPerReaderCache(() => {
      probe = null;
    });

    forgetReaderCaches();

    expect(probe).toBeNull();
  });

  it('invalidate drops one key, or everything', async () => {
    const cache = new SharedCache<string>(10_000);
    cache.put('a', 'A');
    cache.put('b', 'B');

    cache.invalidate('a');
    expect(await cache.load('a', () => Promise.resolve('A2'))).toBe('A2');
    expect(await cache.load('b', () => Promise.reject(new Error('not asked')))).toBe('B');

    cache.invalidate();
    expect(await cache.load('b', () => Promise.resolve('B2'))).toBe('B2');
  });
});
