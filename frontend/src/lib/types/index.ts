/**
 * Lifecycle state of a conversation - the SINGLE source replacing the old
 * `(isReady, deletedRemotely)` pair.
 *  - `active` : MLS group established, active member -> read + SEND.
 *  - `pending`: placeholder awaiting a Welcome (recovery applicable) -> read-only.
 *  - `removed`: deleted by a peer / exclusion / pending local deletion -> read-only + banner,
 *               stays until MANUAL DELETION (rules 2 & 4).
 * Predicates and transition logic: `$lib/utils/chat/groupLifecycle`.
 */
export type ConversationLifecycle = 'active' | 'pending' | 'removed';

/**
 * The state of ONE `(user, emoji)` pair on a message - placed or taken back.
 *
 * A removal is kept as an entry with `removed: true` rather than dropped from the list, which is
 * what makes it reach a device that still holds the placement. There is exactly one entry per pair,
 * so a place/remove cycle does not grow the set: this is bounded, not a growing tombstone log.
 *
 * Both fields are optional because rows and frames written before they existed lack them, and both
 * defaults say the same thing - a bare `{emoji, userId}` is a placement of unknown age, which is
 * exactly what it was. It therefore loses any merge against a dated entry.
 */
export interface MessageReaction {
  emoji: string;
  userId: string;
  /** Unix ms at which this pair last changed state. The larger one wins the merge. */
  at?: number;
  /** True when the user took the reaction back. Absent or false = the reaction stands. */
  removed?: boolean;
}

/**
 * Read state for a conversation: `userId (lowercase) -> the instant that user has read up to`,
 * compared against a message's own client timestamp. Merged as `max`, which is what makes it
 * converge. See `$lib/utils/chat/readState` for the merge and every derived question.
 */
export type ReadWatermarks = Record<string, number>;

/** Compact reference to a quoted/replied-to message. Used in ChatMessage, envelopes, and addMessageToChat options. */
export type MessageReference = {
  id: string;
  senderId: string;
  content: string;
};

/** Options accepted by all addMessageToChat call sites. Centralised here so every interface stays in sync. */
export interface AddMessageToChatOptions {
  replyTo?: MessageReference;
  isSystem?: boolean;
  messageId?: string;
  timestamp?: Date;
  status?: 'pending' | 'sending' | 'sent' | 'error';
  /** True when content came from FCM preview cache (plain text, upgradeable by MLS envelope). */
  isFcmPreview?: boolean;
  /** When true, keep the message in memory only (e.g. server-authoritative community channels). */
  skipDbSave?: boolean;
  /** Monotonic catch-up index (MLS queue / history replay order); used for in-session ordering only. */
  ingestSequence?: number;
  /**
   * Server queue creation time (Unix ms).  Persisted to DB as a stable secondary sort key
   * so messages with identical client `sentAt` values remain correctly ordered after reload.
   * Set from `queuedCreatedAt` in the MLS delivery envelope.
   */
  serverTimestamp?: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  content: string;
  timestamp: Date;
  editedAt?: Date;
  isOwn: boolean;
  isSystem?: boolean;
  /**
   * Optimistic send state: undefined = received/confirmed, 'pending' = queued in the outbox
   * (group not yet sendable / offline), 'sending' = handed to MLS and in-flight, 'sent' =
   * confirmed by the server, 'error' = permanent failure (group deleted server-side).
   */
  status?: 'pending' | 'sending' | 'sent' | 'error';
  replyTo?: MessageReference;
  reactions?: MessageReaction[];
  isEdited?: boolean;
  isDeleted?: boolean;
  /** In-session ordering during bulk catch-up (not persisted); use serverTimestamp for stable reload ordering. */
  ingestSequence?: number;
  /**
   * Server queue creation time (Unix ms).  Persisted to DB and used as secondary sort key
   * when two messages share the same client `sentAt` timestamp.
   */
  serverTimestamp?: number;
  /** True when displayed from FCM preview before full MLS envelope arrives. */
  isFcmPreview?: boolean;
}

/**
 * Runtime representation of a conversation (DM, group, or channel).
 *
 * `messages` is loaded lazily - it can be empty while the conversation is still
 * visible in the sidebar. `lastMessageAt` provides a stable sort key even before
 * messages are loaded; it is initialised from `ConversationMeta.updatedAt` on
 * startup and kept up-to-date by `addMessageToChat` / `batchAddMessages`.
 */
export interface Conversation {
  /** Primary key - the MLS groupId UUID (same as ConversationMeta.id). */
  id: string;
  /** Display name shown in the UI (e.g. peer username, group name). */
  name: string;
  /** Human-readable auxiliary identifier (peer username for DMs, group display name for groups). */
  contactName: string;
  messages: ChatMessage[];
  /**
   * Lifecycle state (see {@link ConversationLifecycle}) - the SINGLE source replacing the old
   * `(isReady, deletedRemotely)` pair. `active` = sendable; `pending` = placeholder awaiting a
   * Welcome (recovery applicable); `removed` = deleted/excluded, read-only + banner.
   */
  lifecycle: ConversationLifecycle;
  mlsStateHex: string | null;
  unreadCount?: number;
  /**
   * Read state for the whole conversation: one monotone instant per participant, merged as `max`.
   * Replaces the per-message `readBy` array - see `$lib/utils/chat/readState` for why the read
   * state of a conversation cannot live on its messages.
   */
  readWatermarks?: ReadWatermarks;
  conversationType?: 'direct' | 'group' | 'channel';
  directPeerId?: string;
  /** Media-service ID of the group image (unencrypted avatar). Channels never carry one. */
  imageMediaId?: string | null;
  /**
   * Unix-ms timestamp of the most recent message in this conversation.
   * Updated on every addMessageToChat / batchAddMessages call so the sidebar
   * can sort correctly even when `messages[]` is still empty (startup stubs).
   */
  lastMessageAt?: number;
}
