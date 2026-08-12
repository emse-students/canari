/**
 * The cache in front of the state key, and the one rule that makes it safe.
 *
 * **A stale key claiming agreement loses messages silently; an over-eager invalidation costs one
 * store walk.** The two failure modes are not comparable, so every case here is written from the
 * pessimistic side: the question is never "does it cache enough", it is "can it ever answer from a
 * store that has changed underneath it".
 *
 * The invalidation itself lives at the storage layer rather than at the call sites, and
 * `historyStateKey.invalidation.test.ts` reads the source to keep it that way - a cache invalidated
 * by whoever remembers to is a cache that goes stale on the path nobody thought about.
 */
import type { StoredMessage } from '$lib/db';
import {
  cachedHistoryStateKey,
  historyStateKey,
  invalidateHistoryStateKey,
  invalidateAllHistoryStateKeys,
} from './historyStateKey';

const GROUP = 'g1';
const OTHER = 'g2';
const T = 1_700_000_000_000;

const msg = (id: string, over: Partial<StoredMessage> = {}): StoredMessage =>
  ({
    id,
    conversationId: GROUP,
    senderId: 'u',
    content: 'x',
    timestamp: T,
    ...over,
  }) as StoredMessage;

/** A loader that counts its calls, so "did it walk the store" is observable. */
function loader(rows: readonly StoredMessage[] | null) {
  return vi.fn().mockResolvedValue(rows);
}

beforeEach(() => invalidateAllHistoryStateKeys());

describe('cachedHistoryStateKey', () => {
  it('walks the store once and answers the same key from memory afterwards', async () => {
    const load = loader([msg('m1'), msg('m2')]);

    const first = await cachedHistoryStateKey(GROUP, 0, load);
    const second = await cachedHistoryStateKey(GROUP, 0, load);

    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('agrees with the uncached rule - the cache may not be a second implementation', async () => {
    const rows = [msg('m1'), msg('m2', { isDeleted: true })];
    expect(await cachedHistoryStateKey(GROUP, 0, loader(rows))).toBe(
      await historyStateKey(rows, 0)
    );
  });

  it('re-walks when the WINDOW moved, because the key is only valid for one', async () => {
    // `since` rounds down to the day, so it shifts once a day under a running client. A key computed
    // over a wider range is not an answer about a narrower one, and comparing across the two would
    // report a difference that does not exist.
    const load = loader([msg('m1')]);

    await cachedHistoryStateKey(GROUP, 0, load);
    await cachedHistoryStateKey(GROUP, T - 1, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keys the cache per conversation', async () => {
    const a = loader([msg('m1')]);
    const b = loader([msg('m2')]);

    const ka = await cachedHistoryStateKey(GROUP, 0, a);
    const kb = await cachedHistoryStateKey(OTHER, 0, b);

    expect(ka).not.toBe(kb);
    expect(await cachedHistoryStateKey(GROUP, 0, a)).toBe(ka);
  });

  it('caches NOTHING when the store could not be read', async () => {
    // A failed read is not an empty store. Caching it would tell every peer, for as long as the
    // entry lived, that this device holds exactly nothing.
    const load = loader(null);

    expect(await cachedHistoryStateKey(GROUP, 0, load)).toBeNull();
    await cachedHistoryStateKey(GROUP, 0, load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('caches an EMPTY store, which is a real answer', async () => {
    const load = loader([]);

    expect(await cachedHistoryStateKey(GROUP, 0, load)).toBe(await historyStateKey([], 0));
    await cachedHistoryStateKey(GROUP, 0, load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('invalidation', () => {
  it('re-walks after the conversation is invalidated', async () => {
    const load = loader([msg('m1')]);
    const before = await cachedHistoryStateKey(GROUP, 0, load);

    invalidateHistoryStateKey(GROUP);
    load.mockResolvedValue([msg('m1'), msg('m2')]);
    const after = await cachedHistoryStateKey(GROUP, 0, load);

    expect(after).not.toBe(before);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('invalidates ONLY the conversation named', async () => {
    const a = loader([msg('m1')]);
    const b = loader([msg('m2')]);
    await cachedHistoryStateKey(GROUP, 0, a);
    await cachedHistoryStateKey(OTHER, 0, b);

    invalidateHistoryStateKey(GROUP);

    await cachedHistoryStateKey(OTHER, 0, b);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('drops everything when a write cannot name a conversation', async () => {
    // `deleteOldMessages` and `clear` span the whole store, so there is no id to be selective with.
    // Dropping everything costs one walk per conversation and is the only safe reading.
    const a = loader([msg('m1')]);
    const b = loader([msg('m2')]);
    await cachedHistoryStateKey(GROUP, 0, a);
    await cachedHistoryStateKey(OTHER, 0, b);

    invalidateAllHistoryStateKeys();

    await cachedHistoryStateKey(GROUP, 0, a);
    await cachedHistoryStateKey(OTHER, 0, b);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('is harmless on a conversation that was never cached', () => {
    expect(() => invalidateHistoryStateKey('never-seen')).not.toThrow();
  });
});
