import { describe, expect, it, vi } from 'vitest';
import { SvelteMap } from 'svelte/reactivity';
import type { Conversation } from '$lib/types';
import { findConversationKeyByGroupId, markConversationDeletedRemotely } from './conversations';

const GROUP = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function makeConvo(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: GROUP,
    contactName: GROUP,
    name: 'Test group',
    messages: [],
    lifecycle: 'active',
    mlsStateHex: null,
    ...overrides,
  };
}

describe('findConversationKeyByGroupId', () => {
  it('returns the map key when it matches groupId', () => {
    const conversations = new SvelteMap<string, Conversation>([[GROUP, makeConvo()]]);
    expect(findConversationKeyByGroupId(conversations, GROUP)).toBe(GROUP);
  });

  it('finds legacy direct rows keyed by userId::peerId', () => {
    const legacyKey = 'alice::bob';
    const conversations = new SvelteMap<string, Conversation>([
      [legacyKey, makeConvo({ id: GROUP, contactName: 'bob' })],
    ]);
    expect(findConversationKeyByGroupId(conversations, GROUP)).toBe(legacyKey);
  });
});

describe('markConversationDeletedRemotely', () => {
  it('sets lifecycle=removed on the resolved conversation key', () => {
    const legacyKey = 'alice::bob';
    const conversations = new SvelteMap<string, Conversation>([
      [legacyKey, makeConvo({ id: GROUP })],
    ]);
    const save = vi.fn().mockResolvedValue(undefined);

    const changed = markConversationDeletedRemotely(conversations, GROUP, save);

    expect(changed).toBe(true);
    expect(conversations.get(legacyKey)?.lifecycle).toBe('removed');
    expect(save).toHaveBeenCalledWith(legacyKey);
  });
});
