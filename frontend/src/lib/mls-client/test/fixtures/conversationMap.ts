import type { Conversation } from '$lib/types';
import { ReactionsByConversation } from '$lib/utils/chat/reactionsByConversation';

/** Minimal Map-backed store matching `SvelteMap` usage in the message pipeline. */
export function createTestConversations(
  initial: Array<[string, Conversation]>
): Map<string, Conversation> & { size: number } {
  const m = new Map(initial);
  return m as Map<string, Conversation> & { size: number };
}

/** An empty reactions store, keyed by conversation and message as the app's is. */
export function createTestMessageReactions(): ReactionsByConversation {
  return new ReactionsByConversation();
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
