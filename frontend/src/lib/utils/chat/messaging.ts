import type { IMlsService } from '$lib/mlsService';
import type { ChatMessage, Conversation } from '$lib/types';
import type { OutboxEntry } from '$lib/db';
import { cancelOutboxMessage, enqueueOutboxMessage } from './outbox';
import { encodeAppMessage, mkText, mkReply, mkReaction, mkSystem } from '$lib/proto/codec';
import { serializeEnvelope, mkTextEnvelope, parseEnvelope } from '$lib/envelope';
import {
  sendEncryptedChannelMessage,
  isChannelConversationId,
} from '$lib/utils/chat/channelCrypto';
import { extractMentionUserIds } from '$lib/utils/mentions';
import { notifyReaction } from '$lib/utils/chat/reactionNotify';
import { m } from '$lib/paraglide/messages';

/**
 * Dependencies required by message-sending helpers.
 * Passed as a single object to avoid long argument lists and make unit testing easier.
 */
interface SendMessageDeps {
  userId: string;
  conversation: Conversation;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options: {
      replyTo?: ChatMessage['replyTo'];
      isSystem?: boolean;
      messageId?: string;
      timestamp?: Date;
      status?: ChatMessage['status'];
      skipDbSave?: boolean;
    }
  ) => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Sends a text message in a conversation, optionally as a reply to a previous message.
 *
 * For direct/group MLS conversations the message is captured into the persistent outbox and
 * displayed optimistically with status `'pending'`; the outbox flusher encrypts and delivers it
 * as soon as the group is sendable (now, on reconnect, or after a Welcome),
 * surviving reload/kill. The user never sees a transient "send failed" error - the only hard
 * block is a conversation whose group was deleted server-side (`deletedRemotely`).
 *
 * For channel conversations (`contactName` starts with `'channel_'`) the message is server-
 * authoritative and sent directly via `sendEncryptedChannelMessage` (no outbox).
 *
 * Returns `{ success: false }` silently when the text is empty.
 */
export async function sendChatMessage(
  text: string,
  contactName: string,
  replyingTo: ChatMessage | null,
  deps: SendMessageDeps
): Promise<{ success: boolean; error?: string }> {
  const { userId, conversation, addMessageToChat } = deps;

  deps.log(
    `[SEND] sendChatMessage: contact="${contactName}" groupId="${conversation.id}" lifecycle=${conversation.lifecycle} text="${text.slice(0, 40)}" reply=${!!replyingTo}`
  );

  if (!text.trim()) {
    deps.log('[SEND] Abort: empty text');
    return { success: false };
  }

  const messageId = crypto.randomUUID();
  const sentAt = Date.now();

  // Reply preview (from the quoted message envelope), shared by the proto and the local echo.
  let replyToData: ChatMessage['replyTo'] = undefined;
  if (replyingTo) {
    const replyEnv = parseEnvelope(replyingTo.content);
    const replyPreview =
      replyEnv.kind === 'text' || replyEnv.kind === 'system'
        ? replyEnv.text.slice(0, 100)
        : replyEnv.kind === 'media'
          ? (replyEnv.caption?.slice(0, 100) ?? m.chat_preview_media())
          : `${m.chat_preview_poll()} ${replyEnv.question}`.slice(0, 100);
    replyToData = { id: replyingTo.id, senderId: replyingTo.senderId, content: replyPreview };
  }

  // Channels: server-authoritative, no outbox - encode and send directly.
  if (isChannelConversationId(contactName)) {
    const payload = replyingTo
      ? encodeAppMessage({
          ...mkReply(text, {
            id: replyingTo.id,
            senderId: replyingTo.senderId,
            preview: replyToData?.content ?? '',
          }),
          messageId,
          sentAt,
        })
      : encodeAppMessage({ ...mkText(text), messageId, sentAt });
    try {
      const rawChannelId = contactName.replace(/^channel_/, '');
      // Cleartext mention targets let the server route the `mentions` notification level.
      const mentionedUserIds = extractMentionUserIds(text);
      await sendEncryptedChannelMessage(
        rawChannelId,
        payload,
        messageId,
        undefined,
        mentionedUserIds
      );
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error: m.chat_send_error({ reason: error.message || String(error) }),
      };
    }
  }

  // Group deleted/excluded server-side: the only hard block (deletion banner is shown).
  if (conversation.lifecycle === 'removed') {
    return { success: false, error: m.chat_conversation_deleted_message() };
  }

  // Optimistic echo (status pending, persisted so it survives reload), then enqueue.
  const envelope = serializeEnvelope(mkTextEnvelope(text, replyToData));
  await addMessageToChat(userId, envelope, contactName, {
    messageId,
    status: 'pending',
    timestamp: new Date(sentAt),
    ...(replyToData ? { replyTo: replyToData } : {}),
  });

  const entry: OutboxEntry = {
    id: messageId,
    conversationId: conversation.id,
    sentAt,
    kind: replyingTo ? 'reply' : 'text',
    text,
    ...(replyToData
      ? {
          replyTo: {
            id: replyToData.id,
            senderId: replyToData.senderId,
            preview: replyToData.content,
          },
        }
      : {}),
    status: 'pending',
    attempts: 0,
    createdAt: sentAt,
  };
  await enqueueOutboxMessage(entry);
  deps.log(`[SEND] ${messageId.slice(0, 8)}… queued (pending)`);
  return { success: true };
}

/** Minimal dependencies shared by reaction, edit, delete, and read-receipt helpers. */
interface MessageActionDeps {
  mlsService: IMlsService;
  userId: string;
  deviceKeyB64: string;
  conversation: Conversation;
  /** Display name of the current user - used as actor in reaction notifications. */
  currentUserDisplayName?: string;
}

/**
 * Captures a pre-encoded control AppMessage (reaction, edit, delete, pin, read receipt) into the
 * durable outbox instead of sending it fire-and-forget. The flusher delivers it (silent, retried
 * with backoff) as soon as the group is sendable, so control
 * events converge across peers even if the group was momentarily unsendable, or the app reloaded
 * or was killed before the original direct send could go through.
 */
async function enqueueControlEvent(conversationId: string, proto: Uint8Array): Promise<void> {
  const now = Date.now();
  await enqueueOutboxMessage({
    id: crypto.randomUUID(),
    conversationId,
    sentAt: now,
    kind: 'control',
    controlProto: proto,
    status: 'pending',
    attempts: 0,
    createdAt: now,
  });
}

/**
 * Sends an emoji reaction to a message via the durable outbox (MLS broadcast), and notifies the
 * message author via a server-side push if they are a different user. The reaction is captured
 * into the outbox so it converges on peers even if the group is momentarily unsendable.
 */
export async function addReaction(
  messageId: string,
  emoji: string,
  at: number,
  deps: MessageActionDeps
): Promise<void> {
  const { userId, conversation, currentUserDisplayName } = deps;

  await enqueueControlEvent(conversation.id, encodeAppMessage(mkReaction(messageId, emoji, at)));

  // Notify the message author (fire-and-forget, non-fatal). The message's CONTENT is deliberately
  // not read here - see notifyReaction: the author's own devices hold it already.
  const targetMsg = conversation.messages.find((m) => m.id === messageId);
  if (targetMsg?.senderId && targetMsg.senderId !== userId) {
    void notifyReaction({
      groupId: conversation.id,
      targetSenderId: targetMsg.senderId,
      emoji,
      messageId,
      actorName: currentUserDisplayName ?? userId,
    }).catch(() => {});
  }
}

/**
 * Takes an emoji reaction back, as the SAME frame that placed it with `removed` set.
 *
 * It used to be a `remove_reaction` system event carrying JSON, which left the two legs of one
 * operation with two shapes and nowhere to put the timestamp the merge needs on both. Peers still
 * accept the old event when replaying a stream written before this change - see
 * `docs/wiki/legacy-compatibility.md`.
 */
export async function removeReaction(
  messageId: string,
  emoji: string,
  at: number,
  deps: MessageActionDeps
): Promise<void> {
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkReaction(messageId, emoji, at, true))
  );
}
/**
 * Captures an "edit_message" system event in the durable outbox so all peers update the message
 * content in their local history.
 *
 * `editedAt` IS THE CALLER'S, for the same reason `setMessagePinned` takes its `at`: the local apply
 * and the broadcast are one act and must carry one instant. This read the clock itself, so the
 * sending device stored a timestamp a few milliseconds off the one it told everyone else - and once
 * that timestamp decides which of two concurrent edits wins, a device disagreeing with its own
 * broadcast is a device that can lose to itself.
 */
export async function editMessage(
  messageId: string,
  newContent: string,
  editedAt: number,
  deps: MessageActionDeps
): Promise<void> {
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkSystem('edit_message', JSON.stringify({ messageId, newContent, editedAt })))
  );
}

/**
 * What a delete actually did, which decides what the caller writes locally.
 *
 * `withdrawn` - the frame never left this device, so no peer has it and none ever will.
 * `broadcast` - the frame is out there and a `delete_message` event is on its way after it.
 */
export type DeleteOutcome = 'withdrawn' | 'broadcast';

/**
 * Deletes a message: by WITHDRAWING it if it has not left this device, otherwise by broadcasting a
 * `delete_message` system event so peers that already have it remove it from their history.
 *
 * WHY THE WITHDRAWAL COMES FIRST. Both legs used to be ordinary outbox entries side by side, so
 * deleting a message composed offline SENT it and then took it back: the peer received the text,
 * rendered it, and only then received the tombstone. **The user deleted something that had never
 * been sent, and it was sent anyway.** Ordering the two entries could not fix that - the text still
 * goes out - so the queued entry is dropped instead, and the event is enqueued only when there is
 * nothing left to drop, which is precisely the case the event exists for.
 *
 * The two outcomes are one question answered where it is KNOWN rather than learnt by failing: only
 * the outbox can say whether the frame is still on this device, and it answers before either path
 * is taken.
 *
 * WHICH OUTCOME IT WAS IS RETURNED, because the caller's local write differs between them and it
 * cannot recompute the answer afterwards. It used to be dropped here, so the caller tombstoned in
 * both cases - and a withdrawn message left a "deleted message" row on the sender for something no
 * peer had ever received, which every reconciliation then read as a row the peers had LOST.
 */
export async function deleteMessage(
  messageId: string,
  deps: MessageActionDeps
): Promise<DeleteOutcome> {
  if (await cancelOutboxMessage(messageId)) return 'withdrawn';
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkSystem('delete_message', JSON.stringify({ messageId })))
  );
  return 'broadcast';
}

/**
 * Captures a "pin"/"unpin" system event in the durable outbox so all members converge.
 *
 * `at` is the sender's clock for this message's pin state, and both legs carry it for the same
 * reason a reaction's two legs do: the merge on the far side keeps the larger one, so an undated
 * leg could never be ordered against a dated one. It is the CALLER's `at`, not one taken here - the
 * optimistic local apply and the broadcast must state the same instant, or the sender's own device
 * disagrees with every peer about when it acted.
 */
export async function setMessagePinned(
  messageId: string,
  pinned: boolean,
  at: number,
  deps: MessageActionDeps
): Promise<void> {
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkSystem(pinned ? 'pin' : 'unpin', JSON.stringify({ messageId, at })))
  );
}

/**
 * Captures a "read_watermark" system event in the durable outbox: *I have read this conversation
 * up to `at`*, one monotone instant rather than a list of message ids.
 *
 * `at` is drawn from the messages themselves (see `watermarkAfterReading`), never from the clock,
 * so it compares correctly against the population it will be compared against on every other
 * device.
 *
 * @returns false only when there is nothing to announce (`at` not ahead of what peers were last
 *          told), which is what keeps an open conversation from emitting a frame per render.
 */
export async function sendReadWatermark(at: number, deps: MessageActionDeps): Promise<boolean> {
  if (!Number.isFinite(at) || at <= 0) return false;
  await enqueueControlEvent(
    deps.conversation.id,
    encodeAppMessage(mkSystem('read_watermark', JSON.stringify({ at })))
  );
  return true;
}
