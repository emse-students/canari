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
