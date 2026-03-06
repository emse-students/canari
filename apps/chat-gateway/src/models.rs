use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // User ID
    pub exp: usize,
}

#[derive(Deserialize)]
pub struct AuthParams {
    pub token: String,
    pub device_id: Option<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WebSocketMessage {
    #[serde(rename_all = "camelCase")]
    MlsMessage {
        payload: String, // Opaque MLS content (Base64)
        group_id: Option<String>,
        // List of recipients for fan-out
        recipients: Option<Vec<Recipient>>, 
    },
    #[serde(rename_all = "camelCase")]
    WelcomeMessage {
        payload: String, 
        group_id: String,
        recipients: Vec<Recipient>, 
    },
    #[serde(rename_all = "camelCase")]
    Read { message_id: Uuid },
}

#[derive(Deserialize, Debug, PartialEq, Serialize, Clone)]
pub struct Recipient {
    pub userId: String,
    pub deviceId: String,
}

// REST Payload for Ratchet Tree storage
#[derive(Serialize, Deserialize)]
pub struct RatchetTreePayload {
    pub data: String, // Base64 encoded Tree
    pub version: u64,
}

pub fn process_incoming(text: &str) -> Result<WebSocketMessage, serde_json::Error> {
    serde_json::from_str(text) 
}