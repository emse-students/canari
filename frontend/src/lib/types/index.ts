/**
 * Etat de cycle de vie d'une conversation - source UNIQUE qui remplace l'ancien couple
 * `(isReady, deletedRemotely)`.
 *  - `active`  : groupe MLS etabli, membre actif -> lecture + ENVOI.
 *  - `pending` : placeholder en attente de Welcome (recovery/reboot applicables) -> lecture seule.
 *  - `removed` : supprime par un pair / exclusion / suppression locale en attente -> lecture seule +
 *                banniere, reste jusqu'a SUPPRESSION MANUELLE (regles 2 & 4).
 * Predicats et logique de transition : `$lib/utils/chat/groupLifecycle`.
 */
export type ConversationLifecycle = 'active' | 'pending' | 'removed';

/** A single emoji reaction and the user who placed it on a message. */
export interface MessageReaction {
  emoji: string;
  userId: string;
}

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
   * confirmed by the server, 'error' = permanent failure (lineage deleted without successor).
   */
  status?: 'pending' | 'sending' | 'sent' | 'error';
  replyTo?: MessageReference;
  reactions?: MessageReaction[];
  readBy?: string[];
  /** Unix ms when the first read receipt for this message was received locally. Persisted to DB. */
  readAt?: number;
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
   * Etat de cycle de vie (cf. {@link ConversationLifecycle}) - source UNIQUE qui remplace l'ancien
   * couple `(isReady, deletedRemotely)`. `active` = envoyable ; `pending` = placeholder en attente
   * de Welcome (recovery applicable) ; `removed` = supprime/exclu, lecture seule + banniere.
   */
  lifecycle: ConversationLifecycle;
  mlsStateHex: string | null;
  unreadCount?: number;
  conversationType?: 'direct' | 'group' | 'channel';
  directPeerId?: string;
  /** Media-service ID of the group/channel image (unencrypted avatar). */
  imageMediaId?: string | null;
  /**
   * Unix-ms timestamp of the most recent message in this conversation.
   * Updated on every addMessageToChat / batchAddMessages call so the sidebar
   * can sort correctly even when `messages[]` is still empty (startup stubs).
   */
  lastMessageAt?: number;
}
