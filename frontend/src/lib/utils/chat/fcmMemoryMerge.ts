import type { StoredMessage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { compareMessageOrder } from '$lib/utils/chat/messageOrder';
import { mapStoredMessagesToChatMessages } from '$lib/utils/chat/history';
import { shouldUpgradeMessage, mergeMessageUpgrade } from '$lib/utils/chat/messageMerge';

/**
 * Merges FCM-cached messages into the in-memory conversation map.
 * Upgrades existing FCM previews when the same message id is present.
 *
 * **A CONVERSATION THAT IS NOT IN THE MAP YET IS CREATED, NOT SKIPPED**, and until 2026-09-08 it
 * was skipped - `conversations.get(id)` then `continue`, silently. That is the whole of a P1 the
 * user reported from production: someone messages you for the FIRST time, the FCM service decrypts
 * it and `consumeFcmCache` writes BOTH the message and a placeholder conversation row, logs
 * `Injection done: 1/1 message(s) injected` - and then this function threw the message away because
 * the list in memory had no conversation to put it in. Nothing appeared until the app was restarted
 * and read that placeholder back from storage. The tap on the notification had nowhere to land for
 * the same reason.
 *
 * **THE LABEL COMES FROM THE WRITER, NOT FROM A GUESS HERE.** A `StoredMessage` carries a sender
 * ID and no name, so a placeholder invented in this function would disagree with the row already in
 * the database. `consumeFcmCache` returns what it wrote for exactly that reason.
 *
 * The shape is deliberately the storage row's and no richer: `pending` lifecycle, the sender's name
 * as the label, no `conversationType` and no `directPeerId`. Two other places in the tree build an
 * in-memory placeholder - the Welcome handler in `sessionAuth` (`active`, after a real join) and
 * `setupMessageHandler` (which can parse a direct peer out of the group name) - and they mean
 * different things, so this is not a fourth copy of one fact but the third of three. What it must
 * match is the row `consumeFcmCache` just committed, so that what the user sees now is what a
 * restart would have shown them.
 *
 * @param placeholders what `consumeFcmCache` wrote, keyed by group id. Absent for callers that
 *   have no cache behind them, in which case a missing conversation is still a drop - but a LOGGED
 *   one, because a message reaching here with nowhere to go is the defect above coming back.
 */
export function mergeFcmMessagesIntoConversations(
  injected: StoredMessage[],
  conversations: Map<string, Conversation>,
  userId: string,
  placeholders?: ReadonlyMap<string, { name: string; updatedAt: number }>
): number {
  if (injected.length === 0) return 0;

  let merged = 0;
  for (const msg of injected) {
    const convoId = msg.conversationId;
    let convo = conversations.get(convoId);
    if (!convo) {
      const placeholder = placeholders?.get(convoId);
      if (!placeholder) {
        // NOT SILENT. This is the branch that hid a P1 for as long as it printed nothing: the
        // caller's own log says the message was injected, and only this line can say it then went
        // nowhere. See the docblock.
        console.warn(
          `[FCM_CACHE] message ${msg.id.slice(0, 8)} is for conversation ${convoId.slice(0, 8)}, ` +
            'which is neither in memory nor among the placeholders just written - it will not be ' +
            'visible until the next full load'
        );
        continue;
      }
      convo = {
        id: convoId,
        name: placeholder.name,
        contactName: placeholder.name,
        messages: [],
        lifecycle: 'pending',
        mlsStateHex: null,
        unreadCount: 0,
        lastMessageAt: placeholder.updatedAt,
      };
      conversations.set(convoId, convo);
    }

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
