use serde::{Deserialize, Serialize};

// ── JWT / REST serde types ────────────────────────────────────────────────────

/// JWT payload claims.  `sub` is the user ID; `exp` is the Unix expiry timestamp.
#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

/// Query parameters accepted by the WebSocket upgrade endpoint.
/// Note: authentication uses the `canari_ws_token` cookie only.
/// Device ID is always generated server-side and is not accepted from the client.
#[derive(Deserialize)]
pub struct AuthParams {}
