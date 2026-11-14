import { getContext, setContext } from 'svelte';
import type { SharedMediaItem } from '$lib/utils/chat/sharedContent';

/**
 * Reads the open conversation's images and videos from what the client ALREADY holds, newest
 * first (`aggregateSharedContent`'s order). Never a network fetch.
 */
export type ChatMediaSequenceLoader = () => Promise<SharedMediaItem[]>;

const KEY = Symbol('chat-media-sequence');

/**
 * The chat page provides the loader once; every bubble's media renderer reads it back, so the
 * viewer can walk the conversation without a prop threaded through five components.
 */
export function provideChatMediaSequence(loader: ChatMediaSequenceLoader): void {
  setContext(KEY, loader);
}

/** The loader, or `undefined` outside a conversation (a bubble drawn alone keeps a single-item viewer). */
export function useChatMediaSequence(): ChatMediaSequenceLoader | undefined {
  return getContext<ChatMediaSequenceLoader | undefined>(KEY);
}
