import { describe, expect, it } from 'vitest';
import { insertMessageOrdered } from './messageOrder';
import type { ChatMessage } from '$lib/types';

function msg(id: string, ts: string): ChatMessage {
  return {
    id,
    senderId: 'alice',
    content: 'x',
    timestamp: new Date(ts),
    isOwn: false,
  };
}

describe('insertMessageOrdered', () => {
  it('insere en ordre chronologique ascendant', () => {
    const messages = [msg('b', '2026-04-01T09:00:02.000Z'), msg('c', '2026-04-01T09:00:03.000Z')];
    const result = insertMessageOrdered(messages, msg('a', '2026-04-01T09:00:01.000Z'));

    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('utilise un tie-break deterministe par id a timestamp egal', () => {
    const messages = [msg('b', '2026-04-01T09:00:01.000Z')];
    const result = insertMessageOrdered(messages, msg('a', '2026-04-01T09:00:01.000Z'));

    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
  });
});
