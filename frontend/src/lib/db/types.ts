// ---------------------------------------------------------------------------
// Shared types and the IStorage interface for Canari's local message store.
// ---------------------------------------------------------------------------

import type { ConversationLifecycle, MessageReaction, ReadWatermarks } from '$lib/types';

/** Lightweight metadata row for a conversation stored in the local DB (no message payload). */
export interface ConversationMeta {
  /** Primary key - equals the MLS groupId UUID (e.g. "g-abc123", "channel_xyz", "dm_uuid"). */
  id: string;
  /** Human-readable name shown in the conversation list. */
  name: string;
  /**
   * Persisted lifecycle state (see {@link ConversationLifecycle}). Replaces the old `isReady`
   * boolean and now also persists the `removed` state -> a deleted/excluded conversation survives
   * a reload without depending on a server re-sync (rules 2 & 4).
   */
  lifecycle: ConversationLifecycle;
  /** Unix milliseconds - used for ordering conversations by recency. */
  updatedAt: number;
  /**
   * Read state for the whole conversation, one monotone instant per participant. It lives here
   * rather than on each message so that OUR OWN read state survives a reload without waiting for a
   * peer to hand it back (D2), and so that marking a thousand messages read is one write.
   */
  readWatermarks?: ReadWatermarks;
  /**
   * Where the shared history of this conversation begins, merged as `max` across members. Stored
   * next to the read state because both are properties of the conversation rather than of any
   * message, and both travel in the same reconciliation frames.
   */
  historyFloor?: number;
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
  /**
   * One entry per `(user, emoji)` pair, INCLUDING the ones taken back - a removal is an entry with
   * `removed: true`, which is what lets it reach a device still holding the placement. See
   * `$lib/utils/chat/messageReactions`.
   */
  reactions?: MessageReaction[];
  /**
   * Server queue creation time (Unix ms) - stable secondary sort key when two messages share
   * the same client `sentAt` timestamp.  Set from `queuedCreatedAt` in the delivery envelope.
   */
  serverTimestamp?: number;
  /** Set to true when the message has been deleted (content replaced server-side). */
  isDeleted?: boolean;
  /** Set to true when the message body has been edited by the sender. */
  isEdited?: boolean;
  /**
   * Unix ms of the last edit, carried by the `edit_message` event. Optional and absent from rows
   * written before it existed: `isEdited` alone still renders the "edited" marker, and the info
   * tooltip simply omits the time rather than inventing one.
   */
  editedAt?: number;
  /** True when stored from FCM notification preview (plain text). */
  isFcmPreview?: boolean;
}

/**
 * The fields of a stored message a mutation is allowed to change.
 *
 * `id` and `conversationId` are the row's identity, never patchable: a reaction may not move a
 * message to another conversation. Applied by `mergeStoredMessage`.
 */
export type StoredMessagePatch = Partial<Omit<StoredMessage, 'id' | 'conversationId'>>;

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
 * PIN) so it survives reload, reconnection, MLS recovery, and app kill. The flusher re-encodes
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
 * One Graine session as this device holds it.
 *
 * A session belongs to one SENDER in one CHANNEL. `sessionId` is unique across every sender and is
 * the primary key, because no two senders ever write the same session namespace - which is what
 * lets a session be minted with no coordination at all.
 *
 * **These have to be durable, unlike the epoch keys they replace.** An epoch key could live in
 * memory because the server re-served it on every load; after Graine the server has nothing to
 * re-serve, so a lost seed is history a member can only get back by asking a peer.
 */
export interface StoredGraineSession {
  /** Community the channel belongs to - the scope a history bundle and a purge both work at. */
  workspaceId: string;
  channelId: string;
  /** Unique across senders; the primary key. */
  sessionId: string;
  /** Who minted it, and therefore who a repair request is addressed to - they always hold it. */
  senderId: string;
  /** The 32-byte seed, base64. THE secret, and the only field encrypted at rest. */
  seedB64: string;
  /**
   * Lowest index this device may derive. Non-zero when the seed was handed over mid-session, so a
   * member who joined late cannot open messages sent before they were allowed to.
   */
  firstIndex: number;
  createdAt: number;
  /**
   * Messages this device has SEALED with the session, which is what the 100-message rotation
   * counts. Absent on a received session: this device never seals with someone else's.
   */
  sentCount?: number;
}

/**
 * A Graine row exactly as stored, for backup export and import.
 *
 * The seed travels still encrypted under the device key, like message rows: a backup is restored
 * onto a device holding the same key, so re-encrypting would buy nothing and would mean decrypting
 * every seed to write a file.
 */
export interface EncryptedGraineRow {
  sessionId: string;
  workspaceId: string;
  channelId: string;
  senderId: string;
  firstIndex: number;
  createdAt: number;
  sentCount?: number;
  /** 12-byte AES-GCM initialization vector, as for a message row. */
  iv: Uint8Array;
  /** AES-256-GCM ciphertext of the seed payload. */
  cipherText: Uint8Array;
}

/**
 * Storage backend abstraction for Canari's local message store.
 *
 * Two implementations exist: IndexedDbStorage (browser / PWA) and SqliteStorage (Tauri desktop/mobile).
 * Conversation metadata is stored as plaintext; message content is encrypted with the user's
 * device key (32-byte key derived from the PIN via Argon2id once at first login) using AES-256-GCM.
 * No PBKDF2 or per-message salt is needed — the device key is imported directly as a CryptoKey.
 */
/**
 * The local store.
 *
 * **Any method added here that WRITES messages must drop the reconciliation's cached state key**
 * (`invalidateHistoryStateKey`, or `invalidateAllHistoryStateKeys` when it cannot name the
 * conversation). The key stands for "what this device holds", so a write that leaves it in place
 * makes the device claim an agreement it no longer has - and that loses messages silently, where an
 * unnecessary invalidation only costs one walk of the store.
 */
export interface IStorage {
  /** Open the underlying database and run any pending schema migrations. Must be called once before any other method. */
  init(): Promise<void>;

  /**
   * Release the underlying connection. Idempotent, and safe to call on a store that never opened.
   *
   * Exists for one reason: deleting the database while a connection is still open does not fail, it
   * BLOCKS - `indexedDB.deleteDatabase` fires `onblocked` and completes whenever the last connection
   * happens to close. A wipe that "completes eventually" is not a wipe you can assert on, and the
   * one place that needs it is a revoked device, where the point is that nothing survives.
   */
  close(): Promise<void>;

  // Conversations (stored as plaintext metadata)

  /** Upsert a conversation metadata row (create or overwrite). */
  saveConversation(conv: ConversationMeta): Promise<void>;
  /** Return all stored conversation metadata rows, ordered by recency. */
  getConversations(): Promise<ConversationMeta[]>;
  /**
   * Return one conversation's metadata row, or `null` when there is none.
   *
   * Prefer this over filtering `getConversations()`: a whole-table read inside a per-group loop
   * makes the work grow with the square of the number of conversations.
   */
  getConversation(id: string): Promise<ConversationMeta | null>;
  /** Delete the conversation row and cascade-delete all of its messages. */
  deleteConversation(id: string): Promise<void>;
  /** Delete all messages for a conversation without removing its metadata row. */
  deleteMessagesForConversation(conversationId: string): Promise<void>;

  // Messages (content encrypted with device key)

  /** Encrypt and persist a single message to the local store. */
  saveMessage(msg: StoredMessage, deviceKeyB64: string): Promise<void>;
  /** Encrypt and persist a batch of messages in a single atomic write. */
  saveMessages(msgs: StoredMessage[], deviceKeyB64: string): Promise<void>;
  /**
   * Merge `patch` into the stored message (read-modify-write; re-encrypts the payload).
   * No-op if the row is absent or undecryptable.
   *
   * The way to persist a MUTATION of an existing message: `saveMessage` replaces the whole row, so
   * a handler using it erases every field it did not itself carry. See `mergeStoredMessage`.
   */
  updateMessage(id: string, patch: StoredMessagePatch, deviceKeyB64: string): Promise<void>;
  /**
   * Remove one message row outright. No-op when the row is absent.
   *
   * NOT the way to record a deletion the peers know about - that is `updateMessage` with
   * `isDeleted`, which keeps the row so the tombstone survives a reload. This is for a message no
   * other device ever had: one withdrawn from the outbox before it was sent. There is nothing for a
   * tombstone to stand for, and the row left behind is one no peer can ever match.
   *
   * `conversationId` is taken rather than looked up because the caller already knows it and the
   * cached history-state key is per-conversation.
   */
  deleteMessage(id: string, conversationId: string): Promise<void>;
  /** Decrypt and return all messages for a conversation, sorted oldest-first. */
  getMessages(conversationId: string, deviceKeyB64: string): Promise<StoredMessage[]>;
  /** Return the most recent `limit` messages, optionally those strictly before `beforeTimestamp`. */
  getMessagesPage(
    conversationId: string,
    deviceKeyB64: string,
    limit: number,
    beforeTimestamp?: number
  ): Promise<StoredMessage[]>;

  // Garbage collection - delete messages older than the given threshold.

  /** Delete messages older than `maxAgeMs` milliseconds and return the count of deleted rows. */
  deleteOldMessages(maxAgeMs: number): Promise<number>;

  // Backup helpers - expose raw encrypted rows so backups don't require
  // re-encryption and can be imported to a new device with the same device key.

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

  // Outbox (queued outbound messages; sensitive payload encrypted with device key)

  /** Encrypt and upsert a queued outbound message. */
  saveOutboxEntry(entry: OutboxEntry, deviceKeyB64: string): Promise<void>;
  /** Decrypt and return all queued entries, sorted by `sentAt` ascending (compose order). */
  getOutboxEntries(deviceKeyB64: string): Promise<OutboxEntry[]>;
  /** Decrypt and return queued entries targeting `conversationId`, sorted by `sentAt`. */
  getOutboxEntriesForConversation(
    conversationId: string,
    deviceKeyB64: string
  ): Promise<OutboxEntry[]>;
  /** Merge `patch` into the stored entry (read-modify-write; re-encrypts the payload). No-op if absent. */
  updateOutboxEntry(id: string, patch: Partial<OutboxEntry>, deviceKeyB64: string): Promise<void>;
  /** Remove a queued entry (after a confirmed send or a permanent failure). */
  deleteOutboxEntry(id: string): Promise<void>;

  // Graine sessions (seed encrypted with the device key; everything else clear so a session can be
  // listed, ordered and pruned without it)

  /** Encrypt the seed and upsert one session. Re-saving the same `sessionId` overwrites it. */
  saveGraineSession(session: StoredGraineSession, deviceKeyB64: string): Promise<void>;
  /**
   * Every session held for one channel, newest first. Undecryptable rows are skipped and reported
   * rather than dropping the whole read - one unreadable seed must not cost the other nineteen.
   */
  getGraineSessions(channelId: string, deviceKeyB64: string): Promise<StoredGraineSession[]>;
  /** One session by id, or null. The lookup a received message makes before it can be opened. */
  getGraineSession(sessionId: string, deviceKeyB64: string): Promise<StoredGraineSession | null>;
  /**
   * Drop every session of a community, returning how many went.
   *
   * The scope is deliberately the COMMUNITY and not the channel: leaving takes away every salon at
   * once, and a per-channel purge would leave seeds for salons the device can no longer even list.
   */
  deleteGraineSessionsForWorkspace(workspaceId: string): Promise<number>;

  /** Return all Graine rows as-is (seed still encrypted) for backup export. */
  getAllEncryptedGraineRows(): Promise<EncryptedGraineRow[]>;
  /**
   * Non-destructive insert of a backed-up Graine row: writes only when the device holds no session
   * with that id, so a device live since the backup keeps what it has learned since.
   */
  importEncryptedGraineRow(row: EncryptedGraineRow): Promise<void>;

  /** Wipe all conversations, messages, outbox entries and Graine sessions (tests / account reset). */
  clear(): Promise<void>;
}
