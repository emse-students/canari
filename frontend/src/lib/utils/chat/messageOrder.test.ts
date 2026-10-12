import { compareMessageOrder, mergeMessagesInInputOrder } from './messageOrder';
import type { ChatMessage } from '$lib/types';

function msg(id: string, ts: number, ingestSequence?: number): ChatMessage {
  return {
    id,
    senderId: 'u1',
    content: 'hi',
    timestamp: new Date(ts),
    isOwn: false,
    ingestSequence,
  };
}

describe('compareMessageOrder', () => {
  it('orders by timestamp then ingestSequence', () => {
    const a = msg('a', 1000, 1);
    const b = msg('b', 1000, 0);
    expect(compareMessageOrder(b, a)).toBeLessThan(0);
  });
});

describe('mergeMessagesInInputOrder', () => {
  it('keeps catch-up arrival order when timestamps are equal', () => {
    const existing = [msg('old', 500)];
    const incoming = [msg('m1', 1000, 0), msg('m2', 1000, 1), msg('m3', 1000, 2)];
    const merged = mergeMessagesInInputOrder(existing, incoming);
    expect(merged.map((m) => m.id)).toEqual(['old', 'm1', 'm2', 'm3']);
  });
});

describe('mergeMessagesInInputOrder - one sort, the same order as one insert per message', () => {
  /** The algorithm this replaced: a copy and a full stable sort per incoming message. */
  const oneSortPerMessage = (existing: ChatMessage[], incoming: ChatMessage[]) => {
    let merged = existing;
    for (const m of incoming) merged = [...merged, m].sort(compareMessageOrder);
    return merged;
  };

  /** A deterministic generator - the same "random" input on every run, never a clock. */
  const lcg = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

  it('gives the same array as the per-message loop on input full of ties', () => {
    const rand = lcg(42);
    for (let round = 0; round < 50; round += 1) {
      // Few distinct timestamps, few sequences and server times, and repeated ids, so the
      // comparator returns 0 often - the case where order depends on stability.
      //
      // Every message of a round carries the SAME tie-breakers (all or none). With MIXED presence
      // the comparator is not transitive (a server time on a and c but not b can rank a < b < c < a),
      // and then no sort - the old loop included - has a defined answer: its result already
      // depended on the order messages happened to arrive in.
      const withServer = rand() < 0.5;
      const withSeq = rand() < 0.5;
      const make = (prefix: string, i: number): ChatMessage => ({
        ...msg(`${prefix}${Math.floor(rand() * 5)}`, 1000 + Math.floor(rand() * 4) * 10),
        ingestSequence: withSeq ? Math.floor(rand() * 3) : undefined,
        serverTimestamp: withServer ? Math.floor(rand() * 3) : undefined,
        content: `${prefix}-${i}`,
      });
      const existing = Array.from({ length: Math.floor(rand() * 30) }, (_, i) => make('e', i));
      const incoming = Array.from({ length: Math.floor(rand() * 30) }, (_, i) => make('n', i));
      const expected = oneSortPerMessage(existing, incoming).map((m) => m.content);
      expect(mergeMessagesInInputOrder(existing, incoming).map((m) => m.content)).toEqual(expected);
    }
  });

  it('sorts ONCE for a batch, whatever its size', () => {
    const existing = Array.from({ length: 5000 }, (_, i) => msg(`e${i}`, i * 1000));
    const incoming = Array.from({ length: 200 }, (_, i) => msg(`n${i}`, 5_000_000 + i, i));
    const sorts = vi.spyOn(Array.prototype, 'sort');
    const merged = mergeMessagesInInputOrder(existing, incoming);
    expect(sorts).toHaveBeenCalledTimes(1);
    sorts.mockRestore();
    expect(merged).toHaveLength(5200);
    expect(merged.at(-1)?.id).toBe('n199');
  });

  it('returns the held array itself when nothing arrives', () => {
    const existing = [msg('a', 1)];
    expect(mergeMessagesInInputOrder(existing, [])).toBe(existing);
  });
});

describe('mergeMessagesInInputOrder - the production shape', () => {
  // What the two callers actually hold: messages already in the conversation carry a
  // `serverTimestamp` (persisted queue time) and no `ingestSequence`; a catch-up batch carries an
  // `ingestSequence` (this session's order) and no `serverTimestamp`.
  const held = (id: string, ts: number, serverTimestamp: number): ChatMessage => ({
    ...msg(id, ts),
    serverTimestamp,
  });
  const incoming = (id: string, ts: number, seq: number): ChatMessage => msg(id, ts, seq);
  const oneSortPerMessage = (existing: ChatMessage[], batch: ChatMessage[]) => {
    let merged = existing;
    for (const m of batch) merged = [...merged, m].sort(compareMessageOrder);
    return merged;
  };

  it('gives the same order as the per-message loop whenever no two messages share a millisecond', () => {
    const existing = Array.from({ length: 40 }, (_, i) => held(`h${i}`, 1000 + i * 7, i));
    const batch = Array.from({ length: 40 }, (_, i) => incoming(`n${i}`, 1003 + i * 5, i));
    expect(mergeMessagesInInputOrder(existing, batch).map((m) => m.id)).toEqual(
      oneSortPerMessage(existing, batch).map((m) => m.id)
    );
  });

  it('has NO total order for three or more messages in one millisecond, so such ties may swap vs the old loop', () => {
    // Held vs held compare by server time, incoming vs incoming by sequence, and held vs incoming
    // share neither, so they fall to the id - which can close a cycle:
    const h1 = held('z', 1000, 1);
    const h2 = held('a', 1000, 2);
    const n = incoming('m', 1000, 0);
    expect(compareMessageOrder(h1, h2)).toBeLessThan(0); // server time 1 < 2
    expect(compareMessageOrder(h2, n)).toBeLessThan(0); // 'a' < 'm'
    expect(compareMessageOrder(n, h1)).toBeLessThan(0); // 'm' < 'z'
    // h1 < h2 < n < h1: any order of the three violates one comparison, so neither the old loop
    // nor one sort has a "right" answer, and the two may legitimately differ here. What both
    // keep is the set of messages.
    const merged = mergeMessagesInInputOrder([h1, h2], [n]);
    expect(merged.map((m) => m.id).sort()).toEqual(['a', 'm', 'z']);
  });
});
