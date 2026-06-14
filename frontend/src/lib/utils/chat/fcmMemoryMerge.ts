import type { StoredMessage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { compareMessageOrder } from '$lib/utils/chat/messageOrder';
import { mapStoredMessagesToChatMessages } from '$lib/utils/chat/history';
import { shouldUpgradeMessage, mergeMessageUpgrade } from '$lib/utils/chat/messageMerge';

/**
 * Merges FCM-cached messages into the in-memory conversation map.
 * Upgrades existing FCM previews when the same message id is present.
 */
export function mergeFcmMessagesIntoConversations(
  injected: StoredMessage[],
  conversations: Map<string, Conversation>,
  userId: string
): number {
  if (injected.length === 0) return 0;

  let merged = 0;
  for (const msg of injected) {
    const convoId = msg.conversationId;
    const convo = conversations.get(convoId);
    if (!convo) continue;

    const existingIdx = convo.messages.findIndex((m) => m.id === msg.id);
    if (existingIdx !== -1) {
      const existing = convo.messages[existingIdx];
      if (shouldUpgradeMessage(existing, msg.content)) {
        const chatMsgs = mapStoredMessagesToChatMessages([msg], userId);
        const incoming = chatMsgs[0];
        const next = [...convo.messages];
        next[existingIdx] = mergeMessageUpgrade(existing, incoming);
        conversations.set(convoId, {
          ...convo,
          messages: next.sort(compareMessageOrder),
          lastMessageAt: Math.max(convo.lastMessageAt ?? 0, incoming.timestamp.getTime()),
        });
        merged++;
      }
      continue;
    }

    const chatMsg = mapStoredMessagesToChatMessages([{ ...msg, isFcmPreview: true }], userId)[0];
    chatMsg.isFcmPreview = true;
    const messages = [...convo.messages, chatMsg].sort(compareMessageOrder);
    const isOwn = chatMsg.isOwn;
    const shouldMarkUnread = !isOwn;
    conversations.set(convoId, {
      ...convo,
      messages,
      lastMessageAt: Math.max(convo.lastMessageAt ?? 0, chatMsg.timestamp.getTime()),
      unreadCount: shouldMarkUnread ? (convo.unreadCount ?? 0) + 1 : (convo.unreadCount ?? 0),
    });
    merged++;
  }

  return merged;
}
