import type { IMlsService } from '$lib/mlsService';
import type { ChatMessage, Conversation } from '$lib/types';
import { saveMlsState } from '$lib/utils/hex';
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
  mlsService: IMlsService;
  userId: string;
  pin: string;
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
  patchMessage?: (
    messageId: string,
    contactName: string,
    patch: { status: ChatMessage['status'] }
  ) => void;
  log: (msg: string) => void;
}

/**
 * Sends a text message in a conversation, optionally as a reply to a previous message.
 *
 * For direct/group MLS conversations the message is encrypted by the WASM MLS service
 * and displayed optimistically (status `'sending'`) before the network call confirms it.
 * For channel conversations (`contactName` starts with `'channel_'`) the message is
 * encrypted via `sendEncryptedChannelMessage` and the local copy is never persisted to DB.
 *
 * Returns `{ success: false }` silently when the text is empty or the conversation
 * is not yet ready, and `{ success: false, error }` with a user-facing message on failure.
 */
export async function sendChatMessage(
  text: string,
  contactName: string,
  replyingTo: ChatMessage | null,
  deps: SendMessageDeps
): Promise<{ success: boolean; error?: string }> {
  const { mlsService, userId, pin, conversation, addMessageToChat } = deps;

  deps.log(
    `[SEND] sendChatMessage: contact="${contactName}" groupId="${conversation.id}" isReady=${conversation.isReady} text="${text.slice(0, 40)}" reply=${!!replyingTo}`
  );

  if (!text.trim() || !conversation.isReady) {
    deps.log(`[SEND] Abort: text vide ou convo non prête (isReady=${conversation.isReady})`);
    return { success: false };
  }

  try {
    // Build proto payload based on reply state
    let payload: Uint8Array;
    let replyToData: ChatMessage['replyTo'] = undefined;
    const messageId = crypto.randomUUID();

    const sentAt = Date.now();

    if (replyingTo) {
      // Extract the display text from the envelope for the reply preview.
      const replyEnv = parseEnvelope(replyingTo.content);
      const replyPreview =
        replyEnv.kind === 'text'
          ? replyEnv.text.slice(0, 100)
          : replyEnv.kind === 'media'
            ? (replyEnv.caption?.slice(0, 100) ?? '[media]')
            : replyEnv.text.slice(0, 100);
      payload = encodeAppMessage({
        ...mkReply(text, {
          id: replyingTo.id,
          senderId: replyingTo.senderId,
          preview: replyPreview,
        }),
        messageId,
        sentAt,
      });
      replyToData = {
        id: replyingTo.id,
        senderId: replyingTo.senderId,
        content: replyPreview,
      };
    } else {
      payload = encodeAppMessage({ ...mkText(text), messageId, sentAt });
    }

    if (isChannelConversationId(contactName)) {
      const rawChannelId = contactName.replace(/^channel_/, '');
      await sendEncryptedChannelMessage(rawChannelId, payload, messageId);
      // No optimistic add: the backend echoes channel.message.created to all members
      // including the sender, so the WS handler will add the message.
    } else {
      const envelope = serializeEnvelope(mkTextEnvelope(text, replyToData));

      await addMessageToChat(userId, envelope, contactName, {
        messageId,
        status: 'sending',
        skipDbSave: true,
      });
      deps.log(`[SEND] Message affiché (optimiste)...`);

      try {
        await mlsService.sendMessage(conversation.id, payload, messageId);
        deps.log(`[SEND] mlsService.sendMessage confirmé - sauvegarde état MLS...`);
        try {
          const stateBytes = await mlsService.saveState(pin);
          await saveMlsState(userId, stateBytes);
        } catch (saveErr) {
          console.warn('[SEND] MLS state persist failed (quota?)', saveErr);
        }
        deps.patchMessage?.(messageId, contactName, { status: 'sent' });
        deps.log(`[SEND] Message envoyé pour messageId=${messageId}`);
      } catch (sendErr) {
        deps.patchMessage?.(messageId, contactName, { status: 'error' });
        throw sendErr;
      }
    }
    return { success: true };
  } catch (error: any) {
    const msg = error.message || String(error);
    console.error('[SEND] sendChatMessage failed:', msg);
    if (msg.includes('NotMember') || msg.includes('NotAMember')) {
      return {
        success: false,
        error: "Tu n'es plus membre de ce groupe. Supprime-le et demande une nouvelle invitation.",
      };
    } else {
      return {
        success: false,
        error: `Échec de l'envoi : ${msg}`,
      };
    }
  }
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
  const { mlsService, userId, pin, conversation, currentUserDisplayName } = deps;

  if (!conversation.isReady) return;

  try {
    const payload = encodeAppMessage(mkReaction(messageId, emoji));
    // silent=true: MLS state sync only, the push notification is sent via notifyReaction instead
    await mlsService.sendMessage(conversation.id, payload, undefined, true);
    const stateBytes = await mlsService.saveState(pin);
    await saveMlsState(userId, stateBytes);

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
  const { mlsService, userId, pin, conversation } = deps;

  if (!conversation.isReady) return;

  try {
    const payload = encodeAppMessage(
      mkSystem('remove_reaction', JSON.stringify({ messageId, emoji }))
    );
    await mlsService.sendMessage(conversation.id, payload, undefined, true);
    const stateBytes = await mlsService.saveState(pin);
    await saveMlsState(userId, stateBytes);
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
  const { mlsService, userId, pin, conversation } = deps;
  if (!conversation.isReady) return;
  try {
    const editedAt = Date.now();
    const payload = encodeAppMessage(
      mkSystem('edit_message', JSON.stringify({ messageId, newContent, editedAt }))
    );
    await mlsService.sendMessage(conversation.id, payload, undefined, true);
    const stateBytes = await mlsService.saveState(pin);
    await saveMlsState(userId, stateBytes);
  } catch (e) {
    console.warn('Failed to edit message:', e);
  }
}

/** Sends a "delete_message" system message so all peers remove the message from their local history. */
export async function deleteMessage(messageId: string, deps: MessageActionDeps): Promise<void> {
  const { mlsService, userId, pin, conversation } = deps;
  if (!conversation.isReady) return;
  try {
    const payload = encodeAppMessage(mkSystem('delete_message', JSON.stringify({ messageId })));
    await mlsService.sendMessage(conversation.id, payload, undefined, true);
    const stateBytes = await mlsService.saveState(pin);
    await saveMlsState(userId, stateBytes);
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
  const { mlsService, userId, pin, conversation } = deps;
  if (!conversation.isReady) return;
  try {
    const payload = encodeAppMessage(
      mkSystem(pinned ? 'pin' : 'unpin', JSON.stringify({ messageId }))
    );
    await mlsService.sendMessage(conversation.id, payload, undefined, true /* silent */);
    const stateBytes = await mlsService.saveState(pin);
    await saveMlsState(userId, stateBytes);
  } catch (e) {
    console.warn('Failed to (un)pin message:', e);
  }
}

/** Sends a "read_receipt" system message so peers can update delivered/read status for the given messageIds. Returns false if the group is not ready or the list is empty. */
export async function sendReadReceipt(
  messageIds: string[],
  deps: MessageActionDeps
): Promise<boolean> {
  const { mlsService, userId, pin, conversation } = deps;
  if (!conversation.isReady || messageIds.length === 0) return false;
  try {
    const payload = encodeAppMessage(mkSystem('read_receipt', JSON.stringify({ messageIds })));
    await mlsService.sendMessage(conversation.id, payload, undefined, true /* silent */);
    const stateBytes = await mlsService.saveState(pin);
    await saveMlsState(userId, stateBytes);
    return true;
  } catch (e) {
    console.warn('Failed to send read receipt:', e);
    return false;
  }
}
