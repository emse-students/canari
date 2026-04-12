import type { IMlsService } from '$lib/mlsService';
import type { ChatMessage, Conversation } from '$lib/types';
import { toHex } from '$lib/utils/hex';
import { encodeAppMessage, mkText, mkReply, mkReaction, mkSystem } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, parseEnvelope } from '$lib/envelope';
import { sendEncryptedChannelMessage } from '$lib/utils/chat/channelCrypto';

interface SendMessageDeps {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversation: Conversation;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    replyTo?: ChatMessage['replyTo'],
    isSystem?: boolean,
    messageId?: string
  ) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Envoie un message texte dans une conversation.
 * Supporte les réponses à un message précédent.
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
      });
      replyToData = {
        id: replyingTo.id,
        senderId: replyingTo.senderId,
        content: replyPreview,
      };
    } else {
      payload = encodeAppMessage({ ...mkText(text), messageId });
    }

    if (contactName.startsWith('channel_')) {
      const actualChannelId = contactName.replace('channel_', ''); // extract the db id
      await sendEncryptedChannelMessage(actualChannelId, payload, messageId);
      // Show message optimistically with the same messageId.
      // When the WS echo arrives with data.id === messageId, the dedup guard
      // in addMessageToChat silently drops it — so the message appears once.
      await addMessageToChat(
        userId,
        serializeEnvelope(mkTextEnvelope(text, replyToData)),
        contactName,
        undefined,
        false,
        messageId
      );
    } else {
      deps.log(`[SEND] Appel mlsService.sendMessage groupId="${conversation.id}"...`);
      // Passes messageId so WebMlsService can wait for the gateway ACK (message_sent event)
      // before resolving — the UI will only show the message after the gateway confirms delivery.
      await mlsService.sendMessage(conversation.id, payload, messageId);
      deps.log(`[SEND] mlsService.sendMessage confirmé — sauvegarde état MLS...`);
      const stateBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
      deps.log(`[SEND] État MLS sauvegardé — affichage message confirmé...`);

      // Display only after gateway confirmed delivery
      await addMessageToChat(
        userId,
        serializeEnvelope(mkTextEnvelope(text, replyToData)),
        contactName,
        undefined,
        false,
        messageId
      );
      deps.log(`[SEND] Message affiché (confirmé gateway) pour messageId=${messageId}`);
    }
    return { success: true };
  } catch (error: any) {
    const msg = error.message || String(error);
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

interface AddReactionDeps {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversation: Conversation;
}

/**
 * Ajoute une réaction emoji à un message.
 */
export async function addReaction(
  messageId: string,
  emoji: string,
  deps: AddReactionDeps
): Promise<void> {
  const { mlsService, userId, pin, conversation } = deps;

  if (!conversation.isReady) return;

  try {
    const payload = encodeAppMessage(mkReaction(messageId, emoji));
    await mlsService.sendMessage(conversation.id, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
  } catch (e) {
    console.warn('Failed to send reaction:', e);
  }
}

/**
 * Retire une réaction emoji d'un message (envoi d'un event système).
 */
export async function removeReaction(
  messageId: string,
  emoji: string,
  deps: AddReactionDeps
): Promise<void> {
  const { mlsService, userId, pin, conversation } = deps;

  if (!conversation.isReady) return;

  try {
    const payload = encodeAppMessage(
      mkSystem('remove_reaction', JSON.stringify({ messageId, emoji }))
    );
    await mlsService.sendMessage(conversation.id, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
  } catch (e) {
    console.warn('Failed to send remove_reaction:', e);
  }
}
export async function editMessage(
  messageId: string,
  newContent: string,
  deps: AddReactionDeps
): Promise<void> {
  const { mlsService, userId, pin, conversation } = deps;
  if (!conversation.isReady) return;
  try {
    const editedAt = Date.now();
    const payload = encodeAppMessage(
      mkSystem('edit_message', JSON.stringify({ messageId, newContent, editedAt }))
    );
    await mlsService.sendMessage(conversation.id, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
  } catch (e) {
    console.warn('Failed to edit message:', e);
  }
}

export async function deleteMessage(messageId: string, deps: AddReactionDeps): Promise<void> {
  const { mlsService, userId, pin, conversation } = deps;
  if (!conversation.isReady) return;
  try {
    const payload = encodeAppMessage(mkSystem('delete_message', JSON.stringify({ messageId })));
    await mlsService.sendMessage(conversation.id, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
  } catch (e) {
    console.warn('Failed to delete message:', e);
  }
}

export async function sendReadReceipt(
  messageIds: string[],
  deps: AddReactionDeps
): Promise<boolean> {
  const { mlsService, userId, pin, conversation } = deps;
  if (!conversation.isReady || messageIds.length === 0) return false;
  try {
    const payload = encodeAppMessage(mkSystem('read_receipt', JSON.stringify({ messageIds })));
    await mlsService.sendMessage(conversation.id, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
    return true;
  } catch (e) {
    console.warn('Failed to send read receipt:', e);
    return false;
  }
}
