import type { IMlsService } from '$lib/mlsService';
import type { ChatMessage, Conversation } from '$lib/types';
import { toHex } from '$lib/utils/hex';
import { encodeAppMessage, mkText, mkReply, mkReaction, mkSystem } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, parseEnvelope } from '$lib/envelope';
import { ChannelService } from '$lib/services/ChannelService';

const channelService = new ChannelService();

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
  const { mlsService, userId, pin, conversation, addMessageToChat, log } = deps;

  if (!text.trim() || !conversation.isReady) {
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
      await channelService.sendMessage(actualChannelId, {
        senderId: userId,
        nonce: Date.now().toString(), // Mock nonce for now since channels use MLS-based static keys which are WIP
        ciphertext: btoa(String.fromCharCode(...payload)),
      });
    } else {
      await mlsService.sendMessage(conversation.groupId, payload);
      const stateBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
    }

    await addMessageToChat(
      userId,
      serializeEnvelope(mkTextEnvelope(text, replyToData)),
      contactName,
      undefined,
      false,
      messageId
    );

    return { success: true };
  } catch (_e: unknown) {
    const msg = _e instanceof Error ? _e.message : String(_e);
    log(`Erreur envoi: ${msg}`);

    if (msg.includes('Groupe introuvable') || msg.includes('not found') || msg.includes('group')) {
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
    await mlsService.sendMessage(conversation.groupId, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
  } catch (e) {
    console.warn('Failed to send reaction:', e);
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
    await mlsService.sendMessage(conversation.groupId, payload);
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
    await mlsService.sendMessage(conversation.groupId, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
  } catch (e) {
    console.warn('Failed to delete message:', e);
  }
}

export async function sendReadReceipt(messageIds: string[], deps: AddReactionDeps): Promise<void> {
  const { mlsService, userId, pin, conversation } = deps;
  if (!conversation.isReady || messageIds.length === 0) return;
  try {
    const payload = encodeAppMessage(mkSystem('read_receipt', JSON.stringify({ messageIds })));
    await mlsService.sendMessage(conversation.groupId, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
  } catch (e) {
    console.warn('Failed to send read receipt:', e);
  }
}
