import { toHex } from '$lib/utils/hex';
import type { StoredMessage } from '$lib/db';
import type { ChatMessage } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import { decodeAppMessage } from '$lib/proto/codec';

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

        const decryptedBytes = await mlsService.processIncomingMessage(groupId, bytes);
        if (!decryptedBytes) continue;

        const parsed = decodeAppMessage(decryptedBytes);

        if (parsed?.text) {
          if (parsed.text.content) {
            await addMessageToChat(msg.sender_id, parsed.text.content ?? '', contactName, undefined, false, parsed.messageId || undefined);
            addedMsg++;
            mlsUpdated = true;
            continue;
          }
        } else if (parsed?.reply) {
          await addMessageToChat(
            msg.sender_id,
            parsed.reply.content ?? '',
            contactName,
            parsed.reply.replyTo
              ? { id: parsed.reply.replyTo.id ?? '', senderId: parsed.reply.replyTo.senderId ?? '', content: parsed.reply.replyTo.preview ?? '' }
              : undefined,
            false,
            parsed.messageId || undefined
          );
          addedMsg++;
          mlsUpdated = true;
          continue;
        } else if (parsed?.media) {
          const mediaJson = JSON.stringify({
            type: parsed.media.kind,
            mediaId: parsed.media.mediaId,
            mimeType: parsed.media.mimeType,
            size: parsed.media.size,
            fileName: parsed.media.fileName,
          });
          await addMessageToChat(msg.sender_id, mediaJson, contactName, undefined, false, parsed.messageId || undefined);
          addedMsg++;
          mlsUpdated = true;
          continue;
        } else if (parsed?.reaction || parsed?.system) {
          // Control/reaction messages don't add chat entries in history replay
          mlsUpdated = true;
          continue;
        } else {
          // Legacy plain text or unknown format
          const legacyText = new TextDecoder().decode(decryptedBytes);
          await addMessageToChat(msg.sender_id, legacyText, contactName);
          addedMsg++;
          mlsUpdated = true;
          continue;
        }
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
