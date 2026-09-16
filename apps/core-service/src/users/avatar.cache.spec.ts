import { AvatarCache, isCacheableAbsence, type AvatarAnswer } from './avatar.cache';

/** An image answer with a recognisable body, so eviction can be asserted on identity. */
const image = (marker: string, etag?: string): AvatarAnswer => ({
  kind: 'image',
  body: Buffer.from(marker),
  contentType: 'image/jpeg',
  ...(etag ? { etag } : {}),
});

/**
 * The FRESH answer only, which is the whole of what the cache used to be able to say.
 *
 * Every assertion below that predates the revalidatable state reads through this, so the expiry
 * rules it proves are unchanged by the third state rather than quietly re-specified by it.
 */
const fresh = (cache: AvatarCache, id: string): AvatarAnswer | null => {
  const found = cache.lookup(id);
  return found.state === 'fresh' ? found.answer : null;
};

/**
 * THE CLOCK IS DRIVEN, NEVER WAITED FOR. Every expiry below is asserted by moving `clock` across
 * the boundary, so the suite has no sleep in it and cannot go flaky on a slow machine.
 */
function makeCache(
  overrides: Partial<{ imageTtlMs: number; absentTtlMs: number; maxEntries: number }> = {}
) {
  let clock = 1_000;
  const cache = new AvatarCache({
    imageTtlMs: 60_000,
    absentTtlMs: 10_000,
    maxEntries: 3,
    now: () => clock,
    ...overrides,
  });
  return { cache, advance: (ms: number) => (clock += ms) };
}

describe('isCacheableAbsence', () => {
  it('accepts only the upstream 404, because only that one is an answer about the avatar', () => {
    expect(isCacheableAbsence(404)).toBe(true);
    for (const status of [401, 403, 429, 500, 502, 503]) {
      expect(isCacheableAbsence(status)).toBe(false);
    }
  });
});

describe('AvatarCache', () => {
  it('returns a stored answer before its TTL and nothing after it', () => {
    const { cache, advance } = makeCache();
    cache.set('u1', image('a'));

    advance(59_999);
    expect(fresh(cache, 'u1')).toEqual(image('a'));

    advance(1);
    expect(fresh(cache, 'u1')).toBeNull();
  });

  it('expires an absence sooner than an image, because a user may add a photo', () => {
    const { cache, advance } = makeCache();
    cache.set('withPhoto', image('a'));
    cache.set('without', { kind: 'absent' });

    advance(10_001);
    expect(fresh(cache, 'without')).toBeNull();
    expect(fresh(cache, 'withPhoto')).toEqual(image('a'));
  });

  it('drops an expired slot on read, so an abandoned key cannot pin its payload', () => {
    const { cache, advance } = makeCache();
    cache.set('u1', image('a'));
    advance(60_001);

    expect(cache.size).toBe(1);
    expect(fresh(cache, 'u1')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('evicts the oldest WRITE once the ceiling is passed', () => {
    const { cache } = makeCache();
    cache.set('u1', image('1'));
    cache.set('u2', image('2'));
    cache.set('u3', image('3'));
    cache.set('u4', image('4'));

    expect(cache.size).toBe(3);
    expect(fresh(cache, 'u1')).toBeNull();
    expect(fresh(cache, 'u4')).toEqual(image('4'));
  });

  it('re-writing a key makes it the youngest, so a refreshed entry is not the next evicted', () => {
    const { cache } = makeCache();
    cache.set('u1', image('1'));
    cache.set('u2', image('2'));
    cache.set('u3', image('3'));
    cache.set('u1', image('1bis'));
    cache.set('u4', image('4'));

    expect(fresh(cache, 'u1')).toEqual(image('1bis'));
    expect(fresh(cache, 'u2')).toBeNull();
  });

  /**
   * AN EXPIRED PHOTO IS NOT THE SAME AS NO PHOTO, and telling them apart is what turns an hourly
   * re-download of every face into an hourly empty 304.
   */
  it('offers an expired image for revalidation when it carries a version, bytes and all', () => {
    const { cache, advance } = makeCache();
    cache.set('u1', image('a', '"asset-7"'));
    advance(60_001);

    const found = cache.lookup('u1');
    expect(found.state).toBe('stale');
    if (found.state !== 'stale') throw new Error('unreachable');
    expect(found.answer.etag).toBe('"asset-7"');
    // The bytes are the point: a 304 sends none, so the entry must still be able to answer.
    expect(found.answer.body).toEqual(Buffer.from('a'));
    expect(cache.size).toBe(1);
  });

  it('drops an expired image that carries no version, because nothing could confirm it', () => {
    const { cache, advance } = makeCache();
    cache.set('u1', image('a'));
    advance(60_001);

    expect(cache.lookup('u1').state).toBe('miss');
    expect(cache.size).toBe(0);
  });

  it('never calls an absence stale - there is no version of a photo that does not exist', () => {
    const { cache, advance } = makeCache();
    cache.set('u1', { kind: 'absent' });
    advance(10_001);

    expect(cache.lookup('u1').state).toBe('miss');
    expect(cache.size).toBe(0);
  });
});
