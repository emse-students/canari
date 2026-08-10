import { describe, it, expect } from 'vitest';
import {
  buildHistoryDigest,
  chunkIds,
  diffHistoryDigest,
  hashIdList,
  historyRangeOf,
  isEmptyHistoryDiff,
  parseHistoryDigest,
  rangeDepthFor,
  selectEntryIdsForPrefixes,
  type HistoryEntry,
} from './historyManifest';

/** A message at `iso` with id `id` - the only two fields a manifest ever reads. */
function entry(id: string, iso: string): HistoryEntry {
  return { id, timestamp: Date.parse(iso) };
}

/**
 * `count` distinct ids that all land in the SAME slice at `depth`.
 *
 * Found by enumeration rather than hand-picked: the partition is a hash, so which ids collide is not
 * something a fixture can state, and a test that assumed a collision would silently stop testing the
 * case it was written for the day the hash changed.
 */
function sameSlice(count: number, depth: number): string[] {
  const groups = new Map<string, string[]>();
  for (let i = 0; i < 5000; i++) {
    const id = `fixture-${i}`;
    const key = historyRangeOf(id, depth);
    const group = groups.get(key) ?? [];
    group.push(id);
    if (group.length >= count) return group.slice(0, count);
    groups.set(key, group);
  }
  throw new Error(`sameSlice: no ${count} ids share a depth-${depth} slice`);
}

/** `count` entries spread one hour apart from `startIso`, for crossing the id/range threshold. */
function series(prefix: string, startIso: string, count: number): HistoryEntry[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(5, '0')}`,
    timestamp: start + i * 3_600_000,
  }));
}

describe('historyRangeOf', () => {
  it('is stable, hex, and exactly as long as the depth asked for', () => {
    expect(historyRangeOf('abc', 1)).toMatch(/^[0-9a-f]$/);
    expect(historyRangeOf('abc', 3)).toMatch(/^[0-9a-f]{3}$/);
    expect(historyRangeOf('abc', 2)).toBe(historyRangeOf('abc', 2));
  });

  it('nests: a deeper prefix extends the shallower one', () => {
    // What makes the depth a wire field rather than a local choice - a slice at depth 2 is contained
    // in exactly one slice at depth 1, so the two devices only ever disagree about GRANULARITY.
    expect(
      historyRangeOf('some-message-id', 3).startsWith(historyRangeOf('some-message-id', 1))
    ).toBe(true);
  });

  it('ignores the TIMESTAMP entirely - the id is the only thing both devices agree on', () => {
    // The whole reason the unit is a slice of the id space: a message's stored timestamp can differ
    // between two devices (the sender's clock against the server's), and a partition that used it
    // would put the same message in different slices, making both disagree on every exchange forever.
    expect(historyRangeOf('same-id', 2)).toBe(historyRangeOf('same-id', 2));
  });

  it('spreads ids that share a long common prefix', () => {
    // Slicing the id itself would work for UUIDs and pile a derived-id conversation (channel invite
    // ids and friends) into one slice, degenerating the diff back into a full bundle.
    const slices = new Set(
      Array.from({ length: 64 }, (_, i) => historyRangeOf(`invite-channel-abc-${i}`, 1))
    );
    expect(slices.size).toBeGreaterThan(8);
  });
});

describe('rangeDepthFor', () => {
  it('grows with the store so a slice keeps holding about the same number of messages', () => {
    expect(rangeDepthFor(1_000)).toBe(1);
    expect(rangeDepthFor(10_000)).toBe(2);
    expect(rangeDepthFor(1_000_000)).toBe(3);
  });

  it('is capped, so the digest has a size bound rather than an extra round trip', () => {
    // Past the cap slices simply get fatter: the exchange stays correct and still settles in ONE
    // round trip, it just over-sends more per difference. A bound in exchange for a bound.
    expect(rangeDepthFor(Number.MAX_SAFE_INTEGER)).toBe(3);
  });
});

describe('hashIdList', () => {
  it('is stable and truncated to 64 bits', async () => {
    const hash = await hashIdList(['a', 'b', 'c']);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(await hashIdList(['a', 'b', 'c'])).toBe(hash);
  });

  it('separates ids so two different lists cannot serialise the same', async () => {
    expect(await hashIdList(['ab', 'c'])).not.toBe(await hashIdList(['a', 'bc']));
  });
});

describe('buildHistoryDigest', () => {
  it('answers an empty store with an empty ids digest, not with nothing', async () => {
    // "I hold no history" and "I did not answer" are different facts. Conflating them is what
    // forced the empty-bundle hack: every join of a brand-new conversation timed out into
    // pending-offline and re-solicited for the whole give-up horizon.
    expect(await buildHistoryDigest([])).toEqual({ mode: 'ids', ids: [] });
  });

  it('lists ids below the threshold and switches to range above it', async () => {
    const small = await buildHistoryDigest(series('m', '2026-01-01T00:00:00Z', 10), 10);
    expect(small.mode).toBe('ids');

    const large = await buildHistoryDigest(series('m', '2026-01-01T00:00:00Z', 11), 10);
    expect(large.mode).toBe('range');
  });

  it('keeps a range digest far smaller than the store, and accounts for every message', async () => {
    const digest = await buildHistoryDigest(series('m', '2026-01-01T00:00:00Z', 5000), 100);
    if (digest.mode !== 'range') throw new Error('expected range mode');
    // Every message is accounted for exactly once - a slice that swallowed one would be a message
    // neither side can ever discover is missing.
    expect(digest.ranges.reduce((n, r) => n + r.count, 0)).toBe(5000);
    expect(digest.ranges.length).toBeLessThanOrEqual(16 ** digest.depth);
    // 256 slices against 5 000 ids, and the ids here are short: the same store enumerated as real
    // UUIDs is ~185 KB, which is the reason `ids` mode has a threshold at all.
    expect(JSON.stringify(digest).length).toBeLessThan(16_000);
  });

  it('does not depend on the order the store returned the rows in', async () => {
    // Both sides sort before hashing, so a store that iterates differently must still agree.
    const rows = series('m', '2026-01-01T00:00:00Z', 200);
    const shuffled = [...rows].reverse();
    expect(await buildHistoryDigest(shuffled, 50)).toEqual(await buildHistoryDigest(rows, 50));
  });

  it('does not depend on the TIMESTAMPS at all', async () => {
    // Same ids, wildly different clocks: the digest is identical. This is the property the month
    // buckets could not have, and losing it is what made a skewed store re-send itself forever.
    const rows = series('m', '2026-01-01T00:00:00Z', 200);
    const skewed = rows.map((r, i) => ({ ...r, timestamp: r.timestamp + i * 86_400_000 * 40 }));
    expect(await buildHistoryDigest(skewed, 50)).toEqual(await buildHistoryDigest(rows, 50));
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

describe('diffHistoryDigest - range mode', () => {
  /** Forces range mode regardless of size, so the slice logic can be tested on small fixtures. */
  const asRange = (entries: HistoryEntry[]) => buildHistoryDigest(entries, -1);
  /** The slice a fixture id lands in at depth 1, which is what `asRange` produces. */
  const slice = (id: string) => historyRangeOf(id, 1);

  it('pulls a slice only the peer has, and pushes one only we have', async () => {
    const diff = await diffHistoryDigest(
      [entry('mine', '2026-01-10T00:00:00Z')],
      await asRange([entry('theirs', '2026-02-10T00:00:00Z')])
    );
    expect(diff.pullPrefixes).toEqual([slice('theirs')]);
    expect(diff.pushPrefixes).toEqual([slice('mine')]);
  });

  it('reports nothing for a store both sides hold identically', async () => {
    const rows = [entry('a', '2026-03-01T00:00:00Z'), entry('b', '2026-03-02T00:00:00Z')];
    const diff = await diffHistoryDigest(rows, await asRange(rows));
    expect(isEmptyHistoryDiff(diff)).toBe(true);
  });

  it('detects a slice with the same COUNT but different messages', async () => {
    // The reason a slice carries a fingerprint at all: a count that matches proves nothing, and a
    // count-only digest would declare the slice settled and lose both messages for good.
    const [mine, theirs] = sameSlice(2, 1);
    const diff = await diffHistoryDigest(
      [entry(mine, '2026-03-01T00:00:00Z')],
      await asRange([entry(theirs, '2026-03-01T00:00:00Z')])
    );
    expect(diff.pullPrefixes).toEqual([slice(mine)]);
    expect(diff.pushPrefixes).toEqual([slice(mine)]);
  });

  it('sends a differing slice in BOTH directions, because a fingerprint cannot say who is short', async () => {
    const [kept, extra] = sameSlice(2, 1);
    const diff = await diffHistoryDigest(
      [entry(kept, '2026-03-01T00:00:00Z'), entry(extra, '2026-03-02T00:00:00Z')],
      await asRange([entry(kept, '2026-03-01T00:00:00Z')])
    );
    // We are strictly ahead here, yet the slice is still pulled: guessing from the hashes would be
    // guessing, and guessing wrong drops messages. Over-sending is bandwidth, the receiver dedupes.
    expect(diff.pullPrefixes).toEqual([slice(kept)]);
    expect(diff.pushPrefixes).toEqual([slice(kept)]);
  });

  it('is blind to a clock skew that used to re-send two whole months forever', async () => {
    // The same message, timestamped either side of midnight UTC on the two devices. Under month
    // buckets both months read as different on EVERY exchange, so the diff never emptied and the
    // durable marker it clears was never cleared. Slicing by id, the two stores are identical.
    const diff = await diffHistoryDigest(
      [entry('edge', '2026-07-31T23:59:59Z')],
      await asRange([entry('edge', '2026-08-01T00:00:01Z')])
    );
    expect(isEmptyHistoryDiff(diff)).toBe(true);
  });

  it("re-slices the LOCAL store at the digest's depth, not at its own", async () => {
    // The two stores have different sizes, so each would pick a different depth. Comparing slices
    // computed at two depths compares different regions of the id space: everything disagrees.
    const remote = await buildHistoryDigest(series('m', '2026-01-01T00:00:00Z', 40), -1);
    if (remote.mode !== 'range') throw new Error('expected range mode');
    const diff = await diffHistoryDigest(series('m', '2026-01-01T00:00:00Z', 40), remote);
    expect(isEmptyHistoryDiff(diff)).toBe(true);
    for (const prefix of [...diff.pullPrefixes, ...diff.pushPrefixes])
      expect(prefix.length).toBe(remote.depth);
  });

  it('leaves the id lists empty - a range diff resolves to a slice, never to a message', async () => {
    const diff = await diffHistoryDigest(
      [entry('a', '2026-01-10T00:00:00Z')],
      await asRange([entry('b', '2026-02-10T00:00:00Z')])
    );
    expect(diff.missingLocally).toEqual([]);
    expect(diff.missingOnPeer).toEqual([]);
  });
});

describe('selectEntryIdsForPrefixes', () => {
  const wanted = sameSlice(3, 1);
  const rows = [...wanted, ...sameSlice(3, 1).map((id) => `${id}-other`)].map((id) =>
    entry(id, '2026-01-05T00:00:00Z')
  );

  it('collects every local id in the requested slices', () => {
    expect(selectEntryIdsForPrefixes(rows, [historyRangeOf(wanted[0], 1)], 1).sort()).toEqual(
      rows
        .map((r) => r.id)
        .filter((id) => historyRangeOf(id, 1) === historyRangeOf(wanted[0], 1))
        .sort()
    );
  });

  it('ignores a slice it holds nothing for', () => {
    const held = new Set(rows.map((r) => historyRangeOf(r.id, 1)));
    const empty = '0123456789abcdef'.split('').find((c) => !held.has(c))!;
    expect(selectEntryIdsForPrefixes(rows, [empty], 1)).toEqual([]);
  });

  it('returns nothing for an empty request rather than everything', () => {
    // A pull that names no slice must move no data: the alternative is a full bundle sent by
    // accident, which is exactly what this work package exists to retire.
    expect(selectEntryIdsForPrefixes(rows, [], 1)).toEqual([]);
  });
});

describe('parseHistoryDigest', () => {
  it('accepts a digest this module produced, in either mode', async () => {
    const ids = await buildHistoryDigest([entry('a', '2026-01-01T00:00:00Z')]);
    expect(parseHistoryDigest(JSON.parse(JSON.stringify(ids)))).toEqual(ids);

    const ranges = await buildHistoryDigest([entry('a', '2026-01-01T00:00:00Z')], -1);
    expect(parseHistoryDigest(JSON.parse(JSON.stringify(ranges)))).toEqual(ranges);
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
    // The retired month mode: a client too old to speak `range` is rejected here and answered with
    // a full bundle, the same path a peer that sent no digest at all already takes.
    ['the retired buckets mode', { mode: 'buckets', buckets: [] }],
    ['ranges that are not an array', { mode: 'range', depth: 1, ranges: {} }],
    ['no depth', { mode: 'range', ranges: [{ prefix: 'a', count: 1, hash: 'ab' }] }],
    ['a depth past the cap', { mode: 'range', depth: 9, ranges: [] }],
    [
      'a prefix that is not as long as the depth',
      { mode: 'range', depth: 2, ranges: [{ prefix: 'a', count: 1, hash: 'ab' }] },
    ],
    [
      'a non-hex prefix',
      { mode: 'range', depth: 1, ranges: [{ prefix: 'z', count: 1, hash: 'ab' }] },
    ],
    [
      'a negative count',
      { mode: 'range', depth: 1, ranges: [{ prefix: 'a', count: -1, hash: 'ab' }] },
    ],
    [
      'a fractional count',
      { mode: 'range', depth: 1, ranges: [{ prefix: 'a', count: 1.5, hash: 'ab' }] },
    ],
    [
      'a non-hex hash',
      { mode: 'range', depth: 1, ranges: [{ prefix: 'a', count: 1, hash: 'zz' }] },
    ],
    ['a missing hash', { mode: 'range', depth: 1, ranges: [{ prefix: 'a', count: 1 }] }],
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
