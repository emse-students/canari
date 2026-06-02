import { BadRequestException } from '@nestjs/common';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
  sanitizeBase64BinaryField,
  sanitizeMessageIdList,
} from './sanitize';

/** A snapshot of one conversation's known message IDs at manifest-generation time, used for diff computation. */
export interface SyncConversationManifest {
  /** Stable local conversation identifier on the requesting device. */
  conversationId: string;
  /** MLS group ID associated with this conversation, if the conversation is MLS-backed. */
  groupId?: string;
  /** Unix timestamp (ms) of the last local update, used to prioritise which conversations to sync first. */
  updatedAt?: number;
  /** Full list of message IDs the requesting device already holds for this conversation. */
  messageIds: string[];
}

/** Top-level payload exchanged during the manifest phase of a device-to-device sync session. */
export interface SyncManifestPayload {
  /** Unix timestamp (ms) when the manifest was generated on the originating device. */
  generatedAt: number;
  /** One entry per conversation the device is aware of. */
  conversations: SyncConversationManifest[];
}

/**
 * Server-side session record for an active device-to-device sync handshake.
 * The offering device creates the session and stores its ECDH public key; the
 * answering device completes the handshake by supplying its own public key so
 * both sides can derive a shared encryption key for the transfer.
 */
export interface SyncSessionState {
  /** Unique session identifier, also used as the join code. */
  sessionId: string;
  /** User ID that both devices must belong to (enforced server-side). */
  userId: string;
  /** Device ID of the device that initiated the sync offer. */
  offerDeviceId: string;
  /** ECDH public key (Base64) of the offering device. */
  offerPublicKey: string;
  /** Device ID of the device that accepted the sync offer. */
  answerDeviceId?: string;
  /** ECDH public key (Base64) of the answering device. */
  answerPublicKey?: string;
  /** SHA-256 hash of the one-time join token, stored instead of the raw token. */
  joinTokenHash: string;
  /** Current handshake state: `waiting_join` until the second device connects, then `joined`. */
  state: 'waiting_join' | 'joined';
  /** Unix timestamp (ms) when the session was created. */
  createdAt: number;
  /** Unix timestamp (ms) after which the session is considered expired and must be discarded. */
  expiresAt: number;
}

/** A single AES-256-GCM encrypted message row transferred during a sync session. */
export interface SyncSerializedEncryptedRow {
  /** Message ID. */
  id: string;
  /** Conversation the message belongs to. */
  conversationId: string;
  /** Original message timestamp (ms) preserved for ordering after decryption. */
  timestamp: number;
  /** AES-GCM initialisation vector as a base64 string. */
  iv: string;
  /** PBKDF2 salt used to derive the AES key from the shared ECDH secret, as a base64 string. */
  salt: string;
  /** AES-256-GCM ciphertext of the serialised message, as a base64 string. */
  cipherText: string;
}

/** A batch of encrypted messages belonging to one conversation, transferred as a single unit. */
export interface SyncSerializedChunk {
  /** Metadata about the conversation this chunk belongs to. */
  conversation: {
    /** Stable local conversation identifier. */
    id: string;
    /** MLS group ID for this conversation. */
    groupId: string;
    /** Display name of the conversation. */
    name: string;
    /** Whether the MLS group is fully established (Welcome received and processed). */
    isReady: boolean;
    /** Unix timestamp (ms) of the last update in this conversation. */
    updatedAt: number;
  };
  /** Encrypted message rows included in this chunk. */
  rows: SyncSerializedEncryptedRow[];
}

/**
 * Parses and validates a raw sync manifest payload from an untrusted client body.
 * All string fields are passed through the safe-query sanitiser; numeric fields
 * are floor-clamped to integers. Throws `BadRequestException` on any violation.
 */
export function sanitizeSyncManifest(payload: unknown): SyncManifestPayload {
  if (!payload || typeof payload !== 'object') {
    throw new BadRequestException('manifest is required');
  }

  const record = payload as Record<string, unknown>;
  const generatedAt =
    typeof record.generatedAt === 'number' &&
    Number.isFinite(record.generatedAt)
      ? Math.floor(record.generatedAt)
      : Date.now();

  if (!Array.isArray(record.conversations)) {
    throw new BadRequestException('manifest.conversations must be an array');
  }
  if (record.conversations.length > 2_000) {
    throw new BadRequestException(
      'manifest.conversations must not exceed 2 000 entries',
    );
  }

  const conversations: SyncConversationManifest[] = record.conversations.map(
    (raw) => {
      if (!raw || typeof raw !== 'object') {
        throw new BadRequestException('manifest conversation entry is invalid');
      }

      const entry = raw as Record<string, unknown>;
      const conversationId = sanitizeQueryValue(
        entry.conversationId,
        'conversationId',
      );
      const groupId = sanitizeOptionalQueryValue(entry.groupId, 'groupId');
      const updatedAt =
        typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
          ? Math.floor(entry.updatedAt)
          : undefined;
      const messageIds = sanitizeMessageIdList(entry.messageIds);

      return {
        conversationId,
        groupId,
        updatedAt,
        messageIds,
      };
    },
  );

  return { generatedAt, conversations };
}

/**
 * Validates and parses an array of serialised sync chunks from an untrusted body.
 * Enforces a maximum of 2 000 chunks per upload to prevent oversized payloads.
 * Throws `BadRequestException` if any chunk or row fails validation.
 */
export function sanitizeSerializedChunks(
  value: unknown,
): SyncSerializedChunk[] {
  if (!Array.isArray(value)) {
    throw new BadRequestException('chunks must be an array');
  }

  if (value.length > 2000) {
    throw new BadRequestException('chunks payload too large');
  }

  return value.map((rawChunk) => {
    if (!rawChunk || typeof rawChunk !== 'object') {
      throw new BadRequestException('chunk entry is invalid');
    }

    const chunk = rawChunk as Record<string, unknown>;
    const rawConversation = chunk.conversation as Record<string, unknown>;
    if (!rawConversation || typeof rawConversation !== 'object') {
      throw new BadRequestException('chunk.conversation is required');
    }

    const conversation = {
      id: sanitizeQueryValue(rawConversation.id, 'conversation.id'),
      groupId: sanitizeQueryValue(
        rawConversation.groupId,
        'conversation.groupId',
      ),
      name: (() => {
        if (typeof rawConversation.name !== 'string') {
          throw new BadRequestException('conversation.name must be a string');
        }
        const text = rawConversation.name.trim();
        if (!text)
          throw new BadRequestException('conversation.name is required');
        if (text.length > 256)
          throw new BadRequestException('conversation.name is too long');
        return text;
      })(),
      isReady: Boolean(rawConversation.isReady),
      updatedAt:
        typeof rawConversation.updatedAt === 'number' &&
        Number.isFinite(rawConversation.updatedAt)
          ? Math.floor(rawConversation.updatedAt)
          : Date.now(),
    };

    if (!Array.isArray(chunk.rows)) {
      throw new BadRequestException('chunk.rows must be an array');
    }

    const rows: SyncSerializedEncryptedRow[] = chunk.rows.map((rawRow) => {
      if (!rawRow || typeof rawRow !== 'object') {
        throw new BadRequestException('chunk row is invalid');
      }

      const row = rawRow as Record<string, unknown>;
      return {
        id: sanitizeQueryValue(row.id, 'row.id'),
        conversationId: sanitizeQueryValue(
          row.conversationId,
          'row.conversationId',
        ),
        timestamp:
          typeof row.timestamp === 'number' && Number.isFinite(row.timestamp)
            ? Math.floor(row.timestamp)
            : Date.now(),
        iv: sanitizeBase64BinaryField(row.iv, 'row.iv'),
        salt: sanitizeBase64BinaryField(row.salt, 'row.salt'),
        cipherText: sanitizeBase64BinaryField(row.cipherText, 'row.cipherText'),
      };
    });

    return { conversation, rows };
  });
}

/**
 * Computes the symmetric difference between two sync manifests.
 * Returns two lists: messages the requester is missing (peer has them) and
 * messages the peer is missing (requester has them). Used by the server to
 * tell each side exactly which messages to upload to the session storage.
 */
export function computeManifestDiff(
  requester: SyncManifestPayload,
  peer: SyncManifestPayload,
) {
  const requesterByConversation = new Map(
    requester.conversations.map((c) => [c.conversationId, c]),
  );
  const peerByConversation = new Map(
    peer.conversations.map((c) => [c.conversationId, c]),
  );

  const allConversationIds = new Set<string>([
    ...requesterByConversation.keys(),
    ...peerByConversation.keys(),
  ]);

  const missingOnRequester: SyncConversationManifest[] = [];
  const missingOnPeer: SyncConversationManifest[] = [];

  for (const conversationId of allConversationIds) {
    const requesterConv = requesterByConversation.get(conversationId);
    const peerConv = peerByConversation.get(conversationId);

    const requesterIds = new Set(requesterConv?.messageIds ?? []);
    const peerIds = new Set(peerConv?.messageIds ?? []);

    const requesterMissing = [...peerIds].filter((id) => !requesterIds.has(id));
    if (requesterMissing.length > 0) {
      missingOnRequester.push({
        conversationId,
        groupId: requesterConv?.groupId ?? peerConv?.groupId,
        updatedAt: requesterConv?.updatedAt ?? peerConv?.updatedAt,
        messageIds: requesterMissing,
      });
    }

    const peerMissing = [...requesterIds].filter((id) => !peerIds.has(id));
    if (peerMissing.length > 0) {
      missingOnPeer.push({
        conversationId,
        groupId: requesterConv?.groupId ?? peerConv?.groupId,
        updatedAt: requesterConv?.updatedAt ?? peerConv?.updatedAt,
        messageIds: peerMissing,
      });
    }
  }

  return { missingOnRequester, missingOnPeer };
}
