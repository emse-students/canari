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
/// `device_id` : identifiant stable du device MLS, fourni par le client.
/// Utiliser cet ID (plutôt qu'un UUID généré serveur) garantit que la clé de
/// routage `group:members:{groupId}` reste valide d'une connexion à l'autre.
/// La sécurité est assurée par le JWT : un client ne peut accéder qu'aux
/// messages de l'userId extrait du token, quelle que soit la valeur de device_id.
///
/// `token` : JWT d'accès en fallback pour Tauri Android/mobile, où le plugin
/// WebSocket natif (hors WebView) ne peut pas envoyer les cookies du WebView.
/// Utilisé UNIQUEMENT si le cookie `canari_ws_token` est absent.
#[derive(Deserialize)]
pub struct AuthParams {
    pub device_id: Option<String>,
    pub token: Option<String>,
}
