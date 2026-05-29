import type { ConversationMeta, EncryptedMessageRow } from '$lib/db';

/**
 * The list of message IDs known for a single conversation on one device,
 * used to detect what is missing on the other side during a sync diff.
 */
export interface SyncConversationManifest {
  /** URL-safe base64-encoded conversation ID used for transport. */
  conversationId: string;
  /** The raw MLS group ID for this conversation. */
  groupId?: string;
  /** Last-modified timestamp (ms since epoch) for ordering purposes. */
  updatedAt?: number;
  /** Ordered list of message IDs present on this device. */
  messageIds: string[];
}

/**
 * Full manifest of all conversations on a device, uploaded to the sync server
 * so both sides can compute which messages need to be transferred.
 */
export interface SyncManifestPayload {
  /** Unix timestamp (ms) when this snapshot was taken. */
  generatedAt: number;
  /** One entry per local conversation. */
  conversations: SyncConversationManifest[];
}

/**
 * Request body sent by the initiating device when it creates a new sync session.
 * The session is identified via QR code; the offer public key is used for the
 * ECDH key exchange that secures the channel.
 */
export interface SyncStartSessionRequest {
  /** The Canari user ID of the initiating device. */
  userId: string;
  /** Device ID of the initiating device. */
  deviceId: string;
  /** Ephemeral public key (base64url) offered for the ECDH handshake. */
  offerPublicKey: string;
  /** How long the session should remain valid before expiring, in seconds. */
  ttlSeconds?: number;
}

/**
 * Response returned after a sync session is successfully created.
 * The `qrPayload` field is encoded into the QR code shown to the joining device.
 */
export interface SyncStartSessionResponse {
  /** Unique opaque identifier for this sync session. */
  sessionId: string;
  /** Short-lived token the joining device must present to prove it scanned the QR. */
  joinToken: string;
  /** Unix timestamp (seconds) after which the session is no longer valid. */
  expiresAt: number;
  /** The data to encode in the QR code. */
  qrPayload: {
    sessionId: string;
    joinToken: string;
    userId: string;
  };
}

/**
 * Request body sent by the joining device after scanning the QR code.
 */
export interface SyncJoinSessionRequest {
  /** Session ID extracted from the QR code. */
  sessionId: string;
  /** Token extracted from the QR code, proves QR ownership. */
  joinToken: string;
  /** Canari user ID of the joining device (must match the session owner). */
  userId: string;
  /** Device ID of the joining device. */
  deviceId: string;
  /** Ephemeral public key (base64url) from the joining device for ECDH. */
  answerPublicKey: string;
}

/**
 * Current state of a sync session, returned by the poll endpoint.
 * The initiating device polls this until `state` becomes `'joined'`.
 */
export interface SyncSessionStateResponse {
  sessionId: string;
  /** `waiting_join` until the second device scans the QR; `joined` once both are connected. */
  state: 'waiting_join' | 'joined';
  /** Device ID of the session creator. */
  offerDeviceId: string;
  /** Device ID of the device that joined by scanning the QR, if already joined. */
  answerDeviceId?: string;
  /** Ephemeral public key offered by the creating device. */
  offerPublicKey: string;
  /** Ephemeral public key provided by the joining device, available after join. */
  answerPublicKey?: string;
  /** Unix timestamp (seconds) when the session expires. */
  expiresAt: number;
}

/**
 * Server-computed diff between two devices' manifests.
 * Tells each device exactly which messages the other side is missing.
 */
export interface SyncDiffResponse {
  sessionId: string;
  /** Device ID that requested the diff. */
  requesterDeviceId: string;
  /** Device ID of the peer device. */
  peerDeviceId: string;
  /** Unix timestamp (ms) when the diff was computed. */
  generatedAt: number;
  /** Conversations/messages that the requester is missing (must pull from peer). */
  missingOnRequester: SyncConversationManifest[];
  /** Conversations/messages that the peer is missing (requester must upload). */
  missingOnPeer: SyncConversationManifest[];
  /** Aggregate counts for progress display. */
  stats: {
    requesterConversationCount: number;
    peerConversationCount: number;
    requesterMissingMessageCount: number;
    peerMissingMessageCount: number;
  };
}

/**
 * An in-memory unit of data ready to be transferred: one conversation with its
 * raw encrypted message rows, using the native binary types from the local DB.
 */
export interface SyncTransferChunk {
  /** Metadata for the conversation being transferred. */
  conversation: ConversationMeta;
  /** Encrypted message rows belonging to this conversation. */
  rows: EncryptedMessageRow[];
}

/**
 * Data encoded into the QR code displayed by the initiating device.
 * The joining device scans this to authenticate and join the session.
 */
export interface SyncQrPayload {
  /** Unique sync session identifier. */
  sessionId: string;
  /** Single-use token that authorises the device to join the session. */
  joinToken: string;
  /** Canari user ID of the session owner (prevents cross-account joins). */
  userId: string;
}

/**
 * Wire-format for a single encrypted message row: binary fields are serialised
 * as standard base64 strings for compact JSON transport (~3x smaller than number arrays).
 */
export interface SyncSerializedEncryptedRow {
  /** Unique message ID. */
  id: string;
  /** Encoded conversation ID (cid_… prefix). */
  conversationId: string;
  /** Unix timestamp (ms) of the message. */
  timestamp: number;
  /** AES-GCM initialisation vector as a base64 string. */
  iv: string;
  /** PBKDF2 salt used to derive the encryption key as a base64 string. */
  salt: string;
  /** AES-GCM ciphertext as a base64 string. */
  cipherText: string;
}

/**
 * Wire-format for one conversation and all its messages, ready for JSON transport.
 * All binary fields are number arrays; conversation IDs use the encoded transport format.
 */
export interface SyncSerializedChunk {
  /** Conversation metadata with the raw MLS group ID attached. */
  conversation: ConversationMeta & { groupId: string };
  /** Serialised encrypted message rows for this conversation. */
  rows: SyncSerializedEncryptedRow[];
}

/** Request body for uploading serialised chunks from one device to the server. */
export interface UploadSyncChunksRequest {
  sessionId: string;
  userId: string;
  /** Device ID of the uploader. */
  fromDeviceId: string;
  /** Device ID of the intended recipient. */
  toDeviceId: string;
  chunks: SyncSerializedChunk[];
}

/** Response body when pulling chunks that the server is holding for this device. */
export interface PullSyncChunksResponse {
  sessionId: string;
  /** Device ID that uploaded the chunks. */
  fromDeviceId: string;
  /** Device ID for which the chunks are destined. */
  toDeviceId: string;
  chunks: SyncSerializedChunk[];
}
