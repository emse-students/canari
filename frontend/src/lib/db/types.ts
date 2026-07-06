// ---------------------------------------------------------------------------
// Shared types and the IStorage interface for Canari's local message store.
// ---------------------------------------------------------------------------

import type { ConversationLifecycle } from '$lib/types';

/** Lightweight metadata row for a conversation stored in the local DB (no message payload). */
export interface ConversationMeta {
  /** Primary key - equals the MLS groupId UUID (e.g. "g-abc123", "channel_xyz", "dm_uuid"). */
  id: string;
  /** Human-readable name shown in the conversation list. */
  name: string;
  /**
   * Etat de cycle de vie persiste (cf. {@link ConversationLifecycle}). Remplace l'ancien booleen
   * `isReady` et persiste desormais aussi l'etat `removed` -> une conversation supprimee/exclue
   * survit au reload sans dependre d'une re-synchro serveur (regles 2 & 4).
   */
  lifecycle: ConversationLifecycle;
  /** Unix milliseconds - used for ordering conversations by recency. */
  updatedAt: number;
}

/** A decrypted message as stored in and read from the local database. */
export interface StoredMessage {
  /** Stable message UUID shared across all devices in the group. */
  id: string;
  /** Foreign key matching ConversationMeta.id (= MLS groupId). */
  conversationId: string;
  /** Lowercase user ID of the author. */
  senderId: string;
  /** Serialized MessageEnvelope (JSON string produced by serializeEnvelope). */
  content: string;
  /** Creation time as Unix milliseconds. */
  timestamp: number;
  /** User IDs that have acknowledged reading this message. */
  readBy?: string[];
  reactions?: Array<{ emoji: string; userId: string }>;
  /** Unix ms when the first read receipt for this message was received locally. */
  readAt?: number;
  /**
   * Server queue creation time (Unix ms) - stable secondary sort key when two messages share
   * the same client `sentAt` timestamp.  Set from `queuedCreatedAt` in the delivery envelope.
   */
  serverTimestamp?: number;
  /** Set to true when the message has been deleted (content replaced server-side). */
  isDeleted?: boolean;
  /** Set to true when the message body has been edited by the sender. */
  isEdited?: boolean;
  /** True when stored from FCM notification preview (plain text). */
  isFcmPreview?: boolean;
}

/**
 * Raw encrypted message row as persisted on disk (IndexedDB or SQLite).
 * The content field of StoredMessage is never stored in plaintext - only this encrypted form exists on disk.
 */
export interface EncryptedMessageRow {
  /** Same UUID as StoredMessage.id. */
  id: string;
  /** Foreign key matching ConversationMeta.id. */
  conversationId: string;
  /** Creation time as Unix milliseconds (stored in plaintext for pagination / GC). */
  timestamp: number;
  /** 12-byte AES-GCM initialization vector, unique per encrypted blob. */
  iv: Uint8Array;
  /** 16-byte PBKDF2 salt used to derive the AES-256 key from the user's PIN. */
  salt: Uint8Array;
  /** AES-256-GCM ciphertext of the JSON-serialized message payload (includes 16-byte auth tag). */
  cipherText: Uint8Array;
}

/** Encrypted-blob reference for a media file already uploaded to the media-service. */
export interface OutboxMediaUploadedRef {
  mediaId: string;
  /** Hex-encoded AES-256-GCM content-encryption key (CEK). */
  key: string;
  /** Hex-encoded IV for the media blob. */
  iv: string;
}

/** Sensitive media descriptor for a queued media message. */
export interface OutboxMediaPayload {
  /** MediaKind enum value (image/video/audio/file). */
  kind: number;
  mimeType: string;
  size: number;
  fileName?: string;
  caption?: string;
  width?: number;
  height?: number;
  /**
   * Raw (already client-compressed) file bytes, kept until the blob is uploaded.
   * Cleared once `uploadedRef` is set so the queue does not hold the file twice.
   */
  fileBytes?: Uint8Array;
  /** Set after a successful encryptAndUpload; makes the flush idempotent (no re-upload). */
  uploadedRef?: OutboxMediaUploadedRef;
}

/**
 * A queued outbound message awaiting delivery. Persisted (payload encrypted with the user
 * PIN) so it survives reload, reconnection, MLS reboot, and app kill. The flusher re-encodes
 * the proto and sends it against the current epoch once the target group is healthy.
 *
 * Clear columns (id, conversationId, sentAt, kind, status, attempts, nextAttemptAt) mirror the
 * StoredMessage convention (timestamp/conversationId clear, content encrypted): they are
 * authoritative for querying/sorting/re-keying without needing the PIN.
 */
export interface OutboxEntry {
  /** Stable message UUID, shared with the optimistic StoredMessage and the proto messageId. */
  id: string;
  /** Logical conversation key (= MLS groupId); re-keyed on a duplicate-group merge. */
  conversationId: string;
  /** Compose time (Unix ms) - IMMUTABLE; the canonical ordering key, sent as proto sentAt. */
  sentAt: number;
  kind: 'text' | 'reply' | 'media' | 'control';
  /** Sensitive payload (encrypted at rest): plain text body for text/reply. */
  text?: string;
  /** Quoted message reference for replies. */
  replyTo?: { id: string; senderId: string; preview: string };
  /** Sensitive media descriptor + (until uploaded) file bytes. */
  media?: OutboxMediaPayload;
  /**
   * Pre-encoded AppMessage proto for a `control` entry (reaction, edit, delete, pin,
   * read receipt). Unlike text/reply, the proto is built once at enqueue time (its content
   * is epoch-independent and fixed), so the flusher sends it verbatim. Routing control
   * events through the durable outbox - instead of a fire-and-forget `sendMessage` that was
   * dropped whenever the group was momentarily unsendable - makes reactions / edits /
   * read-state converge reliably across peers.
   */
  controlProto?: Uint8Array;
  status: 'pending' | 'sending';
  attempts: number;
  lastAttemptAt?: number;
  /** Earliest time (Unix ms) the next flush attempt may run (backoff). */
  nextAttemptAt?: number;
  createdAt: number;
}

/**
 * Storage backend abstraction for Canari's local message store.
 *
 * Two implementations exist: IndexedDbStorage (browser / PWA) and SqliteStorage (Tauri desktop/mobile).
 * Conversation metadata is stored as plaintext; message content is encrypted with the user's PIN before
 * being written to disk (PBKDF2-HMAC-SHA-256 key derivation + AES-256-GCM encryption).
 */
export interface IStorage {
  /** Open the underlying database and run any pending schema migrations. Must be called once before any other method. */
  init(): Promise<void>;

  // Conversations (stored as plaintext metadata)

  /** Upsert a conversation metadata row (create or overwrite). */
  saveConversation(conv: ConversationMeta): Promise<void>;
  /** Return all stored conversation metadata rows, ordered by recency. */
  getConversations(): Promise<ConversationMeta[]>;
  /** Delete the conversation row and cascade-delete all of its messages. */
  deleteConversation(id: string): Promise<void>;
  /** Delete all messages for a conversation without removing its metadata row. */
  deleteMessagesForConversation(conversationId: string): Promise<void>;

  // Messages (content encrypted with user PIN)

  /** Encrypt and persist a single message to the local store. */
  saveMessage(msg: StoredMessage, pin: string): Promise<void>;
  /** Encrypt and persist a batch of messages in a single atomic write. */
  saveMessages(msgs: StoredMessage[], pin: string): Promise<void>;
  /** Decrypt and return all messages for a conversation, sorted oldest-first. */
  getMessages(conversationId: string, pin: string): Promise<StoredMessage[]>;
  /** Return the most recent `limit` messages, optionally those strictly before `beforeTimestamp`. */
  getMessagesPage(
    conversationId: string,
    pin: string,
    limit: number,
    beforeTimestamp?: number
  ): Promise<StoredMessage[]>;

  // Garbage collection - delete messages older than the given threshold.

  /** Delete messages older than `maxAgeMs` milliseconds and return the count of deleted rows. */
  deleteOldMessages(maxAgeMs: number): Promise<number>;

  // Backup helpers - expose raw encrypted rows so backups don't require
  // re-encryption and can be imported to a new device with the same PIN.

  /** Return all encrypted message rows as-is (no decryption) for use in backup export. */
  getAllEncryptedRows(): Promise<EncryptedMessageRow[]>;

  /**
   * Non-destructive insert: write the conversation metadata only if no row
   * with this id already exists.  Used during import so that a device that
   * has been live since the backup was taken keeps its current state.
   */
  mergeConversation(conv: ConversationMeta): Promise<void>;

  /**
   * Non-destructive insert: write the encrypted message row only if no row
   * with this id already exists.  This ensures messages received after the
   * backup was taken are preserved on the target device.
   */
  importEncryptedRow(row: EncryptedMessageRow): Promise<void>;

  // Outbox (queued outbound messages; sensitive payload encrypted with user PIN)

  /** Encrypt and upsert a queued outbound message. */
  saveOutboxEntry(entry: OutboxEntry, pin: string): Promise<void>;
  /** Decrypt and return all queued entries, sorted by `sentAt` ascending (compose order). */
  getOutboxEntries(pin: string): Promise<OutboxEntry[]>;
  /** Decrypt and return queued entries targeting `conversationId`, sorted by `sentAt`. */
  getOutboxEntriesForConversation(conversationId: string, pin: string): Promise<OutboxEntry[]>;
  /** Merge `patch` into the stored entry (read-modify-write; re-encrypts the payload). No-op if absent. */
  updateOutboxEntry(id: string, patch: Partial<OutboxEntry>, pin: string): Promise<void>;
  /** Remove a queued entry (after a confirmed send or a permanent failure). */
  deleteOutboxEntry(id: string): Promise<void>;

  /** Wipe all conversations, messages, and outbox entries from the local store (tests / account reset). */
  clear(): Promise<void>;
}
