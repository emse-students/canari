use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

pub const TOPIC_CHAT_MESSAGES: &str = "chat_messages";
pub const TOPIC_MESSAGE_READ: &str = "message_read";
pub const TOPIC_POST_CREATED: &str = "post_created";

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../shared-ts/src/types/MessageSentEvent.ts")]
#[serde(rename_all = "camelCase")]
pub struct MessageSentEvent {
    pub id: Uuid,
    pub sender_id: String,
    pub username: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../shared-ts/src/types/MessageReadEvent.ts")]
#[serde(rename_all = "camelCase")]
pub struct MessageReadEvent {
    pub message_id: Uuid,
    pub user_id: String, // Recipient who read the message
    pub timestamp: DateTime<Utc>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, TS)]
#[ts(export, export_to = "../../shared-ts/src/types/PostCreatedEvent.ts")]
#[serde(rename_all = "camelCase")]
pub struct PostCreatedEvent {
    pub id: Uuid,
    pub author_id: String,
    pub content: String,
    pub media_urls: Vec<String>,
    pub timestamp: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_sent_event_creation() {
        let id = Uuid::new_v4();
        let timestamp = Utc::now();
        let event = MessageSentEvent {
            id,
            sender_id: "sender".to_string(),
            username: "user".to_string(),
            content: "content".to_string(),
            timestamp,
            conversation_id: None,
        };

        assert_eq!(event.username, "user");
        assert_eq!(event.content, "content");
        assert_eq!(event.sender_id, "sender");
    }

    #[test]
    fn test_message_read_event_creation() {
        let id = Uuid::new_v4();
        let timestamp = Utc::now();
        let event = MessageReadEvent {
            message_id: id,
            user_id: "reader".to_string(),
            timestamp,
            conversation_id: Some("conv_1".to_string()),
        };

        assert_eq!(event.user_id, "reader");
        assert_eq!(event.message_id, id);
        assert_eq!(event.conversation_id, Some("conv_1".to_string()));
    }

    #[test]
    fn test_post_created_event_creation() {
        let id = Uuid::new_v4();
        let timestamp = Utc::now();
        let event = PostCreatedEvent {
            id,
            author_id: "author".to_string(),
            content: "post content".to_string(),
            media_urls: vec!["http://example.com/img.jpg".to_string()],
            timestamp,
        };

        assert_eq!(event.author_id, "author");
        assert_eq!(event.content, "post content");
        assert_eq!(event.media_urls.len(), 1);
    }
}
