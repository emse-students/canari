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
