import type { ChatMessage } from '$lib/types';
import type { ReadClock } from '$lib/utils/chat/readState';
import { currentUserId } from '$lib/stores/userState.svelte';
import type { UnsentReason } from '$lib/db/types';
import { getIsTabLeader } from '$lib/mls-client/tabLeader';
import type { PublishedReelUpload } from '$lib/reels/publishReel';

const TAB_MESSAGES_CHANNEL = 'canari-tab-messages';

/** What a tab says about a conversation; {@link TabMessageEvent} is it stamped with its account. */
export type TabMessageBody =
  | {
      type: 'message_added';
      conversationId: string;
      message: ChatMessage;
      /** Absent when the batch carried notices only: a notice is not activity, so no seed moves. */
      lastMessageAt?: number;
      unreadCount: number;
      /**
       * The client UUID sealed inside an OWN salon message: the tab that composed it is showing an
       * echo under that id, and settles it here instead of drawing this row beside it (WP-OFF-2).
       */
      clientMessageId?: string;
    }
  | {
      type: 'messages_batch';
      conversationId: string;
      messages: ChatMessage[];
      /** Absent when the batch carried notices only: a notice is not activity, so no seed moves. */
      lastMessageAt?: number;
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
      /** Absent when the batch carried notices only: a notice is not activity, so no seed moves. */
      lastMessageAt?: number;
    }
  /**
   * This tab just marked a conversation read, announced to every other tab of this account.
   *
   * **NOT LEADER-GATED, for the same reason `own_message_composed` is not**: reading happens in
   * whichever tab is showing the conversation, leader or follower, and the fact belongs to that
   * tab alone. `readAt` is the conversation's `lastMessageAt` at the moment it was cleared - a
   * receiver only zeroes its own `unreadCount` when its own `lastMessageAt` is no newer, so a
   * message that arrived in the gap between the read and the broadcast is never swallowed as read.
   */
  | {
      type: 'conversation_read';
      conversationId: string;
      readAt: number;
      /**
       * The mark the reading tab took, on its clock. Present when a READING moved it (the receipt
       * effect), absent when the event is a SELECTION, which zeroes the badge and moves no mark. A
       * receiver advances its own watermark with it, so the thread it draws (the unread divider, the
       * scroll button) agrees with the badge on its list instead of only the badge falling.
       */
      mark?: { at: number; clock: ReadClock };
    }
  /**
   * ONE read mark the LEADER just moved on a received event: a peer's receipt, this account's read
   * on another device (`read_watermark`, `channel.read`), or one restated by a history bundle.
   * Leader-gated like `message_added`: only the leader has a socket, so without this a follower tab
   * never learned either fact and kept its badge, and drew no "Vu", until it was reloaded. Only the
   * entry that moved travels; a follower recounts its badge only when the entry is its own.
   */
  | {
      type: 'read_state';
      conversationId: string;
      userId: string;
      at: number;
      clock: ReadClock;
    }
  /**
   * Salon counts the LEADER just took from the server (`unread-counts`: a socket that came back, a
   * community cleared on another device), the keys that moved and nothing else. Each carries the
   * leader's OWN read mark of that salon at the moment it applied the count: a follower whose own
   * mark is newer read that salon after the answer was counted, and keeps its own count.
   */
  | {
      type: 'unread_counts';
      counts: Record<string, { count: number; mark: number }>;
    };

/**
 * A tab event as it travels: stamped with the account of the tab that published it. The channel and
 * the leader lock are per BROWSER, not per account, so a tab signed into another account hears the
 * same channel; a receiver drops every event its own account did not publish
 * (`tabReadRelay.routeTabReadEvent`), once, before anything reads it.
 */
export type TabMessageEvent = TabMessageBody & {
  /** The publishing tab's account (`currentUserId()`), stamped by {@link post}. */
  account?: string;
};

const MESSAGE_EVENT_TYPES = new Set<string>([
  'message_added',
  'messages_batch',
  'own_message_composed',
  'conversation_read',
  'read_state',
  'unread_counts',
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
  | { type: 'outbox_entry_sent'; messageId: string; content?: string; receivedAt?: number }
  | { type: 'outbox_entry_cancelled'; messageId: string }
  | { type: 'outbox_entry_failed'; messageId: string; serverErrors: number }
  | { type: 'outbox_entry_retired'; messageId: string; reason: UnsentReason }
  /** A follower's write to a chat-reel take (RC-13), done by the leader: see {@link forwardReelTakeWrite}. */
  | { type: 'outbox_reel_send_deleted'; messageId: string }
  | { type: 'outbox_reel_take_adopt'; takeId: string; uploaded: PublishedReelUpload }
  /** The leader took a forwarded adoption: the follower owes nothing more for it. */
  | { type: 'outbox_reel_take_adopt_ack'; takeId: string };

const OUTBOX_EVENT_TYPES = new Set<string>([
  'outbox_flush_request',
  'outbox_entry_sent',
  'outbox_entry_cancelled',
  'outbox_entry_failed',
  'outbox_entry_retired',
  'outbox_reel_send_deleted',
  'outbox_reel_take_adopt',
  'outbox_reel_take_adopt_ack',
]);

let messageChannel: BroadcastChannel | null = null;
let messageHandler: ((event: TabMessageEvent) => void) | null = null;

function ensureChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!messageChannel) messageChannel = new BroadcastChannel(TAB_MESSAGES_CHANNEL);
  return messageChannel;
}

/**
 * THE ONE WAY A CONVERSATION EVENT LEAVES THIS TAB: stamped with this tab's account, so a tab of
 * another account in the same browser can tell it is not addressed to it (see {@link TabMessageEvent}).
 */
function post(event: TabMessageBody): void {
  ensureChannel()?.postMessage({
    ...event,
    account: currentUserId() ?? '',
  } satisfies TabMessageEvent);
}

/** Publishes a conversation update from the leader tab to follower tabs. */
export function publishTabMessageUpdate(event: TabMessageBody): void {
  if (!getIsTabLeader()) return;
  post(event);
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
export function publishComposedMessage(event: TabMessageBody & { type: 'own_message_composed' }) {
  if (getIsTabLeader()) return;
  post(event);
}

/**
 * Announces that THIS tab marked a conversation read, to every other tab of this account.
 *
 * Not leader-gated - see `conversation_read` above for why. `readAt` is the conversation's
 * `lastMessageAt` at the moment it was cleared, so a receiver can tell a read that is still
 * current from one a newer message has already overtaken.
 */
export function publishConversationRead(
  conversationId: string,
  readAt: number,
  mark?: { at: number; clock: ReadClock }
): void {
  post({
    type: 'conversation_read',
    conversationId,
    readAt,
    ...(mark ? { mark } : {}),
  });
}

/**
 * From the leader tab: `userId`'s mark in `conversationId` moved to `at` on a RECEIVED event (see
 * `read_state`). Leader-gated, a no-op in a follower: a follower receives no such event.
 */
export function publishReadState(
  conversationId: string,
  userId: string,
  at: number,
  clock: ReadClock
): void {
  publishTabMessageUpdate({ type: 'read_state', conversationId, userId, at, clock });
}

/** From the leader tab: the salon counts a server answer just moved (see `unread_counts`). */
export function publishUnreadCounts(counts: Record<string, { count: number; mark: number }>): void {
  if (Object.keys(counts).length === 0) return;
  publishTabMessageUpdate({ type: 'unread_counts', counts });
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
 * From a follower tab: hands a write to a chat-reel TAKE ROW (RC-13) to the leader, which does it.
 *
 * ONLY THE LEADER WRITES A TAKE ROW: its sends are marked sent there, under a lock that lives in
 * that tab's memory, so a follower writing the same row would overwrite a `sent` mark it never saw
 * (and could give back a file recipients still cite). The row is shared (IndexedDB), the lock is
 * not - so the follower forwards the INSTRUCTION, as {@link requestLeaderOutboxFlush} does. A no-op
 * in the leader, which writes for itself.
 */
export function forwardReelTakeWrite(
  event: Extract<TabOutboxEvent, { type: 'outbox_reel_send_deleted' | 'outbox_reel_take_adopt' }>
): void {
  if (getIsTabLeader()) return;
  ensureChannel()?.postMessage(event satisfies TabOutboxEvent);
}

/**
 * From the leader tab: a follower's forwarded adoption ({@link forwardReelTakeWrite}) was taken. The
 * follower would otherwise end its publish step not knowing, and says so with its cost.
 */
export function acknowledgeReelTakeAdoption(takeId: string): void {
  if (!getIsTabLeader()) return;
  ensureChannel()?.postMessage({
    type: 'outbox_reel_take_adopt_ack',
    takeId,
  } satisfies TabOutboxEvent);
}

/**
 * From the leader tab: tells the follower that composed a message that it went out, so the
 * follower can settle its optimistic echo. Without it the echo keeps the `pending` clock for as
 * long as that tab lives - the follower never runs the flush that would have patched the status,
 * and status is derived rather than persisted, so nothing else would ever correct it.
 */
export function publishOutboxEntrySent(
  messageId: string,
  content?: string,
  /**
   * The server's receive time the send answered. The follower's echo is ordered by it like the
   * leader's copy (`messageOrder.ts`): without it the echo would leave the "awaiting its server
   * time" tier at its `sentAt`, a place no other device draws it.
   */
  receivedAt?: number | null
): void {
  if (!getIsTabLeader()) return;
  ensureChannel()?.postMessage({
    type: 'outbox_entry_sent',
    messageId,
    ...(content ? { content } : {}),
    ...(typeof receivedAt === 'number' ? { receivedAt } : {}),
  } satisfies TabOutboxEvent);
}

/**
 * From the leader tab: a queued text was parked as FAILED (a run of 5xx). A follower draws the
 * failed bubble and its Retry from it, as it settles a sent one from `outbox_entry_sent`: it never
 * flushes, so nothing else would tell it before its next reload.
 */
export function publishOutboxEntryFailed(messageId: string, serverErrors: number): void {
  if (!getIsTabLeader()) return;
  ensureChannel()?.postMessage({
    type: 'outbox_entry_failed',
    messageId,
    serverErrors,
  } satisfies TabOutboxEvent);
}

/**
 * From the leader tab: a queued attachment was retired UNSENT for the group's sake (deleted, or this
 * device no longer a member). A follower draws the failed bubble with that reason; it never flushes,
 * so it would otherwise keep the queued spinner until its next reload.
 */
export function publishOutboxEntryRetired(messageId: string, reason: UnsentReason): void {
  if (!getIsTabLeader()) return;
  ensureChannel()?.postMessage({
    type: 'outbox_entry_retired',
    messageId,
    reason,
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

/**
 * A commit a follower tab hands to the leader (`tabCommitDelegation.ts`), on the same channel.
 *
 * Like the outbox nudge, ONLY THE SIGNAL CROSSES THE CHANNEL: the request and its outcome live in a
 * durable record both tabs read (`localStorage`), so a signal lost to a tab that was not listening
 * yet costs the next drain and nothing else. `tab_commit_requested` goes follower -> leader,
 * `tab_commit_settled` leader -> follower; both carry the request id and nothing else.
 */
export type TabCommitEvent =
  | { type: 'tab_commit_requested'; id: string }
  | { type: 'tab_commit_settled'; id: string };

const COMMIT_EVENT_TYPES = new Set<string>(['tab_commit_requested', 'tab_commit_settled']);

/** Posts a commit-delegation signal to the other tabs (see {@link TabCommitEvent}). */
export function postTabCommitEvent(event: TabCommitEvent): void {
  ensureChannel()?.postMessage(event satisfies TabCommitEvent);
}

/** Subscribes this tab to the commit-delegation signals of the other tabs. */
export function subscribeTabCommitEvents(handler: (event: TabCommitEvent) => void): () => void {
  const ch = ensureChannel();
  if (!ch) return () => {};
  const onMessage = (ev: MessageEvent<TabCommitEvent>) => {
    if (COMMIT_EVENT_TYPES.has(ev.data?.type)) handler(ev.data);
  };
  ch.addEventListener('message', onMessage);
  return () => ch.removeEventListener('message', onMessage);
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
