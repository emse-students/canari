import { toHex } from '$lib/utils/hex';
import type { StoredMessage } from '$lib/db';
import type { ChatMessage } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';

export function mapStoredMessagesToChatMessages(storedMessages: StoredMessage[], userId: string) {
  return storedMessages.map((m) => {
    let content = m.content;
    let replyTo: ChatMessage['replyTo'] = undefined;

    try {
      const parsed = JSON.parse(m.content);
      if (parsed.content) {
        content = parsed.content;
        replyTo = parsed.replyTo;
      }
    } catch {
      // Legacy plain text format
    }

    return {
      id: m.id,
      senderId: m.senderId,
      content,
      timestamp: new Date(m.timestamp),
      isOwn: m.senderId.toLowerCase() === userId.toLowerCase(),
      replyTo,
    } satisfies ChatMessage;
  });
}

export async function replayConversationHistory(params: {
  mlsService: IMlsService;
  groupId: string;
  contactName: string;
  userId: string;
  pin: string;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    replyTo?: { id: string; senderId: string; content: string },
    isSystem?: boolean,
    messageId?: string
  ) => Promise<void>;
  log: (msg: string) => void;
}) {
  const { mlsService, groupId, contactName, userId, pin, addMessageToChat, log } = params;

  try {
    const history = await mlsService.fetchHistory(groupId);
    if (history.length === 0) return;

    let addedMsg = 0;
    let mlsUpdated = false;

    for (const msg of history) {
      try {
        const bytesStr = atob(msg.content);
        const bytes = new Uint8Array(bytesStr.length);
        for (let i = 0; i < bytesStr.length; i++) bytes[i] = bytesStr.charCodeAt(i);

        const decrypted = await mlsService.processIncomingMessage(groupId, bytes);
        if (!decrypted) continue;

        try {
          const parsed = JSON.parse(decrypted);
          if (parsed.type === 'text' || parsed.type === 'reply') {
            const content = parsed.content;
            if (content) {
              await addMessageToChat(msg.sender_id, content, contactName, parsed.replyTo, false, parsed.id);
              addedMsg++;
              mlsUpdated = true;
              continue;
            }
          } else if (
             parsed.type === 'image' || 
             parsed.type === 'video' || 
             parsed.type === 'audio' || 
             parsed.type === 'file'
          ) {
            await addMessageToChat(msg.sender_id, decrypted, contactName, undefined, false, parsed.id);
            addedMsg++;
            mlsUpdated = true;
            continue;
          } else if (
            parsed.type === 'reaction' ||
            parsed.type === 'groupRenamed' ||
            parsed.type === 'memberRemoved' ||
            parsed.type === 'memberAdded' ||
            parsed.type === 'groupDeleted'
          ) {
            mlsUpdated = true;
            continue;
          }
        } catch {
          // Not JSON -> legacy plain text
        }

        await addMessageToChat(msg.sender_id, decrypted, contactName);
        addedMsg++;
        mlsUpdated = true;
      } catch (err) {
        if (String(err).includes('CannotDecryptOwnMessage')) {
          continue;
        }
        console.warn(`History msg error: ${err}`);
      }
    }

    if (mlsUpdated) {
      const stateBytes = await mlsService.saveState(pin);
      localStorage.setItem('mls_autosave_' + userId, toHex(stateBytes));
      log(`✅ ${addedMsg} msg rattrapés pour ${contactName}.`);
    }
  } catch {
    // Silently ignore errors in loading history
  }
}
