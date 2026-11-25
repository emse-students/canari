/**
 * The reactions the screen draws are keyed like the stored row, by conversation and message id: two
 * conversations holding the same id never share an entry, and a moved thread carries its own.
 */
import { describe, expect, it } from 'vitest';
import type { MessageReaction } from '$lib/types';
import { ReactionsByConversation } from './reactionsByConversation';

const r = (userId: string, emoji: string, at: number): MessageReaction => ({ userId, emoji, at });

describe('ReactionsByConversation', () => {
  it('holds one entry per conversation for the same message id', () => {
    const store = new ReactionsByConversation();
    store.set('conv-a', 'm1', [r('alice', 'x', 1)]);
    store.set('conv-b', 'm1', [r('bob', 'y', 2)]);
    expect(store.get('conv-a', 'm1')).toEqual([r('alice', 'x', 1)]);
    expect(store.get('conv-b', 'm1')).toEqual([r('bob', 'y', 2)]);
    expect(store.of('conv-a').get('m1')).toEqual([r('alice', 'x', 1)]);
    store.of('conv-a').delete('m1');
    expect(store.has('conv-a', 'm1')).toBe(false);
    expect(store.has('conv-b', 'm1')).toBe(true);
  });

  it('reads a conversation in any case as the stored key does (lowercased)', () => {
    const store = new ReactionsByConversation();
    store.set('Conv-A', 'm1', [r('alice', 'x', 1)]);
    expect(store.get('conv-a', 'm1')).toEqual([r('alice', 'x', 1)]);
  });

  it('a move carries only the named messages, and unites what the destination already held', () => {
    const store = new ReactionsByConversation();
    store.set('old', 'm1', [r('alice', 'x', 1)]);
    store.set('old', 'm2', [r('alice', 'y', 1)]);
    store.set('new', 'm1', [r('bob', 'z', 2)]);
    expect(store.move('old', 'new', ['m1', 'm3'])).toBe(1);
    expect(store.has('old', 'm1')).toBe(false);
    expect(store.get('old', 'm2')).toEqual([r('alice', 'y', 1)]);
    expect((store.get('new', 'm1') ?? []).map((x) => x.emoji).sort()).toEqual(['x', 'z']);
    expect(store.move('old', 'new', ['m1'])).toBe(0);
  });
});
