/**
 * A conversation that is gone may not keep claiming its history is on the way.
 *
 * Reported from production 2026-08-11: a conversation deleted by the peer still showed
 * "L'historique est en attente : aucun appareil n'a repondu". The row survives that deletion on
 * purpose (`lifecycle: 'removed'`, so the UI can say what happened), which is exactly what keeps
 * the banner reachable - and every path that clears the pending state waits for a history bundle
 * to arrive, which for a deleted group is a wait with no end.
 *
 * These tests assert the two halves separately, because they have different lifetimes and only one
 * of them is visible: the durable marker (localStorage, otherwise bounded only by a 30-day
 * give-up horizon) and the reactive phase the banner reads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { markConversationDeletedRemotely } from './conversations';
import { forgetAwaitingHistory } from './historySolicit';
import { markAwaitingHistory, isAwaitingHistory } from './awaitingHistoryRegistry';
import { historyRequestPendingStore } from '$lib/stores/historyRequestPending.svelte';

const USER = 'user-a';
const GROUP = 'group-under-test';

function makeConvo(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: GROUP,
    name: 'Test',
    messages: [],
    lastMessage: '',
    timestamp: Date.now(),
    unreadCount: 0,
    ...overrides,
  } as Conversation;
}

beforeEach(() => {
  localStorage.clear();
  historyRequestPendingStore.cancelAll();
});

describe('forgetAwaitingHistory', () => {
  it('clears the durable marker, whatever reason was recorded', () => {
    // `unreadable-frames` is the PROVEN reason - the one a partial bundle deliberately cannot
    // discharge. If anything survives a deletion it is this one, so it is what the test uses.
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');
    expect(isAwaitingHistory(USER, GROUP)).toBe(true);

    forgetAwaitingHistory(USER, GROUP);

    expect(isAwaitingHistory(USER, GROUP)).toBe(false);
  });

  it('clears the reactive phase the banner reads', () => {
    historyRequestPendingStore.start(GROUP);
    expect(historyRequestPendingStore.getPhase(GROUP)).not.toBeNull();

    forgetAwaitingHistory(USER, GROUP);

    expect(historyRequestPendingStore.getPhase(GROUP)).toBeNull();
  });

  it('touches no other conversation', () => {
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');
    markAwaitingHistory(USER, 'other-group', 'unreadable-frames');

    forgetAwaitingHistory(USER, GROUP);

    expect(isAwaitingHistory(USER, 'other-group')).toBe(true);
  });

  it('is safe on a conversation that was never awaiting anything', () => {
    expect(() => forgetAwaitingHistory(USER, GROUP)).not.toThrow();
    expect(isAwaitingHistory(USER, GROUP)).toBe(false);
  });
});

describe('markConversationDeletedRemotely', () => {
  it('stops the pending-history banner on the conversation it just removed', () => {
    const conversations = new SvelteMap<string, Conversation>([['k', makeConvo()]]);
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');
    historyRequestPendingStore.start(GROUP);

    const changed = markConversationDeletedRemotely(
      conversations,
      GROUP,
      USER,
      vi.fn().mockResolvedValue(undefined)
    );

    expect(changed).toBe(true);
    // The row deliberately survives - that is what made the banner reachable in the first place.
    expect(conversations.get('k')?.lifecycle).toBe('removed');
    expect(historyRequestPendingStore.getPhase(GROUP)).toBeNull();
    expect(isAwaitingHistory(USER, GROUP)).toBe(false);
  });

  it('leaves the awaiting state alone when it changed nothing', () => {
    // Already removed: the function returns early, and an early return must not have side effects
    // on a conversation somebody else's code path may still be working on.
    const conversations = new SvelteMap<string, Conversation>([
      ['k', makeConvo({ lifecycle: 'removed' })],
    ]);
    markAwaitingHistory(USER, GROUP, 'unreadable-frames');

    const changed = markConversationDeletedRemotely(conversations, GROUP, USER);

    expect(changed).toBe(false);
    expect(isAwaitingHistory(USER, GROUP)).toBe(true);
  });
});
