import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';
import {
  ChannelService,
  type ChannelBootstrapDto,
  type ChannelMessageRow,
  type ChannelPollInput,
} from '$lib/services/ChannelService';
import { encodeAppMessage, decodeAppMessage, mkPoll } from '$lib/proto/codec';
import { appMsgToEnvelope } from '$lib/utils/chat/messageUtils';
import { parseServerTimestampMs } from '$lib/mls-client/incomingDelivery';
import { importChannelEpochKey } from '$lib/utils/chat/channelKeyMirror';
import { SvelteDate } from 'svelte/reactivity';

const channelService = new ChannelService();

/** A channel message row decrypted and decoded into the fields the chat UI renders. */
export interface DecodedChannelMessage {
  id: string;
  senderId: string;
  content: string;
  timestamp: Date;
  isOwn: boolean;
}

/**
 * Decrypts and decodes a single channel message row into a renderable message, or returns null
 * when the payload is unreadable (missing epoch key) or carries no displayable content. Shared by
 * channel history loading and full-text search so both decode rows identically. Assumes the
 * relevant epoch keys are already hydrated in the {@link channelKeyManager}.
 */
export async function decodeChannelMessageRow(
  channelId: string,
  row: ChannelMessageRow,
  userIdLower: string
): Promise<DecodedChannelMessage | null> {
  const rawChannelId = normalizeChannelId(channelId);
  const serverMs = parseServerTimestampMs(row.createdAt);
  let content: string | undefined;
  let timestamp: Date | undefined;
  try {
    let bytes: Uint8Array | undefined;
    if (row.ciphertext && row.nonce && row.keyVersion != null) {
      bytes = await channelKeyManager.decryptMessage(
        rawChannelId,
        row.ciphertext,
        row.nonce,
        row.keyVersion
      );
    } else if (row.ciphertext) {
      const binStr = atob(row.ciphertext);
      bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    }
    if (bytes) {
      const decoded = decodeAppMessage(bytes);
      if (decoded) {
        const envelope = appMsgToEnvelope(decoded, serverMs);
        if (envelope) {
          content = envelope.content;
          timestamp = envelope.options.timestamp;
        }
      }
    }
  } catch {
    return null;
  }
  if (content === undefined) return null;

  const senderId = String(row.senderId || 'unknown').toLowerCase();
  return {
    id: String(row.id),
    senderId,
    content,
    timestamp: timestamp ?? (serverMs !== undefined ? new SvelteDate(serverMs) : new SvelteDate()),
    isOwn: senderId === userIdLower,
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

/** Strip the `channel_` prefix from a channel ID so the raw UUID is passed to the backend. */
function normalizeChannelId(channelId: string): string {
  return String(channelId).replace(/^channel_/, '');
}

/** True for community channel conversations (`channel_<uuid>`). */
export function isChannelConversationId(conversationId: string): boolean {
  return String(conversationId).startsWith('channel_');
}

/**
 * Hydrates every known epoch key for a channel into the in-memory {@link channelKeyManager} so
 * historical messages (encrypted under older epochs) decrypt. Best-effort per key. Shared by
 * channel history loading and full-text search.
 */
export async function hydrateChannelHistoryKeys(channelId: string): Promise<void> {
  const rawChannelId = normalizeChannelId(channelId);
  const historyKeys = await channelService.getChannelHistoryKeys(rawChannelId);
  for (const keyEntry of historyKeys.epochKeys || []) {
    if (!Number.isFinite(keyEntry.keyVersion) || keyEntry.keyVersion <= 0) continue;
    if (!keyEntry.encryptedChannelKey) continue;
    const rawKeyMat = Uint8Array.from(atob(keyEntry.encryptedChannelKey), (c) => c.charCodeAt(0));
    await importChannelEpochKey(rawChannelId, keyEntry.keyVersion, rawKeyMat);
  }
}

/** Return true when an encryption error indicates the local channel key is stale and must be refreshed from the server before retrying. */
function shouldRefreshChannelKey(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('No key for epoch') ||
    message.includes('Missing key for epoch') ||
    message.includes('Sync required') ||
    message.includes('Stale or invalid keyVersion') ||
    message.includes('keyVersion is required for channel messages')
  );
}

/**
 * Load (or re-load) the channel's current epoch key into the in-memory ChannelKeyVault.
 *
 * If `bootstrap` is provided (e.g. already fetched by the caller), it is used directly;
 * otherwise the latest bootstrap is fetched from the server via ChannelService.
 * The raw key material is decoded from base64 and stored under its keyVersion in the vault
 * so that subsequent encryptMessage / decryptMessage calls can find it.
 */
export async function hydrateChannelBootstrap(
  channelId: string,
  bootstrap?: ChannelBootstrapDto | null
): Promise<ChannelBootstrapDto> {
  const rawChannelId = normalizeChannelId(channelId);
  const resolvedBootstrap =
    bootstrap ?? (await channelService.getChannelKeyBootstrap(rawChannelId));

  if (resolvedBootstrap.channelId !== rawChannelId) {
    throw new Error(
      `Channel bootstrap mismatch: expected ${rawChannelId}, got ${resolvedBootstrap.channelId}`
    );
  }

  const rawKeyMat = Uint8Array.from(atob(resolvedBootstrap.newEpochBaseKey), (char) =>
    char.charCodeAt(0)
  );
  await importChannelEpochKey(rawChannelId, resolvedBootstrap.keyVersion, rawKeyMat);

  return resolvedBootstrap;
}

/**
 * Encrypt `payloadBytes` with the channel's current epoch key and POST the ciphertext to the backend.
 *
 * On first attempt, uses the cached key from the vault.  If that fails with a "stale key" error
 * (e.g. the epoch rotated while this tab was open), the bootstrap is refreshed automatically and
 * the send is retried exactly once.
 */
export async function sendEncryptedChannelMessage(
  channelId: string,
  payloadBytes: Uint8Array,
  messageId?: string,
  poll?: ChannelPollInput,
  mentionedUserIds?: string[]
): Promise<void> {
  const rawChannelId = normalizeChannelId(channelId);

  const attempt = async () => {
    const encrypted = await channelKeyManager.encryptMessage(rawChannelId, payloadBytes);
    await channelService.sendMessage(rawChannelId, {
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      keyVersion: encrypted.keyVersion,
      ...(messageId ? { messageId } : {}),
      ...(poll ? { poll } : {}),
      ...(mentionedUserIds && mentionedUserIds.length ? { mentionedUserIds } : {}),
    });
  };

  try {
    await attempt();
  } catch (error) {
    if (!shouldRefreshChannelKey(error)) {
      throw error;
    }

    await hydrateChannelBootstrap(rawChannelId);
    await attempt();
  }
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
