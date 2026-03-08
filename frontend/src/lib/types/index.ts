export interface ChatMessage {
  id: string;
  senderId: string;
  content: string;
  timestamp: Date;
  isOwn: boolean;
  isSystem?: boolean;
  replyTo?: {
    id: string;
    senderId: string;
    content: string;
  };
}

export interface MessageReaction {
  emoji: string;
  userId: string;
}

export interface Conversation {
  contactName: string;
  name: string;
  groupId: string;
  messages: ChatMessage[];
  isReady: boolean;
  mlsStateHex: string | null;
}
