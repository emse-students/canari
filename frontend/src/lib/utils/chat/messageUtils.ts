import { messageTime } from '$lib/utils/chat/messageOrder';
import { serializeEnvelope, mkTextEnvelope, mkMediaEnvelope, mkPollEnvelope } from '$lib/envelope';

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
  if (
    options.timestamp instanceof Date &&
    Number.isFinite(options.timestamp.getTime()) &&
    options.timestamp.getTime() > 0
  ) {
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

/** Extracts `AppMessage.sentAt` as Unix ms (handles protobufjs `Long` and plain numbers). */
export function appMessageSentAtMs(sentAt: unknown): number | undefined {
  if (sentAt == null) return undefined;
  let n: number;
  if (typeof sentAt === 'number') {
    n = sentAt;
  } else if (typeof sentAt === 'object' && sentAt !== null && 'toNumber' in sentAt) {
    const converted = (sentAt as { toNumber: () => number }).toNumber();
    if (!Number.isFinite(converted)) return undefined;
    n = converted;
  } else {
    n = Number(sentAt);
  }
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolves display/storage time for a decrypted AppMessage.
 * Prefers client `sentAt` from the MLS plaintext; otherwise uses server time (ms).
 */
export function resolveAppMessageTimestampMs(
  msg: IAppMessage,
  serverFallbackMs?: number
): number | undefined {
  const sentMs = appMessageSentAtMs(msg.sentAt);
  if (sentMs !== undefined) return sentMs;
  if (serverFallbackMs !== undefined && Number.isFinite(serverFallbackMs) && serverFallbackMs > 0) {
    return serverFallbackMs;
  }
  return undefined;
}

/**
 * Convert a decoded AppMessage to { content, options } ready for addMessageToChat.
 * Returns null for non-displayable types (reaction, system, call) which require
 * special handling at the call site.
 *
 * @param serverFallbackMs Server queue/history time (ms) when `sentAt` is absent in the payload.
 */
export function appMsgToEnvelope(
  msg: IAppMessage,
  serverFallbackMs?: number
): {
  content: string;
  options: Pick<AddMessageToChatOptions, 'messageId' | 'replyTo' | 'timestamp'>;
} | null {
  const ms = resolveAppMessageTimestampMs(msg, serverFallbackMs);
  const timestamp = ms !== undefined ? new Date(ms) : undefined;

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

  if (msg.poll) {
    const options = (msg.poll.options ?? [])
      .map((o) => ({ id: o.id ?? '', label: o.label ?? '' }))
      .filter((o) => o.id);
    const endsAtMs = typeof msg.poll.endsAt === 'number' ? msg.poll.endsAt : 0;
    return {
      content: serializeEnvelope(
        mkPollEnvelope(
          msg.poll.question ?? '',
          options,
          msg.poll.multipleChoice === true,
          endsAtMs > 0 ? new Date(endsAtMs).toISOString() : null
        )
      ),
      options: { messageId: msg.messageId || undefined, timestamp },
    };
  }

  return null;
}
