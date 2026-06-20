import type { Conversation, MessageReaction } from '$lib/types';

/** Minimal Map-backed store matching `SvelteMap` usage in the message pipeline. */
export function createTestConversations(
  initial: Array<[string, Conversation]>
): Map<string, Conversation> & { size: number } {
  const m = new Map(initial);
  return m as Map<string, Conversation> & { size: number };
}

export function createTestMessageReactions(): Map<string, MessageReaction[]> {
  return new Map();
}

export function emptyConversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    name: 'Test',
    contactName: 'peer',
    messages: [],
    lifecycle: 'pending',
    mlsStateHex: null,
    ...overrides,
  };
}
