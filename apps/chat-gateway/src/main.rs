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

/// CORS for `/api/ws` (browser `Origin`) and HTTP helpers on the same router.
/// `ALLOW_ORIGIN=*` allows all. Otherwise use a comma-separated list, e.g.
/// `https://canari-emse.fr,http://localhost:1420` so local Vite (`Origin: http://localhost:1420`)
/// is accepted when the chat-gateway runs with a non-wildcard policy.
fn chat_gateway_cors_layer(allow_origin: &str) -> CorsLayer {
    let common = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    if allow_origin.trim() == "*" {
        return common.allow_origin(Any);
    }

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

/// Masque les credentials dans une URL Redis pour les logs.
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
    let allow_origin = std::env::var("ALLOW_ORIGIN").unwrap_or_else(|_| "*".to_string());
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
