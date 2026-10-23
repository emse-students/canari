use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::{Deserialize, Serialize};

// ── JWT / REST serde types ────────────────────────────────────────────────────

/// JWT payload claims.  `sub` is the user ID; `exp` is the Unix expiry timestamp.
///
/// `kind` is the `type` claim. core-service signs its ACCESS token without one and its REFRESH
/// token with `"refresh"`, both with the same secret, so the signature alone does not say which of
/// the two a client presented. Only an access token opens a socket ([`decode_access_claims`]).
#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// Why a WebSocket upgrade token was refused.
#[derive(Debug)]
pub enum TokenRejection {
    /// Bad signature, wrong algorithm, expired or malformed.
    Invalid(jsonwebtoken::errors::Error),
    /// A valid token of another kind (the refresh token), carrying the kind it declared.
    NotAnAccessToken(String),
}

/// Verifies an HS256 token and accepts it only as an ACCESS token: no `type` claim, or `"access"`.
///
/// The same check core-service makes on its own routes (`auth.controller.ts`), so a refresh token,
/// which lives for days and is bound to a server-side session, never stands in for the short-lived
/// access token at the socket.
pub fn decode_access_claims(token: &str, secret: &[u8]) -> Result<Claims, TokenRejection> {
    let validation = Validation::new(Algorithm::HS256);
    let claims = decode::<Claims>(token, &DecodingKey::from_secret(secret), &validation)
        .map_err(TokenRejection::Invalid)?
        .claims;
    match claims.kind.as_deref() {
        None | Some("access") => Ok(claims),
        Some(other) => Err(TokenRejection::NotAnAccessToken(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};

    const SECRET: &[u8] = b"test-secret";

    fn token(kind: Option<&str>, secret: &[u8], alg: Algorithm) -> String {
        let claims = Claims {
            sub: "user-1".into(),
            exp: 4_000_000_000,
            kind: kind.map(str::to_string),
        };
        encode(
            &Header::new(alg),
            &claims,
            &EncodingKey::from_secret(secret),
        )
        .unwrap()
    }

    #[test]
    fn an_access_token_is_accepted() {
        let claims = decode_access_claims(&token(None, SECRET, Algorithm::HS256), SECRET).unwrap();
        assert_eq!(claims.sub, "user-1");
        assert!(
            decode_access_claims(&token(Some("access"), SECRET, Algorithm::HS256), SECRET).is_ok()
        );
    }

    #[test]
    fn a_refresh_token_is_refused() {
        match decode_access_claims(&token(Some("refresh"), SECRET, Algorithm::HS256), SECRET) {
            Err(TokenRejection::NotAnAccessToken(kind)) => assert_eq!(kind, "refresh"),
            other => panic!("expected NotAnAccessToken, got {:?}", other.map(|c| c.sub)),
        }
    }

    #[test]
    fn another_secret_or_algorithm_is_refused() {
        assert!(matches!(
            decode_access_claims(&token(None, b"other", Algorithm::HS256), SECRET),
            Err(TokenRejection::Invalid(_))
        ));
        assert!(matches!(
            decode_access_claims(&token(None, SECRET, Algorithm::HS512), SECRET),
            Err(TokenRejection::Invalid(_))
        ));
    }
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
///
/// `caps`: comma-separated capabilities the code behind this socket declares. The one read today is
/// [`crate::addressing::ADDRESSED_HISTORY_CAPABILITY`]; absent on every build that predates it.
#[derive(Deserialize)]
pub struct AuthParams {
    pub device_id: Option<String>,
    pub token: Option<String>,
    pub caps: Option<String>,
}
