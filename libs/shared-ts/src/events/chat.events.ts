// Event Topics
export const KAFKA_TOPICS = {
    CHAT_MESSAGES: 'chat_messages',
    POST_CREATED: 'post_created',
};

// Payload Definitions
export interface MessageSentEvent {
    id: string;
    senderId: string;
    username: string;
    content: string;
    timestamp: string; // ISO 8601
    conversationId?: string;
}


export interface PostCreatedEvent {
    id: string;
    authorId: string;
    content: string;
    mediaUrls: string[];
    timestamp: string;
}
