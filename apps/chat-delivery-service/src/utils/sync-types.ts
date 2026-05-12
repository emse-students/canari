import { BadRequestException } from '@nestjs/common';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
  sanitizeByteArray,
  sanitizeMessageIdList,
} from './sanitize';

export interface SyncConversationManifest {
  conversationId: string;
  groupId?: string;
  updatedAt?: number;
  messageIds: string[];
}

export interface SyncManifestPayload {
  generatedAt: number;
  conversations: SyncConversationManifest[];
}

export interface SyncSessionState {
  sessionId: string;
  userId: string;
  offerDeviceId: string;
  offerPublicKey: string;
  answerDeviceId?: string;
  answerPublicKey?: string;
  joinTokenHash: string;
  state: 'waiting_join' | 'joined';
  createdAt: number;
  expiresAt: number;
}

export interface SyncSerializedEncryptedRow {
  id: string;
  conversationId: string;
  timestamp: number;
  iv: number[];
  salt: number[];
  cipherText: number[];
}

export interface SyncSerializedChunk {
  conversation: {
    id: string;
    groupId: string;
    name: string;
    isReady: boolean;
    updatedAt: number;
  };
  rows: SyncSerializedEncryptedRow[];
}

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
        iv: sanitizeByteArray(row.iv, 'row.iv'),
        salt: sanitizeByteArray(row.salt, 'row.salt'),
        cipherText: sanitizeByteArray(row.cipherText, 'row.cipherText'),
      };
    });

    return { conversation, rows };
  });
}

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
