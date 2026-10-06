/**
 * The sidebar ordering key: the newest message's SENT time, derived from the message list, never a
 * stored seed that some writer forgot to advance and never the local clock.
 */
import { describe, it, expect } from 'vitest';
import {
  compareConversationRecency,
  conversationRecency,
  toConversationMeta,
} from './conversations';
import type { ChatMessage, Conversation } from '$lib/types';

function msg(id: string, at: number): ChatMessage {
  return { id, senderId: 'a', content: '', timestamp: new Date(at), isOwn: false };
}

function convo(id: string, messages: ChatMessage[], lastMessageAt?: number): Conversation {
  return {
    id,
    contactName: id,
    name: id,
    messages,
    lifecycle: 'active',
    mlsStateHex: null,
    unreadCount: 0,
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
  } as Conversation;
}

describe('conversationRecency', () => {
  it('reads the newest message, ignoring a stale or polluted seed', () => {
    // seed = a local arrival clock far in the future: it must not win over the sent time.
    expect(conversationRecency(convo('c', [msg('1', 100), msg('2', 200)], 9_000_000))).toBe(200);
  });

  it('follows a message drained from the pending queue that no writer advanced the seed for', () => {
    const before = convo('c', [msg('1', 100)], 100);
    const drained = { ...before, messages: [...before.messages, msg('2', 500)] };
    expect(conversationRecency(drained)).toBe(500);
  });

  it('falls back to the seed only while no message is loaded, and to 0 with neither', () => {
    expect(conversationRecency(convo('c', [], 42))).toBe(42);
    expect(conversationRecency(convo('c', []))).toBe(0);
  });

  it('persists the same key, never the local clock', () => {
    expect(toConversationMeta('c', convo('c', []), 'me').updatedAt).toBe(0);
    expect(toConversationMeta('c', convo('c', [msg('1', 7)], 3), 'me').updatedAt).toBe(7);
  });
});

describe('compareConversationRecency', () => {
  it('orders newest first and breaks ties by id on every device', () => {
    const a = convo('a', [msg('1', 100)]);
    const b = convo('b', [msg('1', 100)]);
    const c = convo('c', [msg('1', 300)]);
    const order = (list: Conversation[]) =>
      [...list].sort(compareConversationRecency).map((x) => x.id);
    expect(order([a, b, c])).toEqual(['c', 'a', 'b']);
    expect(order([b, c, a])).toEqual(['c', 'a', 'b']);
  });
});
