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
import { advanceLastMessageAt } from './messageOrder';
import { mkCallStartedEnvelope, serializeEnvelope } from '$lib/envelope';
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

function notice(id: string, at: number, flagOnly = false): ChatMessage {
  return flagOnly ? { ...msg(id, at), isSystem: true } : { ...msg(id, at), senderId: 'system' };
}

describe('a system notice is not activity', () => {
  it('skips a newer notice (flagged or by sender) and reads the newest real message', () => {
    const c = convo('c', [msg('1', 100), notice('2', 900), notice('3', 950, true)]);
    expect(conversationRecency(c)).toBe(100);
  });

  it('keeps an only-notices conversation at its seed, then its creation, never the notice time', () => {
    expect(conversationRecency(convo('c', [notice('1', 900)], 40))).toBe(40);
    expect(conversationRecency({ ...convo('c', [notice('1', 900)]), startedAt: 10 })).toBe(10);
    expect(conversationRecency(convo('c', [notice('1', 900)]))).toBe(0);
  });

  it('does not let a notice move a conversation above a quieter one', () => {
    const a = convo('a', [msg('1', 100), notice('2', 900)]);
    const b = convo('b', [msg('1', 500)]);
    expect([a, b].sort(compareConversationRecency).map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('advanceLastMessageAt moves the seed on real messages only', () => {
    expect(advanceLastMessageAt(50, [notice('1', 900)])).toBe(50);
    expect(advanceLastMessageAt(undefined, [notice('1', 900)])).toBeUndefined();
    expect(advanceLastMessageAt(50, [notice('1', 900), msg('2', 70)])).toBe(70);
  });
});

describe('a call record is activity, a notice is not', () => {
  const call = (id: string, at: number): ChatMessage => ({
    ...msg(id, at),
    senderId: 'system',
    isSystem: true,
    content: serializeEnvelope(mkCallStartedEnvelope('Camille', 'c1', 'camille', at)),
  });

  it('ranks by the call record even when a notice is newer', () => {
    expect(conversationRecency(convo('c', [msg('1', 100), call('2', 400), notice('3', 900)]))).toBe(
      400
    );
  });

  it('advanceLastMessageAt moves on a call record', () => {
    expect(advanceLastMessageAt(50, [call('1', 600)])).toBe(600);
  });
});

describe('a freshly created conversation holding only its creation notice', () => {
  it('ranks by its creation seed, above an older quieter conversation', () => {
    const fresh = convo('fresh', [notice('1', 5000)], 4000);
    const old = convo('old', [msg('1', 1000)]);
    expect([old, fresh].sort(compareConversationRecency).map((x) => x.id)).toEqual([
      'fresh',
      'old',
    ]);
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
