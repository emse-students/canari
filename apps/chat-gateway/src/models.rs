use serde::{Deserialize, Serialize};

// ── JWT / REST serde types ────────────────────────────────────────────────────

/// JWT payload claims.  `sub` is the user ID; `exp` is the Unix expiry timestamp.
#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

/// Query parameters accepted by the WebSocket upgrade endpoint.
#[derive(Deserialize)]
pub struct AuthParams {
    /// Bearer token (fallback when no `canari_ws_token` cookie is present).
    pub token: Option<String>,
    /// Client-supplied device identifier, used to key presence and routing.
    pub device_id: Option<String>,
}
