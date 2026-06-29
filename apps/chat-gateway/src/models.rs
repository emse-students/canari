use serde::{Deserialize, Serialize};

// ── JWT / REST serde types ────────────────────────────────────────────────────

/// JWT payload claims.  `sub` is the user ID; `exp` is the Unix expiry timestamp.
#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

/// Query parameters accepted by the WebSocket upgrade endpoint.
///
/// `device_id`: stable MLS device identifier provided by the client.
/// Using this ID (rather than a server-generated UUID) guarantees that the
/// routing key `group:members:{groupId}` stays valid across reconnections.
/// Security is ensured by the JWT: a client can only access messages for the
/// userId extracted from the token, regardless of the device_id value.
///
/// `token`: JWT access token fallback for Tauri Android/mobile, where the
/// native WebSocket plugin (outside the WebView) cannot send WebView cookies.
/// Used ONLY when the `canari_ws_token` cookie is absent.
#[derive(Deserialize)]
pub struct AuthParams {
    pub device_id: Option<String>,
    pub token: Option<String>,
}
