import {
  ChannelService,
  type ChannelMessageRow,
  type ChannelPollInput,
} from '$lib/services/ChannelService';
import { encodeAppMessage, decodeAppMessage, mkPoll, mkReaction } from '$lib/proto/codec';
import { appMsgToEnvelope, appMsgToChannelSystemEnvelope } from '$lib/utils/chat/messageUtils';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import {
  GraineBelowFirstIndexError,
  GraineSessionUnavailableError,
  openChannelMessage,
  sealChannelMessage,
} from '$lib/utils/graine/channelSeal';
import { rawChannelId } from '$lib/utils/graine/runtime';
import { noteMissingSeed } from '$lib/utils/graine/repair';
import { SvelteDate } from 'svelte/reactivity';

const channelService = new ChannelService();

/** A channel message row decrypted and decoded into the fields the chat UI renders. */
export interface DecodedChannelMessage {
  id: string;
  senderId: string;
  content: string;
  timestamp: Date;
  isOwn: boolean;
  /** True for a membership notice: rendered centred and neutral, attributed to nobody. */
  isSystem: boolean;
}

/**
 * What a channel row turned out to be.
 *
 * A row is not always a bubble: since WP-40 a reaction travels as an encrypted channel message, so
 * the same page carries frames that change an existing message rather than adding one. The caller
 * is TOLD which it got rather than left to infer it from a null, because "nothing to render" and
 * "something that belongs elsewhere" need different handling and only one of them is a loss.
 */
export type DecodedChannelRow =
  | { kind: 'message'; message: DecodedChannelMessage }
  | { kind: 'reaction'; reaction: DecodedChannelReaction };

/** A reaction frame read off a channel row: who, on what, which emoji, and when. */
export interface DecodedChannelReaction {
  /** The message reacted to - a SERVER row id, the same key the reaction store uses. */
  targetMessageId: string;
  senderId: string;
  emoji: string;
  /** The sender's clock for this `(user, emoji)` pair. The larger one wins the merge. */
  at: number;
  removed: boolean;
}

/**
 * Says why a channel message could not be read, and asks for its seed when asking can help.
 *
 * SHARED BY THE HISTORY PATH AND THE LIVE PATH, because they had drifted and only one of them was
 * right. The live route (`channelEventHandler`) caught every failure into a single
 * `console.error('Failed to parse channel message')` and asked for NOTHING - so a message arriving
 * before its seed, which is the ordinary race between a salon message and the key that opens it,
 * was dropped anonymously and recovered only if a history reload happened to run the other path
 * later. Measured on A1, 2026-08-19: six seconds, one ERROR line, and a repair triggered by the
 * wrong code path.
 *
 * The row is dropped from the render with nothing else to show for it, so the reason is all the
 * loss leaves behind - and the three reasons need three different responses. A MISSING SEED is
 * repairable and is the only one worth asking a peer about; a message below the handover floor is
 * the protocol working, and asking would loop for ever since the answer is the same seed; anything
 * else is a real fault. Decided from the CLASS, never from the sentence.
 */
export function reportUnreadableChannelMessage(
  channelId: string,
  rowId: string,
  senderId: string,
  err: unknown
): void {
  const channel = rawChannelId(channelId);
  console.warn(
    `[CHANNEL] Message ${rowId} of ${channel.slice(0, 8)} is unreadable and is not rendered - ` +
      (err instanceof GraineSessionUnavailableError
        ? `no seed for session ${err.sessionId} (repairable)`
        : err instanceof GraineBelowFirstIndexError
          ? `sent before this device was given the seed (index ${err.index} < ${err.firstIndex})`
          : String(err))
  );
  // A missing seed is the ONE unreadability a peer can fix, so it is the one that asks. The
  // request is deduplicated per session, so a page of fifty rows naming three sessions asks
  // three times and not fifty - and a live frame asking costs nothing when history already did.
  if (err instanceof GraineSessionUnavailableError) {
    noteMissingSeed(channel, err.sessionId, senderId);
  }
}

/**
 * Decrypts and decodes a single channel message row, or returns null when the payload is unreadable
 * or carries no displayable content. Shared by channel history loading and full-text search so both
 * decode rows identically.
 */
export async function decodeChannelMessageRow(
  channelId: string,
  row: ChannelMessageRow,
  userIdLower: string
): Promise<DecodedChannelRow | null> {
  const channel = rawChannelId(channelId);
  const serverMs = parseServerTimestampMs(row.createdAt);
  let content: string | undefined;
  let timestamp: Date | undefined;
  let isSystem = false;
  try {
    const bytes = await openChannelMessage(channel, row);
    const decoded = decodeAppMessage(bytes);
    if (decoded?.reaction) {
      // Not a bubble: it changes one. Returned rather than applied here, so this stays a pure
      // decode and the store it feeds has exactly one writer per call site.
      return {
        kind: 'reaction',
        reaction: {
          targetMessageId: String(decoded.reaction.messageId ?? ''),
          senderId: String(row.senderId || '').toLowerCase(),
          emoji: String(decoded.reaction.emoji ?? ''),
          // An undated frame reads as 0 and loses to anything dated - it cannot be trusted to win.
          at: Number(decoded.reaction.at ?? 0),
          removed: decoded.reaction.removed === true,
        },
      };
    }
    if (decoded) {
      const envelope =
        appMsgToEnvelope(decoded, serverMs) ?? appMsgToChannelSystemEnvelope(decoded, serverMs);
      if (envelope) {
        content = envelope.content;
        timestamp = envelope.options.timestamp;
        isSystem = !!decoded.system;
      }
    }
  } catch (err) {
    reportUnreadableChannelMessage(channel, String(row.id), String(row.senderId || ''), err);
    return null;
  }
  if (content === undefined) return null;

  // A membership notice belongs to the conversation, not to whoever triggered it: attributing it
  // to the sender would give it an avatar, a name header and a left-aligned bubble.
  const senderId = isSystem ? 'system' : String(row.senderId || 'unknown').toLowerCase();
  return {
    kind: 'message',
    message: {
      id: String(row.id),
      senderId,
      content,
      timestamp:
        timestamp ?? (serverMs !== undefined ? new SvelteDate(serverMs) : new SvelteDate()),
      isOwn: !isSystem && senderId === userIdLower,
      isSystem,
    },
  };
}

/** Author-supplied poll definition (labels stay client-side, encrypted in the message). */
export interface ChannelPollDraft {
  question: string;
  options: { id: string; label: string }[];
  multipleChoice: boolean;
  /** ISO date or null for no deadline. */
  endsAt: string | null;
}

/** True for community channel conversations (`channel_<uuid>`). */
export function isChannelConversationId(conversationId: string): boolean {
  return String(conversationId).startsWith('channel_');
}

/**
 * Seals `payloadBytes` under this device's Graine session for the channel and POSTs it.
 *
 * **There is no retry, and there is nothing left to retry.** The single retry this function used to
 * carry existed because the SERVER derived the channel key and could rotate its epoch out from
 * under a connected tab. Nothing rotates under a sender any more: a session is this device's own,
 * and the only thing that invalidates it - the community's roster moving - is checked before the
 * seal, not discovered by a refusal afterwards. *Never learn by failing what a fact could have
 * told you.*
 */
export async function sendEncryptedChannelMessage(
  channelId: string,
  payloadBytes: Uint8Array,
  messageId?: string,
  poll?: ChannelPollInput,
  mentionedUserIds?: string[],
  options?: { silent?: boolean }
): Promise<void> {
  const channel = rawChannelId(channelId);
  const sealed = await sealChannelMessage(channel, payloadBytes);
  await channelService.sendMessage(channel, {
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    senderSessionId: sealed.senderSessionId,
    messageIndex: sealed.messageIndex,
    ...(messageId ? { messageId } : {}),
    ...(poll ? { poll } : {}),
    ...(mentionedUserIds && mentionedUserIds.length ? { mentionedUserIds } : {}),
    ...(options?.silent ? { silent: true } : {}),
  });
}

/**
 * Places or takes back an emoji reaction, as an encrypted channel message (WP-40).
 *
 * A reaction is a message like any other here: sealed under the sender's Graine session, stored by
 * the server as an opaque blob. It is sent SILENT - a heart must not become a push, and a channel
 * where every reaction rang would be a channel people mute.
 *
 * `at` is the sender's clock for this `(user, emoji)` pair, and both legs carry it: the merge on
 * every device keeps the larger one, which is what makes a removal reach a device still holding the
 * placement.
 */
export async function sendChannelReaction(
  channelId: string,
  targetMessageId: string,
  emoji: string,
  at: number,
  removed: boolean
): Promise<void> {
  const protoBytes = encodeAppMessage({
    ...mkReaction(targetMessageId, emoji, at, removed),
    // Its OWN id, never the reacted-to message's: this is a row in the channel like any other, and
    // giving it the target's id would make two rows answer to one address.
    messageId: crypto.randomUUID(),
    sentAt: at,
  });
  await sendEncryptedChannelMessage(channelId, protoBytes, undefined, undefined, undefined, {
    silent: true,
  });
}

/**
 * Encrypts a poll definition into a PollMsg and sends it to a channel, attaching
 * the label-free descriptor (option ids + deadline) the server needs to tally.
 * The server auto-pins poll messages so they stay reachable in the pin list.
 */
export async function sendChannelPoll(
  channelId: string,
  draft: ChannelPollDraft,
  messageId: string = crypto.randomUUID()
): Promise<void> {
  const endsAtMs = draft.endsAt ? new Date(draft.endsAt).getTime() : 0;
  const protoBytes = encodeAppMessage({
    ...mkPoll({
      question: draft.question,
      options: draft.options,
      multipleChoice: draft.multipleChoice,
      endsAt: Number.isFinite(endsAtMs) ? endsAtMs : 0,
    }),
    messageId,
    sentAt: Date.now(),
  });

  await sendEncryptedChannelMessage(channelId, protoBytes, messageId, {
    optionIds: draft.options.map((o) => o.id),
    multipleChoice: draft.multipleChoice,
    endsAt: draft.endsAt,
  });
}
