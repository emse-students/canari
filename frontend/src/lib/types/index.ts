export interface MessageReaction {
  emoji: string;
  userId: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  content: string;
  timestamp: Date;
  editedAt?: Date;
  isOwn: boolean;
  isSystem?: boolean;
  replyTo?: {
    id: string;
    senderId: string;
    content: string;
  };
  reactions?: MessageReaction[];
  readBy?: string[];
  isEdited?: boolean;
  isDeleted?: boolean;
}

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
}
