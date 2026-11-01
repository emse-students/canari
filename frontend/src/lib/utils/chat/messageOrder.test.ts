import {
  awaitsServerTime,
  clockGapNote,
  compareMessageOrder,
  mergeMessagesInInputOrder,
  messageTime,
  replaceMessageOrdered,
} from './messageOrder';
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
  it('breaks an equal key on the id, by codepoint - never on the in-session ingest order', () => {
    const a = msg('a', 1000, 1);
    const b = msg('b', 1000, 0);
    expect(compareMessageOrder(a, b)).toBeLessThan(0);
    expect(compareMessageOrder(b, a)).toBeGreaterThan(0);
  });
});

/**
 * THE ORDER IS THE SERVER'S (owner, 2026-10-31): a DM or group is sorted by the time the server
 * accepted each message, as a salon always was; the author's `sentAt` is the key only of a row the
 * server never dated.
 */
describe('compareMessageOrder - the server clock', () => {
  const dated = (id: string, sentAt: number, serverAt?: number, extra: Partial<ChatMessage> = {}) =>
    ({ ...msg(id, sentAt), serverTimestamp: serverAt, ...extra }) as ChatMessage;
  const own = (id: string, sentAt: number, status: ChatMessage['status'], serverAt?: number) =>
    dated(id, sentAt, serverAt, { isOwn: true, senderId: 'me', status });

  it('a LATE frame sorts where it arrived, not where its author wrote it', () => {
    // The peer composed `late` at 1 000; the server took it at 9 000, after `b` (5 000).
    const rows = [dated('b', 4_900, 5_000), dated('late', 1_000, 9_000), dated('a', 2_000, 2_050)];
    expect([...rows].sort(compareMessageOrder).map((m) => m.id)).toEqual(['a', 'b', 'late']);
    expect(messageTime(rows[1])).toBe(9_000);
  });

  it('an own message still sending sorts BELOW every server-dated row, whatever its sentAt', () => {
    // The owner's case (2026-10-31): typing began before the peer's message came in. Whatever the
    // reply's `sentAt` says, while it has no server time it is drawn under everything dated.
    const peer = dated('peer', 10_000, 10_100);
    const reply = own('reply', 9_000, 'sending');
    expect(awaitsServerTime(reply)).toBe(true);
    expect([reply, peer].sort(compareMessageOrder).map((m) => m.id)).toEqual(['peer', 'reply']);
  });

  it('an own message whose receivedAt comes after a peer frame sorts below that frame', () => {
    const peer = dated('peer', 10_000, 10_100);
    // Stamped BEFORE the peer's message by this device's clock, accepted AFTER it by the server's.
    const reply = own('reply', 9_000, 'sent', 10_400);
    expect(awaitsServerTime(reply)).toBe(false);
    expect([reply, peer].sort(compareMessageOrder).map((m) => m.id)).toEqual(['peer', 'reply']);
  });

  it('pending own rows are ordered among themselves by their sentAt', () => {
    const rows = [own('second', 2_000, 'pending'), own('first', 1_000, 'error'), dated('x', 9, 50)];
    expect(rows.sort(compareMessageOrder).map((m) => m.id)).toEqual(['x', 'first', 'second']);
  });

  it('an own row older than the field (no status, no server time) keeps its sentAt, never the bottom', () => {
    const legacy = own('legacy', 1_000, undefined);
    expect(awaitsServerTime(legacy)).toBe(false);
    expect(
      [dated('later', 5_000, 5_000), legacy].sort(compareMessageOrder).map((m) => m.id)
    ).toEqual(['legacy', 'later']);
  });

  it('is a total, transitive order on any mix of dated, undated and pending rows', () => {
    const rand = lcgFor(7);
    const statuses: ChatMessage['status'][] = [undefined, 'sent', 'pending', 'sending', 'error'];
    const rows: ChatMessage[] = Array.from({ length: 40 }, (_, i) => {
      const sentAt = 1_000 + Math.floor(rand() * 8) * 100;
      const serverAt = rand() < 0.6 ? 1_000 + Math.floor(rand() * 8) * 100 : undefined;
      const isOwn = rand() < 0.4;
      // Ids are unique, as they are in a conversation (one row per id); keys collide often.
      return dated(`m${String(i).padStart(2, '0')}`, sentAt, serverAt, {
        isOwn,
        senderId: isOwn ? 'me' : 'u1',
        status: isOwn ? statuses[Math.floor(rand() * statuses.length)] : undefined,
        ingestSequence: rand() < 0.5 ? Math.floor(rand() * 3) : undefined,
      });
    });
    for (const a of rows) {
      expect(compareMessageOrder(a, a)).toBe(0);
      for (const b of rows) {
        // Antisymmetric (`+` rather than `-x`: `toBe` tells 0 from -0).
        expect(Math.sign(compareMessageOrder(a, b)) + Math.sign(compareMessageOrder(b, a))).toBe(0);
        for (const c of rows) {
          if (compareMessageOrder(a, b) <= 0 && compareMessageOrder(b, c) <= 0) {
            expect(compareMessageOrder(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
    // And the answer does not depend on the order the rows arrived in.
    const once = [...rows].sort(compareMessageOrder).map((m) => m.id + m.timestamp.getTime());
    const reversed = [...rows]
      .reverse()
      .sort(compareMessageOrder)
      .map((m) => m.id + m.timestamp.getTime());
    expect(reversed).toEqual(once);
  });

  it('replaceMessageOrdered moves a reply to its server time when the send answers', () => {
    const peer = dated('peer', 10_000, 10_100);
    const later = dated('later', 10_500, 10_600);
    const reply = own('reply', 9_000, 'sending');
    const held = [peer, later, reply];
    expect(held.map((m) => m.id)).toEqual(['peer', 'later', 'reply']);
    // receivedAt 10 300: between the two peer frames, on every device.
    const next = replaceMessageOrdered(held, 2, {
      ...reply,
      status: 'sent',
      serverTimestamp: 10_300,
    });
    expect(next.map((m) => m.id)).toEqual(['peer', 'reply', 'later']);
    // A patch that does not move the key keeps the array order (and the same rows).
    const same = replaceMessageOrdered(next, 0, { ...peer, content: 'edited' });
    expect(same.map((m) => m.id)).toEqual(['peer', 'reply', 'later']);
  });

  it('logs both clocks and the gap', () => {
    expect(clockGapNote(dated('a', 1_000, 241_000))).toBe(
      'sentAt=1970-01-01T00:00:01.000Z serverAt=1970-01-01T00:04:01.000Z gap=240000ms'
    );
    expect(clockGapNote(dated('a', 1_000))).toBe('sentAt=1970-01-01T00:00:01.000Z serverAt=none');
  });
});

/** A deterministic generator - the same "random" input on every run, never a clock. */
function lcgFor(seed: number): () => number {
  return () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

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
      // Every message of a round carries the SAME fields (all or none). That split dates from the
      // comparator before 2026-10-31, which was intransitive on a mixed population; the one-key
      // order is not ("is a total, transitive order" above), so the split is now only coverage.
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

  it('closes no cycle on the shape that used to: held rows with a server time, a batch without', () => {
    // Before 2026-10-31 held vs held compared by server time, incoming vs incoming by sequence, and
    // held vs incoming by id, which made h1 < h2 < n < h1. One key per row (server time, else sentAt)
    // and the id orders the three one way, whichever order they arrive in.
    const h1 = held('z', 1000, 1);
    const h2 = held('a', 1000, 2);
    const n = incoming('m', 1000, 0);
    expect(compareMessageOrder(h1, h2)).toBeLessThan(0); // server time 1 < 2
    expect(compareMessageOrder(h2, n)).toBeLessThan(0); // 2 < 1000 (sentAt, no server time)
    expect(compareMessageOrder(h1, n)).toBeLessThan(0); // transitive
    expect(mergeMessagesInInputOrder([h1, h2], [n]).map((m) => m.id)).toEqual(['z', 'a', 'm']);
    expect(mergeMessagesInInputOrder([n], [h2, h1]).map((m) => m.id)).toEqual(['z', 'a', 'm']);
  });
});
