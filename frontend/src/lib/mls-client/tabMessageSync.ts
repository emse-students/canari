import type { ChatMessage } from '$lib/types';
import { getIsTabLeader } from '$lib/mls-client/tabLeader';

const TAB_MESSAGES_CHANNEL = 'canari-tab-messages';

export type TabMessageEvent =
  | {
      type: 'message_added';
      conversationId: string;
      message: ChatMessage;
      lastMessageAt: number;
      unreadCount: number;
    }
  | {
      type: 'messages_batch';
      conversationId: string;
      messages: ChatMessage[];
      lastMessageAt: number;
      unreadCount: number;
    };

const MESSAGE_EVENT_TYPES = new Set<string>(['message_added', 'messages_batch']);

/**
 * Outbox coordination, follower <-> leader, on the same channel.
 *
 * Only the leader tab may encrypt: two tabs of one account each hold their own MLS client loaded
 * from a single snapshot, so a send from the tab whose in-memory ratchet is behind reuses a
 * generation the peer has already consumed and the message is dropped on arrival (WP-MULTITAB-1).
 * The queue itself is shared - it lives in IndexedDB - so a follower does not hand over the
 * message, only the instruction to drain.
 */
export type TabOutboxEvent =
  | { type: 'outbox_flush_request' }
  | { type: 'outbox_entry_sent'; messageId: string; content?: string };

const OUTBOX_EVENT_TYPES = new Set<string>(['outbox_flush_request', 'outbox_entry_sent']);

let messageChannel: BroadcastChannel | null = null;
let messageHandler: ((event: TabMessageEvent) => void) | null = null;

function ensureChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!messageChannel) messageChannel = new BroadcastChannel(TAB_MESSAGES_CHANNEL);
  return messageChannel;
}

/** Publishes a conversation update from the leader tab to follower tabs. */
export function publishTabMessageUpdate(event: TabMessageEvent): void {
  if (!getIsTabLeader()) return;
  ensureChannel()?.postMessage(event);
}

/** Subscribes follower tabs to leader-originated message updates. */
export function subscribeTabMessageUpdates(handler: (event: TabMessageEvent) => void): () => void {
  messageHandler = handler;
  const ch = ensureChannel();
  if (!ch) return () => {};

  const onMessage = (ev: MessageEvent<TabMessageEvent>) => {
    // The channel also carries outbox coordination; a conversation handler must not see it.
    if (MESSAGE_EVENT_TYPES.has(ev.data?.type)) messageHandler?.(ev.data);
  };
  ch.addEventListener('message', onMessage);
  return () => {
    ch.removeEventListener('message', onMessage);
    if (messageHandler === handler) messageHandler = null;
  };
}

/**
 * From a follower tab: asks the leader to drain the shared outbox now.
 *
 * A no-op in the leader, which drains on its own. There is no acknowledgement and none is needed:
 * the entry is already durable in IndexedDB, so the worst case is the leader's own backoff timer
 * picking it up instead of this nudge.
 */
export function requestLeaderOutboxFlush(): void {
  if (getIsTabLeader()) return;
  ensureChannel()?.postMessage({ type: 'outbox_flush_request' } satisfies TabOutboxEvent);
}

/**
 * From the leader tab: tells the follower that composed a message that it went out, so the
 * follower can settle its optimistic echo. Without it the echo keeps the `pending` clock for as
 * long as that tab lives - the follower never runs the flush that would have patched the status,
 * and status is derived rather than persisted, so nothing else would ever correct it.
 */
export function publishOutboxEntrySent(messageId: string, content?: string): void {
  if (!getIsTabLeader()) return;
  ensureChannel()?.postMessage({
    type: 'outbox_entry_sent',
    messageId,
    ...(content ? { content } : {}),
  } satisfies TabOutboxEvent);
}

/** Subscribes this tab to outbox coordination events from the other tabs of this account. */
export function subscribeTabOutboxEvents(handler: (event: TabOutboxEvent) => void): () => void {
  const ch = ensureChannel();
  if (!ch) return () => {};

  const onMessage = (ev: MessageEvent<TabOutboxEvent>) => {
    if (OUTBOX_EVENT_TYPES.has(ev.data?.type)) handler(ev.data);
  };
  ch.addEventListener('message', onMessage);
  return () => ch.removeEventListener('message', onMessage);
}
