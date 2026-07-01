import type { IMlsService } from '$lib/mlsService';
import type { ChatMessage, Conversation } from '$lib/types';
import type { OutboxEntry } from '$lib/db';
import { enqueueOutboxMessage } from './outbox';
import { apiFetch } from '$lib/utils/apiFetch';
import { encodeAppMessage, mkText, mkReply, mkReaction, mkSystem } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, parseEnvelope } from '$lib/envelope';
import {
  sendEncryptedChannelMessage,
  isChannelConversationId,
} from '$lib/utils/chat/channelCrypto';
import { extractMentionUserIds } from '$lib/utils/mentions';

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
    `[SEND] sendChatMessage: contact="${contactName}" groupId="${conversation.id}" lifecycle=${conversation.lifecycle} text="${text.slice(0, 40)}" reply=${!!replyingTo}`
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
      // Cleartext mention targets let the server route the `mentions` notification level.
      const mentionedUserIds = extractMentionUserIds(text);
      await sendEncryptedChannelMessage(
        rawChannelId,
        payload,
        messageId,
        undefined,
        mentionedUserIds
      );
      return { success: true };
    } catch (error: any) {
      return { success: false, error: `Échec de l'envoi : ${error.message || String(error)}` };
    }
  }

  // Whole lineage deleted without a successor: the only hard block (deletion banner is shown).
  if (conversation.lifecycle === 'removed') {
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
 * Captures a pre-encoded control AppMessage (reaction, edit, delete, pin, read receipt) into the
 * durable outbox instead of sending it fire-and-forget. The flusher delivers it (silent, retried
 * with backoff, re-keyed to a rebooted successor) as soon as the group is sendable, so control
 * events converge across peers even if the group was momentarily unsendable, or the app reloaded
 * or was killed before the original direct send could go through.
 */
async function enqueueControlEvent(conversationId: string, proto: Uint8Array): Promise<void> {
  const now = Date.now();
  await enqueueOutboxMessage({
    id: crypto.randomUUID(),
    conversationId,
    sentAt: now,
    kind: 'control',
    controlProto: proto,
    status: 'pending',
    attempts: 0,
    createdAt: now,
  });
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
  // apiFetch attache le Bearer token (en memoire, jamais en cookie) et rejoue une fois sur 401
  // apres refresh. Un fetch brut partait sans Authorization -> nginx auth_request echouait -> 401.
  try {
    const resp = await apiFetch('/api/mls/notify-reaction', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`[notifyReaction] Échec HTTP ${resp.status}:`, text.slice(0, 200));
    } else {
      console.log('[notifyReaction] Notification réaction envoyée avec succès');
    }
  } catch (e) {
    // Fire-and-forget : une session expiree ne doit pas remonter une erreur a l'appelant.
    console.warn(`[notifyReaction] Échec: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Sends an emoji reaction to a message via the durable outbox (MLS broadcast), and notifies the
 * message author via a server-side push if they are a different user. The reaction is captured
 * into the outbox so it converges on peers even if the group is momentarily unsendable.
 */
export async function addReaction(
  messageId: string,
  emoji: string,
  deps: MessageActionDeps
): Promise<void> {
  const { userId, conversation, currentUserDisplayName } = deps;

  await enqueueControlEvent(conversation.id, encodeAppMessage(mkReaction(messageId, emoji)));

  // Notify the message author (fire-and-forget, non-fatal).
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
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkSystem('remove_reaction', JSON.stringify({ messageId, emoji })))
  );
}
/** Captures an "edit_message" system event in the durable outbox so all peers update the message content in their local history. */
export async function editMessage(
  messageId: string,
  newContent: string,
  deps: MessageActionDeps
): Promise<void> {
  const editedAt = Date.now();
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkSystem('edit_message', JSON.stringify({ messageId, newContent, editedAt })))
  );
}

/** Captures a "delete_message" system event in the durable outbox so all peers remove the message from their local history. */
export async function deleteMessage(messageId: string, deps: MessageActionDeps): Promise<void> {
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkSystem('delete_message', JSON.stringify({ messageId })))
  );
}

/** Captures a "pin"/"unpin" system event in the durable outbox so all members share the pinned-messages set. */
export async function setMessagePinned(
  messageId: string,
  pinned: boolean,
  deps: MessageActionDeps
): Promise<void> {
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkSystem(pinned ? 'pin' : 'unpin', JSON.stringify({ messageId })))
  );
}

/** Captures a "read_receipt" system event in the durable outbox so peers update delivered/read status. Returns false only when the list is empty (the send itself is durable, never dropped). */
export async function sendReadReceipt(
  messageIds: string[],
  deps: MessageActionDeps
): Promise<boolean> {
  if (messageIds.length === 0) return false;
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkSystem('read_receipt', JSON.stringify({ messageIds })))
  );
  return true;
}
