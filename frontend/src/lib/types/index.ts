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
  status?: 'sending' | 'sent' | 'error';
  /** When true, keep the message in memory only (e.g. server-authoritative community channels). */
  skipDbSave?: boolean;
  /** Monotonic catch-up index (MLS queue / history replay order); not persisted to DB. */
  ingestSequence?: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  content: string;
  timestamp: Date;
  editedAt?: Date;
  isOwn: boolean;
  isSystem?: boolean;
  /** Optimistic send state: undefined = received/confirmed, 'sending' = in-flight, 'error' = failed */
  status?: 'sending' | 'sent' | 'error';
  replyTo?: MessageReference;
  reactions?: MessageReaction[];
  readBy?: string[];
  /** Timestamp (Date.now()) of when the first read receipt was received. */
  readAt?: number;
  isEdited?: boolean;
  isDeleted?: boolean;
  /** In-memory only: preserves arrival order during bulk catch-up when timestamps tie. */
  ingestSequence?: number;
}

/**
 * Runtime representation of a conversation (DM, group, or channel).
 *
 * `messages` is loaded lazily — it can be empty while the conversation is still
 * visible in the sidebar. `lastMessageAt` provides a stable sort key even before
 * messages are loaded; it is initialised from `ConversationMeta.updatedAt` on
 * startup and kept up-to-date by `addMessageToChat` / `batchAddMessages`.
 */
export interface Conversation {
  /** Primary key — the MLS groupId UUID (same as ConversationMeta.id). */
  id: string;
  /** Display name shown in the UI (e.g. peer username, group name). */
  name: string;
  /** Human-readable auxiliary identifier (peer username for DMs, group display name for groups). */
  contactName: string;
  messages: ChatMessage[];
  isReady: boolean;
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
