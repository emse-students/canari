import { toHex } from '$lib/utils/hex';
import type { StoredMessage } from '$lib/db';
import type { ChatMessage } from '$lib/types';
import type { IMlsService } from '$lib/mlsService';
import { decodeAppMessage, MediaKind } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, mkMediaEnvelope } from '$lib/envelope';

function bytesToHex(bytes?: Uint8Array | null): string {
  if (!bytes || bytes.length === 0) return '';
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function mediaKindToType(kind?: number | null): 'image' | 'video' | 'audio' | 'file' {
  switch (kind) {
    case MediaKind.MEDIA_IMAGE:
      return 'image';
    case MediaKind.MEDIA_VIDEO:
      return 'video';
    case MediaKind.MEDIA_AUDIO:
      return 'audio';
    default:
      return 'file';
  }
}

export function mapStoredMessagesToChatMessages(storedMessages: StoredMessage[], userId: string) {
  return storedMessages.map((m) => {
    // Content is a serialized MessageEnvelope (new) or legacy JSON/plain-text.
    // parseEnvelope handles all three cases transparently.
    let content = m.content;
    let replyTo: ChatMessage['replyTo'] = undefined;

    try {
      const parsed = JSON.parse(m.content);
      // Legacy format: { content: string, replyTo?: ... }
      if (parsed.content && !parsed.kind) {
        content = serializeEnvelope(mkTextEnvelope(parsed.content, parsed.replyTo));
        replyTo = parsed.replyTo;
      }
      // New envelope format — content stays as-is, replyTo is inside the envelope.
    } catch {
      // Legacy plain text — leave content as-is; parseEnvelope will wrap it.
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
            await addMessageToChat(
              msg.sender_id,
              serializeEnvelope(mkTextEnvelope(parsed.text.content ?? '')),
              contactName,
              undefined,
              false,
              parsed.messageId || undefined
            );
            addedMsg++;
            mlsUpdated = true;
            continue;
          }
        } else if (parsed?.reply) {
          const replyTo = parsed.reply.replyTo
            ? {
                id: parsed.reply.replyTo.id ?? '',
                senderId: parsed.reply.replyTo.senderId ?? '',
                content: parsed.reply.replyTo.preview ?? '',
              }
            : undefined;
          await addMessageToChat(
            msg.sender_id,
            serializeEnvelope(mkTextEnvelope(parsed.reply.content ?? '', replyTo)),
            contactName,
            undefined,
            false,
            parsed.messageId || undefined
          );
          addedMsg++;
          mlsUpdated = true;
          continue;
        } else if (parsed?.media) {
          await addMessageToChat(
            msg.sender_id,
            serializeEnvelope(
              mkMediaEnvelope(
                {
                  type: mediaKindToType(parsed.media.kind),
                  mediaId: parsed.media.mediaId ?? '',
                  key: bytesToHex(parsed.media.key),
                  iv: bytesToHex(parsed.media.iv),
                  mimeType: parsed.media.mimeType ?? '',
                  size: parsed.media.size ?? 0,
                  fileName: parsed.media.fileName ?? undefined,
                },
                parsed.media.caption || undefined
              )
            ),
            contactName,
            undefined,
            false,
            parsed.messageId || undefined
          );
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
          await addMessageToChat(
            msg.sender_id,
            serializeEnvelope(mkTextEnvelope(legacyText)),
            contactName
          );
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
