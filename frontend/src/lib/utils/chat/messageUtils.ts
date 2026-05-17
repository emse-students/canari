import { serializeEnvelope, mkTextEnvelope, mkMediaEnvelope } from '$lib/envelope';
import { mediaKindToType, type IAppMessage } from '$lib/proto/codec';
import { bytesToHex } from '$lib/utils/hex';
import type { AddMessageToChatOptions, MessageReference } from '$lib/types';

/**
 * Convert a decoded AppMessage to { content, options } ready for addMessageToChat.
 * Returns null for non-displayable types (reaction, system, call) which require
 * special handling at the call site.
 */
export function appMsgToEnvelope(
  msg: IAppMessage
): { content: string; options: Pick<AddMessageToChatOptions, 'messageId' | 'replyTo'> } | null {
  if (msg.text) {
    return {
      content: serializeEnvelope(mkTextEnvelope(msg.text.content ?? '')),
      options: { messageId: msg.messageId || undefined },
    };
  }

  if (msg.reply) {
    const replyTo: MessageReference | undefined = msg.reply.replyTo
      ? {
          id: msg.reply.replyTo.id ?? '',
          senderId: msg.reply.replyTo.senderId ?? '',
          content: msg.reply.replyTo.preview ?? '',
        }
      : undefined;
    return {
      content: serializeEnvelope(mkTextEnvelope(msg.reply.content ?? '', replyTo)),
      options: { messageId: msg.messageId || undefined, replyTo },
    };
  }

  if (msg.media) {
    return {
      content: serializeEnvelope(
        mkMediaEnvelope(
          {
            type: mediaKindToType(msg.media.kind),
            mediaId: msg.media.mediaId ?? '',
            key: bytesToHex(msg.media.key),
            iv: bytesToHex(msg.media.iv),
            mimeType: msg.media.mimeType ?? '',
            size: msg.media.size ?? 0,
            fileName: msg.media.fileName ?? undefined,
            width: msg.media.width && msg.media.width > 0 ? msg.media.width : undefined,
            height: msg.media.height && msg.media.height > 0 ? msg.media.height : undefined,
          },
          msg.media.caption || undefined
        )
      ),
      options: { messageId: msg.messageId || undefined },
    };
  }

  return null;
}
