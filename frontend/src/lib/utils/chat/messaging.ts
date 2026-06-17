import type { IMlsService } from '$lib/mlsService';
import type { ChatMessage, Conversation } from '$lib/types';
import type { OutboxEntry } from '$lib/db';
import { enqueueOutboxMessage } from './outbox';
import { scheduleOutboundMlsPersist } from '$lib/mls-client/mlsStatePersisterRegistry';
import { encodeAppMessage, mkText, mkReply, mkReaction, mkSystem } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, parseEnvelope } from '$lib/envelope';
import {
  sendEncryptedChannelMessage,
  isChannelConversationId,
} from '$lib/utils/chat/channelCrypto';

/**
 * Dependencies required by message-sending helpers.
 * Passed as a single object to avoid long argument lists and make unit testing easier.
 */
interface SendMessageDeps {
  userId: string;
  conversation: Conversation;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options: {
      replyTo?: ChatMessage['replyTo'];
      isSystem?: boolean;
      messageId?: string;
      timestamp?: Date;
      status?: ChatMessage['status'];
      skipDbSave?: boolean;
    }
  ) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Sends a text message in a conversation, optionally as a reply to a previous message.
 *
 * For direct/group MLS conversations the message is captured into the persistent outbox and
 * displayed optimistically with status `'pending'`; the outbox flusher encrypts and delivers it
 * as soon as the group is sendable (now, on reconnect, after a Welcome, or after a reboot),
 * surviving reload/kill. The user never sees a transient "send failed" error - the only hard
 * block is a conversation whose whole lineage was deleted (`deletedRemotely`).
 *
 * For channel conversations (`contactName` starts with `'channel_'`) the message is server-
 * authoritative and sent directly via `sendEncryptedChannelMessage` (no outbox).
 *
 * Returns `{ success: false }` silently when the text is empty.
 */
export async function sendChatMessage(
  text: string,
  contactName: string,
  replyingTo: ChatMessage | null,
  deps: SendMessageDeps
): Promise<{ success: boolean; error?: string }> {
  const { userId, conversation, addMessageToChat } = deps;

  deps.log(
    `[SEND] sendChatMessage: contact="${contactName}" groupId="${conversation.id}" isReady=${conversation.isReady} text="${text.slice(0, 40)}" reply=${!!replyingTo}`
  );

  if (!text.trim()) {
    deps.log('[SEND] Abort: texte vide');
    return { success: false };
  }

  const messageId = crypto.randomUUID();
  const sentAt = Date.now();

  // Reply preview (from the quoted message envelope), shared by the proto and the local echo.
  let replyToData: ChatMessage['replyTo'] = undefined;
  if (replyingTo) {
    const replyEnv = parseEnvelope(replyingTo.content);
    const replyPreview =
      replyEnv.kind === 'text' || replyEnv.kind === 'system'
        ? replyEnv.text.slice(0, 100)
        : replyEnv.kind === 'media'
          ? (replyEnv.caption?.slice(0, 100) ?? '[media]')
          : `[Sondage] ${replyEnv.question}`.slice(0, 100);
    replyToData = { id: replyingTo.id, senderId: replyingTo.senderId, content: replyPreview };
  }

  // Channels: server-authoritative, no outbox - encode and send directly.
  if (isChannelConversationId(contactName)) {
    const payload = replyingTo
      ? encodeAppMessage({
          ...mkReply(text, {
            id: replyingTo.id,
            senderId: replyingTo.senderId,
            preview: replyToData?.content ?? '',
          }),
          messageId,
          sentAt,
        })
      : encodeAppMessage({ ...mkText(text), messageId, sentAt });
    try {
      const rawChannelId = contactName.replace(/^channel_/, '');
      await sendEncryptedChannelMessage(rawChannelId, payload, messageId);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: `Échec de l'envoi : ${error.message || String(error)}` };
    }
  }

  // Whole lineage deleted without a successor: the only hard block (deletion banner is shown).
  if (conversation.deletedRemotely) {
    return { success: false, error: 'Cette conversation a été supprimée.' };
  }

  // Optimistic echo (status pending, persisted so it survives reload), then enqueue.
  const envelope = serializeEnvelope(mkTextEnvelope(text, replyToData));
  await addMessageToChat(userId, envelope, contactName, {
    messageId,
    status: 'pending',
    timestamp: new Date(sentAt),
    ...(replyToData ? { replyTo: replyToData } : {}),
  });

  const entry: OutboxEntry = {
    id: messageId,
    conversationId: conversation.id,
    sentAt,
    kind: replyingTo ? 'reply' : 'text',
    text,
    ...(replyToData
      ? {
          replyTo: {
            id: replyToData.id,
            senderId: replyToData.senderId,
            preview: replyToData.content,
          },
        }
      : {}),
    status: 'pending',
    attempts: 0,
    createdAt: sentAt,
  };
  await enqueueOutboxMessage(entry);
  deps.log(`[SEND] ${messageId.slice(0, 8)}… mis en file (pending)`);
  return { success: true };
}

/** Minimal dependencies shared by reaction, edit, delete, and read-receipt helpers. */
interface MessageActionDeps {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversation: Conversation;
  /** Display name of the current user - used as actor in reaction notifications. */
  currentUserDisplayName?: string;
}

/**
 * Notifies the author of a message that the current user reacted to it.
 * Fire-and-forget REST call - the server never sees MLS plaintext.
 * Exported so it can be reused by other callers (e.g. channel reactions).
 */
export async function notifyReaction(params: {
  groupId: string;
  targetSenderId: string;
  emoji: string;
  messagePreview: string;
  actorName: string;
}): Promise<void> {
  console.log('[notifyReaction] POST notify-reaction', {
    groupId: params.groupId.slice(0, 8),
    targetSenderId: params.targetSenderId.slice(0, 8),
    emoji: params.emoji,
  });
  const resp = await fetch('/api/mls/notify-reaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.warn(`[notifyReaction] Échec HTTP ${resp.status}:`, text.slice(0, 200));
  } else {
    console.log('[notifyReaction] Notification réaction envoyée avec succès');
  }
}

/**
 * Sends an emoji reaction to a message via the MLS group, then persists the updated MLS state.
 * Also notifies the message author via a server-side push if they are a different user.
 * Silently ignored if the conversation is not ready.
 */
export async function addReaction(
  messageId: string,
  emoji: string,
  deps: MessageActionDeps
): Promise<void> {
  const { mlsService, userId, conversation, currentUserDisplayName } = deps;

  if (!conversation.isReady) return;

  try {
    const payload = encodeAppMessage(mkReaction(messageId, emoji));
    // silent=true: MLS state sync only, the push notification is sent via notifyReaction instead
    await mlsService.sendMessage(conversation.id, payload, undefined, true);
    scheduleOutboundMlsPersist();

    // Notify the message author (fire-and-forget, non-fatal)
    const targetMsg = conversation.messages.find((m) => m.id === messageId);
    if (targetMsg?.senderId && targetMsg.senderId !== userId) {
      const preview = String(targetMsg.content ?? '').slice(0, 60);
      void notifyReaction({
        groupId: conversation.id,
        targetSenderId: targetMsg.senderId,
        emoji,
        messagePreview: preview,
        actorName: currentUserDisplayName ?? userId,
      }).catch(() => {});
    }
  } catch (e) {
    console.warn('Failed to send reaction:', e);
  }
}

/**
 * Removes an emoji reaction from a message by broadcasting a `remove_reaction`
 * system event through MLS so all peers update their local reaction state.
 */
export async function removeReaction(
  messageId: string,
  emoji: string,
  deps: MessageActionDeps
): Promise<void> {
  const { mlsService, conversation } = deps;

  if (!conversation.isReady) return;

  try {
    const payload = encodeAppMessage(
      mkSystem('remove_reaction', JSON.stringify({ messageId, emoji }))
    );
    await mlsService.sendMessage(conversation.id, payload, undefined, true);
    scheduleOutboundMlsPersist();
  } catch (e) {
    console.warn('Failed to send remove_reaction:', e);
  }
}
/** Sends an "edit_message" system message so all peers update the message content in their local history. */
export async function editMessage(
  messageId: string,
  newContent: string,
  deps: MessageActionDeps
): Promise<void> {
  const { mlsService, conversation } = deps;
  if (!conversation.isReady) return;
  try {
    const editedAt = Date.now();
    const payload = encodeAppMessage(
      mkSystem('edit_message', JSON.stringify({ messageId, newContent, editedAt }))
    );
    await mlsService.sendMessage(conversation.id, payload, undefined, true);
    scheduleOutboundMlsPersist();
  } catch (e) {
    console.warn('Failed to edit message:', e);
  }
}

/** Sends a "delete_message" system message so all peers remove the message from their local history. */
export async function deleteMessage(messageId: string, deps: MessageActionDeps): Promise<void> {
  const { mlsService, conversation } = deps;
  if (!conversation.isReady) return;
  try {
    const payload = encodeAppMessage(mkSystem('delete_message', JSON.stringify({ messageId })));
    await mlsService.sendMessage(conversation.id, payload, undefined, true);
    scheduleOutboundMlsPersist();
  } catch (e) {
    console.warn('Failed to delete message:', e);
  }
}

/** Sends a "pin"/"unpin" system message so all members share the pinned-messages set. */
export async function setMessagePinned(
  messageId: string,
  pinned: boolean,
  deps: MessageActionDeps
): Promise<void> {
  const { mlsService, conversation } = deps;
  if (!conversation.isReady) return;
  try {
    const payload = encodeAppMessage(
      mkSystem(pinned ? 'pin' : 'unpin', JSON.stringify({ messageId }))
    );
    await mlsService.sendMessage(conversation.id, payload, undefined, true /* silent */);
    scheduleOutboundMlsPersist();
  } catch (e) {
    console.warn('Failed to (un)pin message:', e);
  }
}

/** Sends a "read_receipt" system message so peers can update delivered/read status for the given messageIds. Returns false if the group is not ready or the list is empty. */
export async function sendReadReceipt(
  messageIds: string[],
  deps: MessageActionDeps
): Promise<boolean> {
  const { mlsService, conversation } = deps;
  if (!conversation.isReady || messageIds.length === 0) return false;
  try {
    const payload = encodeAppMessage(mkSystem('read_receipt', JSON.stringify({ messageIds })));
    await mlsService.sendMessage(conversation.id, payload, undefined, true /* silent */);
    scheduleOutboundMlsPersist();
    return true;
  } catch (e) {
    console.warn('Failed to send read receipt:', e);
    return false;
  }
}
