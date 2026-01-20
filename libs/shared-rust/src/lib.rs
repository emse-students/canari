use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;
use ts_rs::TS;

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
