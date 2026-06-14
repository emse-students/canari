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
    if (ev.data?.type) messageHandler?.(ev.data);
  };
  ch.addEventListener('message', onMessage);
  return () => {
    ch.removeEventListener('message', onMessage);
    if (messageHandler === handler) messageHandler = null;
  };
}
