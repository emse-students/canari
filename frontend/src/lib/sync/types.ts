import type { ConversationMeta, EncryptedMessageRow } from '$lib/db';

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

export interface SyncStartSessionRequest {
  userId: string;
  deviceId: string;
  offerPublicKey: string;
  ttlSeconds?: number;
}

export interface SyncStartSessionResponse {
  sessionId: string;
  joinToken: string;
  expiresAt: number;
  qrPayload: {
    sessionId: string;
    joinToken: string;
    userId: string;
  };
}

export interface SyncJoinSessionRequest {
  sessionId: string;
  joinToken: string;
  userId: string;
  deviceId: string;
  answerPublicKey: string;
}

export interface SyncSessionStateResponse {
  sessionId: string;
  state: 'waiting_join' | 'joined';
  offerDeviceId: string;
  answerDeviceId?: string;
  offerPublicKey: string;
  answerPublicKey?: string;
  expiresAt: number;
}

export interface SyncDiffResponse {
  sessionId: string;
  requesterDeviceId: string;
  peerDeviceId: string;
  generatedAt: number;
  missingOnRequester: SyncConversationManifest[];
  missingOnPeer: SyncConversationManifest[];
  stats: {
    requesterConversationCount: number;
    peerConversationCount: number;
    requesterMissingMessageCount: number;
    peerMissingMessageCount: number;
  };
}

export interface SyncTransferChunk {
  conversation: ConversationMeta;
  rows: EncryptedMessageRow[];
}
