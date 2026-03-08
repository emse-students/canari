import type { IMlsService } from '$lib/mlsService';
import type { ChatMessage, Conversation } from '$lib/types';
import { toHex } from '$lib/utils/hex';

interface SendMessageDeps {
  mlsService: IMlsService;
  userId: string;
  pin: string;
  conversation: Conversation;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    replyTo?: ChatMessage['replyTo']
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
    // Build payload based on reply state
    let payload: string;
    let replyToData: ChatMessage['replyTo'] = undefined;

    if (replyingTo) {
      payload = JSON.stringify({
        type: 'reply',
        content: text,
        replyTo: {
          id: replyingTo.id,
          senderId: replyingTo.senderId,
          content: replyingTo.content.slice(0, 100), // preview only
        },
      });
      replyToData = {
        id: replyingTo.id,
        senderId: replyingTo.senderId,
        content: replyingTo.content.slice(0, 100),
      };
    } else {
      payload = JSON.stringify({ type: 'text', content: text });
    }

    await mlsService.sendMessage(conversation.groupId, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
    await addMessageToChat(userId, text, contactName, replyToData);

    return { success: true };
  } catch (_e: unknown) {
    const msg = _e instanceof Error ? _e.message : String(_e);
    log(`Erreur envoi: ${msg}`);

    if (
      msg.includes('Groupe introuvable') ||
      msg.includes('not found') ||
      msg.includes('group')
    ) {
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
  updateLocalReaction: (messageId: string, emoji: string) => void;
}

/**
 * Ajoute une réaction emoji à un message.
 */
export async function addReaction(
  messageId: string,
  emoji: string,
  deps: AddReactionDeps
): Promise<void> {
  const { mlsService, userId, pin, conversation, updateLocalReaction } = deps;

  if (!conversation.isReady) return;

  try {
    const payload = JSON.stringify({ type: 'reaction', messageId, emoji });
    await mlsService.sendMessage(conversation.groupId, payload);
    const stateBytes = await mlsService.saveState(pin);
    localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));

    // Update local reactions immediately
    updateLocalReaction(messageId, emoji);
  } catch (e) {
    console.warn('Failed to send reaction:', e);
  }
}
