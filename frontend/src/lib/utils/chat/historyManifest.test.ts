import { describe, it, expect } from 'vitest';
import {
  buildHistoryDigest,
  chunkIds,
  diffHistoryDigest,
  hashBucketIds,
  historyMonthOf,
  isEmptyHistoryDiff,
  parseHistoryDigest,
  selectEntryIdsForMonths,
  type HistoryEntry,
} from './historyManifest';

/** A message at `iso` with id `id` - the only two fields a manifest ever reads. */
function entry(id: string, iso: string): HistoryEntry {
  return { id, timestamp: Date.parse(iso) };
}

/** `count` entries spread one hour apart from `startIso`, for crossing the id/bucket threshold. */
function series(prefix: string, startIso: string, count: number): HistoryEntry[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(5, '0')}`,
    timestamp: start + i * 3_600_000,
  }));
}

describe('historyMonthOf', () => {
  it('buckets in UTC, not local time', () => {
    // 23:30 UTC on the last day of July is already August in Europe/Paris (CEST, +0200). The two
    // devices comparing these buckets are not guaranteed to share a timezone - and a phone that
    // travels does not even share one with itself - so a local month would put this message in a
    // different bucket on each side and re-send the month on every exchange, forever.
    expect(historyMonthOf(Date.parse('2026-07-31T23:30:00Z'))).toBe('2026-07');
    expect(historyMonthOf(Date.parse('2026-08-01T00:30:00Z'))).toBe('2026-08');
  });

  it('pads to YYYY-MM so the months sort as strings', () => {
    expect(historyMonthOf(Date.parse('2026-01-15T12:00:00Z'))).toBe('2026-01');
  });

  it('gives an unusable timestamp its own bucket rather than an Invalid Date', () => {
    // Both devices bucket a broken timestamp identically, so a corrupt row costs one shared bucket
    // instead of a month that can never agree.
    expect(historyMonthOf(Number.NaN)).toBe('0000-00');
    expect(historyMonthOf(0)).toBe('0000-00');
    expect(historyMonthOf(-1)).toBe('0000-00');
  });
});

describe('hashBucketIds', () => {
  it('is stable and truncated to 64 bits', async () => {
    const hash = await hashBucketIds(['a', 'b', 'c']);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashBucketIds(['a', 'b', 'c'])).toBe(hash);
  });

  it('separates ids so two different lists cannot serialise the same', async () => {
    expect(await hashBucketIds(['ab', 'c'])).not.toBe(await hashBucketIds(['a', 'bc']));
  });
});

describe('buildHistoryDigest', () => {
  it('answers an empty store with an empty ids digest, not with nothing', async () => {
    // "I hold no history" and "I did not answer" are different facts. Conflating them is what
    // forced the empty-bundle hack: every join of a brand-new conversation timed out into
    // pending-offline and re-solicited for the whole give-up horizon.
    expect(await buildHistoryDigest([])).toEqual({ mode: 'ids', ids: [] });
  });

  it('lists ids below the threshold and switches to buckets above it', async () => {
    const small = await buildHistoryDigest(series('m', '2026-01-01T00:00:00Z', 10), 10);
    expect(small.mode).toBe('ids');

    const large = await buildHistoryDigest(series('m', '2026-01-01T00:00:00Z', 11), 10);
    expect(large.mode).toBe('buckets');
  });

  it('keeps a buckets digest small whatever the history size', async () => {
    // Two years of messages, ~24 buckets, so the digest is bounded by the age of the conversation
    // and not by its size - which is the whole point of the mode.
    const digest = await buildHistoryDigest(series('m', '2026-01-01T00:00:00Z', 5000), 100);
    if (digest.mode !== 'buckets') throw new Error('expected buckets mode');
    expect(digest.buckets.length).toBeLessThan(40);
    expect(JSON.stringify(digest).length).toBeLessThan(4000);
    expect(digest.buckets.reduce((n, b) => n + b.count, 0)).toBe(5000);
  });

  it('does not depend on the order the store returned the rows in', async () => {
    // Both sides sort before hashing, so a store that iterates differently must still agree.
    const rows = series('m', '2026-01-01T00:00:00Z', 200);
    const shuffled = [...rows].reverse();
    expect(await buildHistoryDigest(shuffled, 50)).toEqual(await buildHistoryDigest(rows, 50));
  });

  it('deduplicates ids so a doubled row cannot make two stores disagree invisibly', async () => {
    const digest = await buildHistoryDigest([
      entry('a', '2026-01-01T00:00:00Z'),
      entry('a', '2026-01-01T00:00:00Z'),
      entry('b', '2026-01-02T00:00:00Z'),
    ]);
    expect(digest).toEqual({ mode: 'ids', ids: ['a', 'b'] });
  });
});

describe('diffHistoryDigest - ids mode', () => {
  const local = [entry('a', '2026-01-01T00:00:00Z'), entry('b', '2026-01-02T00:00:00Z')];

  it('reports nothing when both sides hold the same messages', async () => {
    const diff = await diffHistoryDigest(local, await buildHistoryDigest(local));
    expect(isEmptyHistoryDiff(diff)).toBe(true);
  });

  it('names both directions in one exchange', async () => {
    const remote = [entry('b', '2026-01-02T00:00:00Z'), entry('c', '2026-01-03T00:00:00Z')];
    const diff = await diffHistoryDigest(local, await buildHistoryDigest(remote));
    expect(diff.missingLocally).toEqual(['c']);
    expect(diff.missingOnPeer).toEqual(['a']);
  });

  it('asks for everything when the local store is empty', async () => {
    const diff = await diffHistoryDigest([], await buildHistoryDigest(local));
    expect(diff.missingLocally).toEqual(['a', 'b']);
    expect(diff.missingOnPeer).toEqual([]);
  });

  it('offers everything when the peer is the empty one', async () => {
    const diff = await diffHistoryDigest(local, { mode: 'ids', ids: [] });
    expect(diff.missingLocally).toEqual([]);
    expect(diff.missingOnPeer).toEqual(['a', 'b']);
  });
});

describe('diffHistoryDigest - buckets mode', () => {
  /** Forces buckets mode regardless of size, so the month logic can be tested on small fixtures. */
  const asBuckets = (entries: HistoryEntry[]) => buildHistoryDigest(entries, -1);

  it('pulls a month only the peer has, and pushes one only we have', async () => {
    const local = [entry('jan', '2026-01-10T00:00:00Z')];
    const remote = [entry('feb', '2026-02-10T00:00:00Z')];
    const diff = await diffHistoryDigest(local, await asBuckets(remote));
    expect(diff.pullMonths).toEqual(['2026-02']);
    expect(diff.pushMonths).toEqual(['2026-01']);
  });

  it('reports nothing for a month both sides hold identically', async () => {
    const rows = [entry('a', '2026-03-01T00:00:00Z'), entry('b', '2026-03-02T00:00:00Z')];
    const diff = await diffHistoryDigest(rows, await asBuckets(rows));
    expect(isEmptyHistoryDiff(diff)).toBe(true);
  });

  it('detects a month with the same COUNT but different messages', async () => {
    // The reason a bucket carries a fingerprint at all: a count that matches proves nothing, and a
    // count-only digest would declare this month settled and lose both messages for good.
    const local = [entry('a', '2026-03-01T00:00:00Z'), entry('b', '2026-03-02T00:00:00Z')];
    const remote = [entry('a', '2026-03-01T00:00:00Z'), entry('c', '2026-03-02T00:00:00Z')];
    const diff = await diffHistoryDigest(local, await asBuckets(remote));
    expect(diff.pullMonths).toEqual(['2026-03']);
    expect(diff.pushMonths).toEqual(['2026-03']);
  });

  it('sends a differing month in BOTH directions, because a fingerprint cannot say who is short', async () => {
    const local = [entry('a', '2026-03-01T00:00:00Z'), entry('b', '2026-03-02T00:00:00Z')];
    const remote = [entry('a', '2026-03-01T00:00:00Z')];
    const diff = await diffHistoryDigest(local, await asBuckets(remote));
    // We are strictly ahead here, yet the month is still pulled: guessing from the hashes would be
    // guessing, and guessing wrong drops messages. Over-sending is bandwidth, and the receiver
    // dedupes by id.
    expect(diff.pullMonths).toEqual(['2026-03']);
    expect(diff.pushMonths).toEqual(['2026-03']);
  });

  it('turns a month-boundary clock skew into a re-send, never into a loss', async () => {
    // The same message, timestamped either side of midnight UTC on the two devices (the sender's
    // clock versus the server's). Both months read as different, both are exchanged, the receiver
    // dedupes by id - the id never disappears.
    const local = [entry('edge', '2026-07-31T23:59:59Z')];
    const remote = [entry('edge', '2026-08-01T00:00:01Z')];
    const diff = await diffHistoryDigest(local, await asBuckets(remote));
    expect(diff.pullMonths).toEqual(['2026-08']);
    expect(diff.pushMonths).toEqual(['2026-07']);
  });

  it('leaves the id lists empty - a bucket diff resolves to a month, never to a message', async () => {
    const diff = await diffHistoryDigest(
      [entry('a', '2026-01-10T00:00:00Z')],
      await asBuckets([entry('b', '2026-02-10T00:00:00Z')])
    );
    expect(diff.missingLocally).toEqual([]);
    expect(diff.missingOnPeer).toEqual([]);
  });
});

describe('selectEntryIdsForMonths', () => {
  const rows = [
    entry('jan1', '2026-01-05T00:00:00Z'),
    entry('jan2', '2026-01-06T00:00:00Z'),
    entry('feb1', '2026-02-05T00:00:00Z'),
  ];

  it('collects every local id in the requested months', () => {
    expect(selectEntryIdsForMonths(rows, ['2026-01'])).toEqual(['jan1', 'jan2']);
  });

  it('ignores a month it holds nothing for', () => {
    expect(selectEntryIdsForMonths(rows, ['2026-05'])).toEqual([]);
  });

  it('returns nothing for an empty request rather than everything', () => {
    // A pull that names no month must move no data: the alternative is a full bundle sent by
    // accident, which is exactly what this work package exists to retire.
    expect(selectEntryIdsForMonths(rows, [])).toEqual([]);
  });
});

describe('parseHistoryDigest', () => {
  it('accepts a digest this module produced, in either mode', async () => {
    const ids = await buildHistoryDigest([entry('a', '2026-01-01T00:00:00Z')]);
    expect(parseHistoryDigest(JSON.parse(JSON.stringify(ids)))).toEqual(ids);

    const buckets = await buildHistoryDigest([entry('a', '2026-01-01T00:00:00Z')], -1);
    expect(parseHistoryDigest(JSON.parse(JSON.stringify(buckets)))).toEqual(buckets);
  });

  it('accepts an empty ids digest - "I hold nothing" is a valid claim', () => {
    expect(parseHistoryDigest({ mode: 'ids', ids: [] })).toEqual({ mode: 'ids', ids: [] });
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an unknown mode', { mode: 'magic', ids: [] }],
    ['no mode at all', { ids: [] }],
    ['ids that are not an array', { mode: 'ids', ids: 'a,b' }],
    ['a non-string id', { mode: 'ids', ids: ['a', 42] }],
    ['a blank id', { mode: 'ids', ids: ['a', '  '] }],
    ['buckets that are not an array', { mode: 'buckets', buckets: {} }],
    ['a malformed month', { mode: 'buckets', buckets: [{ month: 'jan', count: 1, hash: 'ab' }] }],
    [
      'a negative count',
      { mode: 'buckets', buckets: [{ month: '2026-01', count: -1, hash: 'ab' }] },
    ],
    [
      'a fractional count',
      { mode: 'buckets', buckets: [{ month: '2026-01', count: 1.5, hash: 'ab' }] },
    ],
    ['a non-hex hash', { mode: 'buckets', buckets: [{ month: '2026-01', count: 1, hash: 'zz' }] }],
    ['a missing hash', { mode: 'buckets', buckets: [{ month: '2026-01', count: 1 }] }],
  ])('rejects %s', (_label, payload) => {
    expect(parseHistoryDigest(payload)).toBeNull();
  });

  it('refuses a digest large enough to be an allocation attack', () => {
    // MLS authenticates WHICH co-member sent this; it says nothing about the JSON inside.
    const flood = Array.from({ length: 5001 }, (_, i) => `id-${i}`);
    expect(parseHistoryDigest({ mode: 'ids', ids: flood })).toBeNull();
  });
});

describe('chunkIds', () => {
  it('splits an unbounded diff into frames an MLS message can carry', () => {
    expect(chunkIds(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('produces no frame at all for an empty diff', () => {
    expect(chunkIds([], 500)).toEqual([]);
  });

  it('refuses a zero size instead of looping forever', () => {
    expect(() => chunkIds(['a'], 0)).toThrow();
  });
});
