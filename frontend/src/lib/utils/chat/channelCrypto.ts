import {
  ChannelService,
  type ChannelMessageRow,
  type ChannelPollInput,
} from '$lib/services/ChannelService';
import { encodeAppMessage, decodeAppMessage, mkPoll } from '$lib/proto/codec';
import { appMsgToEnvelope, appMsgToChannelSystemEnvelope } from '$lib/utils/chat/messageUtils';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import {
  GraineBelowFirstIndexError,
  GraineSessionUnavailableError,
  openChannelMessage,
  sealChannelMessage,
} from '$lib/utils/graine/channelSeal';
import { rawChannelId } from '$lib/utils/graine/runtime';
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
 * Decrypts and decodes a single channel message row into a renderable message, or returns null
 * when the payload is unreadable or carries no displayable content. Shared by channel history
 * loading and full-text search so both decode rows identically.
 */
export async function decodeChannelMessageRow(
  channelId: string,
  row: ChannelMessageRow,
  userIdLower: string
): Promise<DecodedChannelMessage | null> {
  const channel = rawChannelId(channelId);
  const serverMs = parseServerTimestampMs(row.createdAt);
  let content: string | undefined;
  let timestamp: Date | undefined;
  let isSystem = false;
  try {
    const bytes = await openChannelMessage(channel, row);
    const decoded = decodeAppMessage(bytes);
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
    // The row is dropped from the rendered history with nothing else to show for it, so the reason
    // it was unreadable is all the loss leaves behind - and the three reasons need three different
    // responses. A MISSING SEED is repairable and is the only one worth asking a peer about; a
    // message below the handover floor is the protocol working, and asking would loop for ever
    // since the answer is the same seed; anything else is a real fault.
    console.warn(
      `[CHANNEL] Message ${String(row.id)} of ${channel.slice(0, 8)} is unreadable and is not rendered - ` +
        (err instanceof GraineSessionUnavailableError
          ? `no seed for session ${err.sessionId} (repairable)`
          : err instanceof GraineBelowFirstIndexError
            ? `sent before this device was given the seed (index ${err.index} < ${err.firstIndex})`
            : String(err))
    );
    return null;
  }
  if (content === undefined) return null;

  // A membership notice belongs to the conversation, not to whoever triggered it: attributing it
  // to the sender would give it an avatar, a name header and a left-aligned bubble.
  const senderId = isSystem ? 'system' : String(row.senderId || 'unknown').toLowerCase();
  return {
    id: String(row.id),
    senderId,
    content,
    timestamp: timestamp ?? (serverMs !== undefined ? new SvelteDate(serverMs) : new SvelteDate()),
    isOwn: !isSystem && senderId === userIdLower,
    isSystem,
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
  mentionedUserIds?: string[]
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
