mod handlers;
mod models;
mod presence;
mod state;
mod subscribers;
mod ws_dispatch;

use axum::{
    Router,
    http::{HeaderValue, Method, StatusCode},
    response::IntoResponse,
    routing::get,
};
use std::{net::SocketAddr, sync::Arc};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::handlers::ws_handler;
use crate::presence::{get_admin_presence, get_presence};
use crate::state::AppState;

/// Liveness probe endpoint - returns `200 OK` with body `"OK"`.
async fn health_check() -> impl IntoResponse {
    (StatusCode::OK, "OK")
}

/// Splits a comma-separated `ALLOW_ORIGIN` into the exact origins the CORS layer will match.
///
/// Blank segments are dropped so a trailing comma is not an error, and a segment that cannot be a
/// header value is skipped with a WARN naming it - one unusable spelling must not cost the other
/// four their policy. Note that a `HeaderValue` accepts almost any printable ASCII, so this
/// rejects malformed BYTES and not malformed ORIGINS: `htp:/typo` parses happily and will simply
/// match nothing. **The only proof an origin list is right is reading the served
/// `access-control-allow-origin` back after the deploy**, never the deploy's colour.
///
/// @param allow_origin - Raw `ALLOW_ORIGIN` value, e.g. `https://canari-emse.fr,tauri://localhost`.
fn parse_allowed_origins(allow_origin: &str) -> Vec<HeaderValue> {
    let mut origins: Vec<HeaderValue> = Vec::new();
    for part in allow_origin.split(',') {
        let s = part.trim();
        if s.is_empty() {
            continue;
        }
        match s.parse::<HeaderValue>() {
            Ok(h) => origins.push(h),
            Err(e) => tracing::warn!("ALLOW_ORIGIN segment '{}' ignored: {}", s, e),
        }
    }
    origins
}

/// CORS for `/api/ws` (browser `Origin`) and HTTP helpers on the same router.
/// `ALLOW_ORIGIN=*` allows all. Otherwise use a comma-separated list, e.g.
/// `https://canari-emse.fr,http://localhost:1420` so local Vite (`Origin: http://localhost:1420`)
/// is accepted when the chat-gateway runs with a non-wildcard policy.
///
/// THE LIST IS A FACT ABOUT THE CLIENTS, AND EVERY CANARI CLIENT MUST BE IN IT. A Tauri WebView
/// presents one origin per platform and calls this gateway cross-origin (its page is served from
/// `tauri://localhost`, the API from `https://canari-emse.fr`), so omitting a spelling here costs
/// that platform `/api/presence` with no server-side error to show for it - the same failure shape
/// that cost iOS its login through the Nest services' own list (`apps/*/src/cors-origins.ts`,
/// which this must be kept in step with).
fn chat_gateway_cors_layer(allow_origin: &str) -> CorsLayer {
    let common = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    if allow_origin.trim() == "*" {
        return common.allow_origin(Any);
    }

    let origins = parse_allowed_origins(allow_origin);

    if origins.is_empty() {
        panic!(
            "ALLOW_ORIGIN has no valid HTTP origins ('{}'). Set ALLOW_ORIGIN to a comma-separated list of origins or '*' for development.",
            allow_origin
        );
    }

    if origins.len() == 1 {
        common.allow_origin(AllowOrigin::exact(origins[0].clone()))
    } else {
        common.allow_origin(AllowOrigin::list(origins))
    }
}

/// Masks credentials in a Redis URL for logging.
/// `redis://user:password@host:port` -> `redis://host:port`
fn mask_redis_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("redis://")
        && let Some(at_pos) = rest.find('@')
    {
        return format!("redis://{}", &rest[at_pos + 1..]);
    }
    url.to_string()
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "chat_gateway=debug,tower_http=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    tracing::info!("=== Chat Gateway starting ===");

    // Redis connection
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_string());
    tracing::info!("Redis connection: {}", mask_redis_url(&redis_url));
    let redis_client = match redis::Client::open(redis_url.clone()) {
        Ok(c) => {
            tracing::info!("Redis client created");
            c
        }
        Err(e) => {
            tracing::error!("Invalid Redis URL '{}': {}", redis_url, e);
            std::process::exit(1);
        }
    };

    // JWT Secret
    let jwt_secret = match std::env::var("JWT_SECRET") {
        Ok(s) if !s.is_empty() => {
            tracing::info!("JWT_SECRET configured ({} chars)", s.len());
            s
        }
        Ok(_) => {
            tracing::error!("JWT_SECRET is empty");
            std::process::exit(1);
        }
        Err(_) => {
            tracing::error!("JWT_SECRET missing. Generate with: openssl rand -hex 32");
            std::process::exit(1);
        }
    };

    let app_state = Arc::new(AppState::new(redis_client.clone(), jwt_secret));

    // ── Redis pub/sub subscriber ──────────────────────────────────────────
    subscribers::spawn_redis_subscriber(redis_client.clone(), app_state.connected_users.clone());

    // ── Kafka consumer: broadcast `post.created` events to all clients ────
    let kafka_brokers =
        std::env::var("KAFKA_BROKERS").unwrap_or_else(|_| "localhost:9092".to_string());
    subscribers::spawn_kafka_consumer(kafka_brokers, app_state.connected_users.clone());

    // ── CORS configuration ────────────────────────────────────────────────
    // An UNSET variable means someone is running the binary by hand, and the wildcard keeps that
    // working. Every compose file names the variable, so reaching this branch under compose means
    // the policy this service is supposed to enforce silently became "anyone" - it is logged as an
    // accusation, not as a mode.
    let allow_origin = std::env::var("ALLOW_ORIGIN").unwrap_or_else(|_| {
        tracing::warn!(
            "ALLOW_ORIGIN is not set - falling back to '*', which accepts EVERY origin. Under \
             docker compose this variable is always declared, so this line means the declaration \
             was lost."
        );
        "*".to_string()
    });
    tracing::info!("CORS ALLOW_ORIGIN: {}", allow_origin);
    let cors = chat_gateway_cors_layer(&allow_origin);

    let app = Router::new()
        .route("/api/health", get(health_check))
        .route("/api/ws", get(ws_handler))
        .route("/api/presence", get(get_presence))
        .route("/api/admin/presence", get(get_admin_presence))
        .layer(cors)
        .with_state(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    tracing::info!("Listening on {}", addr);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => {
            tracing::info!("=== Chat Gateway started and ready on {} ===", addr);
            l
        }
        Err(e) => {
            tracing::error!("Failed to bind on {}: {}", addr, e);
            std::process::exit(1);
        }
    };

    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!("Erreur serveur axum: {}", e);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, header};
    use tower::ServiceExt;

    /// The exact value CD writes into `infrastructure/.env`. Pinned here so a change to the
    /// deployed list has to change a test that says what each entry is for.
    const PRODUCTION_ALLOW_ORIGIN: &str = "https://canari-emse.fr,https://dev.canari-emse.fr,\
         http://localhost:1420,http://127.0.0.1:1420,http://tauri.localhost,\
         https://tauri.localhost,tauri://localhost";

    /// Minimal router carrying only the CORS layer, so what is asserted is the layer and nothing
    /// downstream of it.
    fn router(allow_origin: &str) -> Router {
        Router::new()
            .route("/api/presence", get(|| async { "ok" }))
            .layer(chat_gateway_cors_layer(allow_origin))
    }

    /// Sends a CORS preflight and returns the `access-control-allow-origin` that came back.
    async fn preflight(allow_origin: &str, origin: &str) -> Option<String> {
        let response = router(allow_origin)
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/api/presence")
                    .header(header::ORIGIN, origin)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .map(|v| v.to_str().unwrap().to_string())
    }

    #[test]
    fn keeps_every_segment_of_the_production_list() {
        let origins = parse_allowed_origins(PRODUCTION_ALLOW_ORIGIN);
        assert_eq!(origins.len(), 7, "one entry lost: {origins:?}");
    }

    #[test]
    fn drops_blank_segments_rather_than_failing_on_a_trailing_comma() {
        let origins = parse_allowed_origins("https://canari-emse.fr, ,tauri://localhost,");
        assert_eq!(origins, ["https://canari-emse.fr", "tauri://localhost"]);
    }

    #[tokio::test]
    async fn answers_every_canari_client_with_its_own_origin() {
        for origin in [
            "https://canari-emse.fr",
            "https://dev.canari-emse.fr",
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "tauri://localhost",
        ] {
            assert_eq!(
                preflight(PRODUCTION_ALLOW_ORIGIN, origin).await.as_deref(),
                Some(origin),
                "{origin} is a Canari client and was refused"
            );
        }
    }

    #[tokio::test]
    async fn sends_no_allow_origin_header_to_an_origin_that_is_not_ours() {
        assert_eq!(
            preflight(PRODUCTION_ALLOW_ORIGIN, "https://evil.example").await,
            None
        );
    }

    #[tokio::test]
    async fn varies_on_origin_so_a_cache_cannot_serve_one_clients_answer_to_another() {
        let response = router(PRODUCTION_ALLOW_ORIGIN)
            .oneshot(
                Request::builder()
                    .uri("/api/presence")
                    .header(header::ORIGIN, "https://canari-emse.fr")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let vary = response
            .headers()
            .get(header::VARY)
            .expect("no Vary: a shared cache would hand one origin's response to the next")
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            vary.to_ascii_lowercase().contains("origin"),
            "vary was {vary}"
        );
    }

    #[tokio::test]
    async fn a_wildcard_accepts_anyone() {
        assert_eq!(
            preflight("*", "https://evil.example").await.as_deref(),
            Some("*")
        );
    }

    #[test]
    #[should_panic(expected = "no valid HTTP origins")]
    fn refuses_to_boot_on_an_empty_list_rather_than_serving_a_policy_nobody_chose() {
        // A SET-BUT-EMPTY variable is not an unset one: `${ALLOW_ORIGIN}` on a missing `.env` key
        // reaches the container as "", which must stop the boot instead of silently allowing all.
        let _ = chat_gateway_cors_layer("");
    }
}
