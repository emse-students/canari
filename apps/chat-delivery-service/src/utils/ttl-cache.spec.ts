import { TtlCache } from './ttl-cache';

describe('TtlCache', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns a stored value and forgets it once the TTL has passed', () => {
    jest.useFakeTimers();
    const cache = new TtlCache<string>(10);

    cache.set('a', 'value', 1000);
    expect(cache.get('a')).toBe('value');

    jest.advanceTimersByTime(1001);
    expect(cache.get('a')).toBeUndefined();
    // The expired entry is dropped rather than left to accumulate.
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently USED entry, not the oldest written one', () => {
    const cache = new TtlCache<number>(2);

    cache.set('a', 1, 60_000);
    cache.set('b', 2, 60_000);
    // Reading 'a' makes 'b' the least recently used, so 'b' is what goes.
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3, 60_000);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('never grows past its ceiling', () => {
    const cache = new TtlCache<number>(3);
    for (let i = 0; i < 50; i++) cache.set(`k${i}`, i, 60_000);
    expect(cache.size).toBe(3);
  });

  it('treats an overwrite as a fresh insertion', () => {
    const cache = new TtlCache<number>(2);

    cache.set('a', 1, 60_000);
    cache.set('b', 2, 60_000);
    cache.set('a', 9, 60_000); // 'a' is now the most recent, so 'b' is next out
    cache.set('c', 3, 60_000);

    expect(cache.get('a')).toBe(9);
    expect(cache.get('b')).toBeUndefined();
  });
});
