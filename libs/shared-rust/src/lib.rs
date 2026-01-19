use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;

pub const TOPIC_CHAT_MESSAGES: &str = "chat_messages";
pub const TOPIC_POST_CREATED: &str = "post_created";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MessageSentEvent {
    pub id: Uuid,
    pub sender_id: String,
    pub username: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub conversation_id: Option<String>,
}


#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PostCreatedEvent {
    pub id: Uuid,
    pub author_id: String,
    pub content: String,
    pub media_urls: Vec<String>,
    pub timestamp: DateTime<Utc>,
}
