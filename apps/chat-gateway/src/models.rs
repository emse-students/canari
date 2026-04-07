use serde::{Deserialize, Serialize};

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
