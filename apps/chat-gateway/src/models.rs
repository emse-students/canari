use serde::{Deserialize, Serialize};

// ── Plain routing type ───────────────────────────────────────────────────────

pub struct Recipient {
    pub user_id: String,
    pub device_id: String,
}

// ── JWT / REST serde types ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

#[derive(Deserialize)]
pub struct AuthParams {
    pub token: String,
    pub device_id: Option<String>,
}

/// REST payload for Ratchet-Tree storage.
#[derive(Serialize, Deserialize)]
pub struct RatchetTreePayload {
    pub data: String,
    pub version: u64,
}
