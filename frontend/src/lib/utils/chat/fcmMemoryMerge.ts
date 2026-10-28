import type { StoredMessage } from '$lib/db';
import type { Conversation } from '$lib/types';
import { advanceLastMessageAt, compareMessageOrder } from '$lib/utils/chat/messageOrder';
import { mapStoredMessagesToChatMessages } from '$lib/utils/chat/history';
import { shouldUpgradeMessage, mergeMessageUpgrade } from '$lib/utils/chat/messageMerge';
import { buildConversationRow } from '$lib/utils/chat/conversations';
import type { PushPlaceholder } from '$lib/utils/chat/fcmCache';

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
 * **WHAT DIFFERS IS THE LIFECYCLE AND THE LABEL, AND NOTHING ELSE DID.** This docblock used to
 * claim the three in-memory placeholders "mean different things, so this is not a fourth copy of one
 * fact but the third of three". They were the third of THIRTEEN, they meant one thing - the row for
 * a group this device has just learnt about - and what separated them was drift, not meaning.
 * {@link buildConversationRow} is the shape; `pending` and the sender's name are this site's own,
 * because the group is not synced yet and a `StoredMessage` carries no name.
 *
 * What it must match is the row `consumeFcmCache` just committed, so that what the user sees now is
 * what a restart would have shown them.
 *
 * @param placeholders what `consumeFcmCache` wrote, keyed by group id. Absent for callers that
 *   have no cache behind them, in which case a missing conversation is still a drop - but a LOGGED
 *   one, because a message reaching here with nowhere to go is the defect above coming back.
 */
export function mergeFcmMessagesIntoConversations(
  injected: StoredMessage[],
  conversations: Map<string, Conversation>,
  userId: string,
  placeholders?: ReadonlyMap<string, PushPlaceholder>
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
      // THE WHOLE IDENTITY, NOT JUST THE LABEL. Handing `buildConversationRow` a name and no type
      // made it write `group`, which is how a DM from a brand-new correspondent arrived with a
      // square avatar and no photo - see `placeholderIdentityForPushEntry`.
      convo = buildConversationRow({
        id: convoId,
        lifecycle: 'pending',
        identity: {
          ...placeholder,
          contactName: placeholder.contactName,
          displayName: placeholder.name,
        },
        lastMessageAt: placeholder.updatedAt,
      });
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
          lastMessageAt: advanceLastMessageAt(convo.lastMessageAt, [incoming]),
        });
        merged++;
      }
      continue;
    }

    const chatMsg = mapStoredMessagesToChatMessages([{ ...msg, isFcmPreview: true }], userId)[0];
    chatMsg.isFcmPreview = true;
    const messages = [...convo.messages, chatMsg].sort(compareMessageOrder);
    // Mirrors isUnreadForUser's exclusion: a system notice is never unread, including one this
    // user's own action produced (e.g. an invite), and it never carries the inviter's own id.
    const shouldMarkUnread = !chatMsg.isOwn && !chatMsg.isSystem;
    conversations.set(convoId, {
      ...convo,
      messages,
      lastMessageAt: advanceLastMessageAt(convo.lastMessageAt, [chatMsg]),
      unreadCount: shouldMarkUnread ? (convo.unreadCount ?? 0) + 1 : (convo.unreadCount ?? 0),
    });
    merged++;
  }

  return merged;
}

/**
 * {@link mergeFcmMessagesIntoConversations}, then ANNOUNCES every conversation row the merge created.
 *
 * A row appearing is the event that makes a frame refused `absent-conversation` readable, and the
 * merge is one of the paths that makes rows appear - for a group the push service joined in the
 * background, the first one. It announced nothing, so frames waiting on that row sat in the server
 * queue until some unrelated global re-fetch ran: 1.5 s at a cold start on a Pixel 6a (prod 1.2.7,
 * 2026-10-14), and on a resume nothing is scheduled at all. `ensureConversationForServerGroup` keeps
 * the same invariant for the rows it creates.
 *
 * A SECOND ENTRANCE FOR NOW, NOT A SECOND POLICY: the login merge in `sessionAuth.ts` still calls the
 * unannounced one, because that file is being changed by another pull request; it moves here when
 * that one lands, and the unannounced export becomes private. Until then the login path is covered,
 * later, by the restore's `notifyConversationsRestored`.
 *
 * @param announce called once per created row, with its group id
 */
export function mergeFcmMessagesAndAnnounce(
  injected: StoredMessage[],
  conversations: Map<string, Conversation>,
  userId: string,
  placeholders: ReadonlyMap<string, PushPlaceholder>,
  announce: (groupId: string) => void
): number {
  const absentBefore = new Set(
    injected.map((m) => m.conversationId).filter((id) => !conversations.has(id))
  );
  const merged = mergeFcmMessagesIntoConversations(injected, conversations, userId, placeholders);
  for (const id of absentBefore) {
    if (conversations.has(id)) announce(id);
  }
  return merged;
}
