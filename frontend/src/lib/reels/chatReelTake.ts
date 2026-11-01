/**
 * THE ROWS OF ONE CHAT-REEL TAKE (reels-in-chat RC-13, 15.2): the `reel-take` outbox row holding the
 * file, and one SEND per conversation - its `media` outbox row naming the take, and the optimistic
 * message the sender sees. Pure: the composable writes them through `enqueueOutboxTake` (one
 * transaction), and RC-5's single conversation is simply the case of one target.
 */
import type { OutboxEntry, StoredMessage } from '$lib/db/types';
import { REEL_TAKE_QUEUE } from '$lib/db/outboxCodec';
import { mkMediaEnvelope, serializeEnvelope } from '$lib/envelope';
import { MediaKind } from '$lib/proto/codec';
import { chatReelPendingDeclaration } from './chatReelWriter';

/** One conversation the take is sent to. */
export interface ChatReelTarget {
  /** The send's message id (a fresh UUID): its outbox row, then its message on every device. */
  messageId: string;
  /** The MLS group id - the send's lane. */
  groupId: string;
  /** The conversation's key in the store, which its optimistic message is filed under. */
  conversationKey: string;
}

/** What {@link buildChatReelTake} is made of. */
export interface ChatReelTakeInput {
  takeId: string;
  /** The press (Unix ms): every send's `sentAt`, and the start of its 30 days. */
  sentAt: number;
  senderId: string;
  /** The RAW take as the camera wrote it - prepared by the outbox, never here. */
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
  /** The ThumbHash of the camera's first picture, drawn by every bubble from the first frame. */
  placeholder?: string;
  targets: ChatReelTarget[];
}

/** The take row and its sends, as `enqueueOutboxTake` writes them. */
export interface ChatReelTakeRows {
  take: OutboxEntry;
  sends: Array<{ entry: OutboxEntry; message: StoredMessage }>;
}

/**
 * Builds the take and its sends. The declaration (intent, expiry hint) is made at the press, so the
 * 30 days count from it; the LENGTH and the file's description are the outbox's to write once it
 * has prepared the take - a send reads them from its take when it goes.
 *
 * @throws {Error} with no target: a take nobody is sent to is never written.
 */
export function buildChatReelTake(input: ChatReelTakeInput): ChatReelTakeRows {
  if (input.targets.length === 0) throw new Error('a chat-reel take needs at least one target');
  const declaration = chatReelPendingDeclaration(input.sentAt);
  const description = {
    kind: MediaKind.MEDIA_KIND_VIDEO,
    mimeType: input.mimeType,
    size: input.bytes.length,
    fileName: input.fileName,
    ...(input.placeholder ? { placeholder: input.placeholder } : {}),
    ...declaration,
  };
  const base = { sentAt: input.sentAt, status: 'pending' as const, attempts: 0 };
  const take: OutboxEntry = {
    ...base,
    id: input.takeId,
    conversationId: REEL_TAKE_QUEUE,
    kind: 'reel-take',
    createdAt: input.sentAt,
    media: { ...description, prepare: 'chat-reel', fileBytes: input.bytes },
    take: {
      sends: input.targets.map((t) => ({ id: t.messageId, conversationId: t.groupId })),
    },
  };
  // The bubble's envelope until the file is there: an empty ref, the take's poster and declaration.
  const content = serializeEnvelope(
    mkMediaEnvelope(
      {
        type: 'video',
        mediaId: '',
        key: '',
        iv: '',
        mimeType: input.mimeType,
        size: input.bytes.length,
        fileName: input.fileName,
        ...(input.placeholder ? { placeholder: input.placeholder } : {}),
        ...declaration,
      },
      undefined
    )
  );
  const sends = input.targets.map((target) => ({
    entry: {
      ...base,
      id: target.messageId,
      conversationId: target.groupId,
      kind: 'media' as const,
      createdAt: input.sentAt,
      media: { ...description, takeId: input.takeId },
    },
    message: {
      id: target.messageId,
      conversationId: target.conversationKey.toLowerCase(),
      senderId: input.senderId,
      content,
      timestamp: input.sentAt,
    },
  }));
  return { take, sends };
}
