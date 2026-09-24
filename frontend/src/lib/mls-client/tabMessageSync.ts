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
    }
  /**
   * A message THIS tab just composed, announced by whichever tab composed it.
   *
   * **THE ONE EVENT HERE THAT DOES NOT FLOW LEADER -> FOLLOWER, and it is the only kind of message
   * a follower knows something about that the leader does not.** Everything else on this channel is
   * the leader relaying what it alone receives; a composed message is the opposite fact, and
   * suppressing it is what left TAB-4b measuring `tab1: 0` against `tab2: 1, peer: 1` on
   * 2026-09-05. It was never loss - the outbox row lives in IndexedDB, which both tabs share, so
   * reloading the leader showed it - the leader's IN-MEMORY list was simply never told.
   *
   * **IT CARRIES NO `unreadCount`, deliberately.** A follower cannot speak for the leader's unread
   * state, and it has nothing to say about it either: an own message is never unread. `lastMessageAt`
   * is the message's own timestamp, which every tab would derive identically.
   */
  | {
      type: 'own_message_composed';
      conversationId: string;
      message: ChatMessage;
      lastMessageAt: number;
    };

const MESSAGE_EVENT_TYPES = new Set<string>([
  'message_added',
  'messages_batch',
  'own_message_composed',
]);

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
  | { type: 'outbox_entry_sent'; messageId: string; content?: string }
  | { type: 'outbox_entry_cancelled'; messageId: string };

const OUTBOX_EVENT_TYPES = new Set<string>([
  'outbox_flush_request',
  'outbox_entry_sent',
  'outbox_entry_cancelled',
]);

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

/**
 * Announces a message this tab composed, to every other tab of this account.
 *
 * **NOT LEADER-GATED, which is the whole of it** - see `own_message_composed` above for why a
 * follower is the authority on this one fact. The gate it does carry is the mirror image: the
 * LEADER stays silent here, because its own composed message already goes out as `message_added`
 * from the same call site, and publishing both would put two copies of one row on the channel for
 * the receivers to deduplicate. The role is read here rather than at the call site so that the
 * reason lives next to the rule.
 */
export function publishComposedMessage(event: TabMessageEvent & { type: 'own_message_composed' }) {
  if (getIsTabLeader()) return;
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

/**
 * From ANY tab: tells every other tab that a queued entry has been withdrawn and must not be sent.
 *
 * The row is deleted from the shared IndexedDB queue at the same time, which is what makes the
 * cancellation survive a reload and is enough for any flush that has not started. This event covers
 * the one window that deletion cannot: a leader already walking a snapshot of the queue it read
 * BEFORE the cancellation, which would otherwise send a message the user has withdrawn.
 *
 * Unlike the other two, this is not leader-gated - a cancellation originates wherever the user
 * pressed delete, and the tab that needs to hear it is precisely the one that is not this one.
 */
export function publishOutboxEntryCancelled(messageId: string): void {
  ensureChannel()?.postMessage({
    type: 'outbox_entry_cancelled',
    messageId,
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
