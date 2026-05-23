import { messageTime } from '$lib/utils/chat/messageOrder';
import { serializeEnvelope, mkTextEnvelope, mkMediaEnvelope } from '$lib/envelope';

/** Returns true if the message was sent by the current user (case-insensitive). */
export function isOwnMessage(senderId: string, userId: string): boolean {
  return senderId.toLowerCase() === userId.toLowerCase();
}
import { mediaKindToType, type IAppMessage } from '$lib/proto/codec';
import { bytesToHex } from '$lib/utils/hex';
import type { AddMessageToChatOptions, ChatMessage, MessageReference } from '$lib/types';

/** Inbound messages older than this are not treated as a live receive (no tone). */
export const STALE_INBOUND_MS = 2 * 60 * 1000;

/**
 * Resolves the timestamp for a message being inserted into a conversation.
 * Prefers explicit options, then an existing in-memory copy, then queue/history fallback.
 */
/** Normalizes a message id for dedup / timestamp reuse (empty strings treated as absent). */
export function normalizeMessageId(messageId: string | undefined | null): string | undefined {
  const id = messageId?.trim();
  return id ? id : undefined;
}

/**
 * Cutoff for "just received" bubble animation: messages at or before this time are static.
 * Uses the newest stored timestamp (or now when empty) so startup catch-up does not re-animate history.
 */
export function computeMessageListSwitchTime(messages: readonly ChatMessage[]): number {
  if (messages.length === 0) return Date.now();
  return messages.reduce((max, m) => Math.max(max, messageTime(m)), 0);
}

export function resolveMessageTimestamp(
  options: Pick<AddMessageToChatOptions, 'timestamp' | 'messageId'>,
  existingMessages: readonly ChatMessage[],
  isOwn: boolean,
  fallbackMs?: number
): Date {
  if (options.timestamp instanceof Date && Number.isFinite(options.timestamp.getTime())) {
    return options.timestamp;
  }
  const messageId = normalizeMessageId(options.messageId);
  if (messageId) {
    const existing = existingMessages.find((m) => m.id === messageId);
    if (existing) {
      return existing.timestamp instanceof Date ? existing.timestamp : new Date(existing.timestamp);
    }
  }
  if (fallbackMs !== undefined && Number.isFinite(fallbackMs)) {
    return new Date(fallbackMs);
  }
  return new Date();
}

/** True when an inbound message should not trigger receive tone / "just arrived" UX. */
export function isStaleInboundMessage(timestamp: Date, now = Date.now()): boolean {
  return now - timestamp.getTime() > STALE_INBOUND_MS;
}

/**
 * Convert a decoded AppMessage to { content, options } ready for addMessageToChat.
 * Returns null for non-displayable types (reaction, system, call) which require
 * special handling at the call site.
 *
 * @param fallbackTimestamp Used when the message has no sentAt (e.g. history replay
 *   where the Redis stream timestamp should serve as fallback).
 */
export function appMsgToEnvelope(
  msg: IAppMessage,
  fallbackTimestamp?: Date
): {
  content: string;
  options: Pick<AddMessageToChatOptions, 'messageId' | 'replyTo' | 'timestamp'>;
} | null {
  const timestamp =
    (msg.sentAt && msg.sentAt > 0 ? new Date(msg.sentAt) : undefined) ?? fallbackTimestamp;

  if (msg.text) {
    return {
      content: serializeEnvelope(mkTextEnvelope(msg.text.content ?? '')),
      options: { messageId: msg.messageId || undefined, timestamp },
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
      options: { messageId: msg.messageId || undefined, replyTo, timestamp },
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
      options: { messageId: msg.messageId || undefined, timestamp },
    };
  }

  return null;
}
