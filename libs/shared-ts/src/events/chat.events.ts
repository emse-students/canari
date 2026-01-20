// Event Topics
export const KAFKA_TOPICS = {
    CHAT_MESSAGES: 'chat_messages',
    MESSAGE_READ: 'message_read',
    POST_CREATED: 'post_created',
};

// Payload Definitions
export { MessageSentEvent } from '../types/MessageSentEvent';
export { MessageReadEvent } from '../types/MessageReadEvent';
export { PostCreatedEvent } from '../types/PostCreatedEvent';
