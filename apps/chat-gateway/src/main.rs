mod handlers;
mod models;
mod state;

use axum::{
    Router,
    http::{Method, StatusCode},
    response::IntoResponse,
    routing::get,
};
use futures::stream::StreamExt;
use rdkafka::{ClientConfig, producer::FutureProducer};
use reqwest::Client as HttpClient;
use std::{net::SocketAddr, sync::Arc};
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::handlers::{get_ratchet_tree, post_ratchet_tree, ws_handler};
use crate::state::AppState;

async fn health_check() -> impl IntoResponse {
    (StatusCode::OK, "OK")
}

#[tokio::main] // use tokio to run the async main function
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "chat_gateway=debug,tower_http=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Redis connection
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_string());
    let redis_client = redis::Client::open(redis_url).expect("Invalid Redis URL");

    // JWT Secret
    let jwt_secret = std::env::var("JWT_SECRET")
        .expect("JWT_SECRET environment variable is required. Generate with: openssl rand -hex 32");

    // Kafka Producer
    let kafka_brokers =
        std::env::var("KAFKA_BROKERS").unwrap_or_else(|_| "localhost:9092".to_string());
    let kafka_producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", &kafka_brokers)
        .set("message.timeout.ms", "5000")
        .create()
        .expect("Producer creation error");

    let http_client = HttpClient::new();
    let delivery_service_url = std::env::var("DELIVERY_SERVICE_URL")
        .unwrap_or_else(|_| "http://localhost:3001".to_string());

    let app_state = Arc::new(AppState::new(
        redis_client.clone(),
        kafka_producer,
        jwt_secret,
        http_client,
        delivery_service_url,
    ));

    // Spawn Redis Subscriber Task (Direct Routing)
    {
        let redis_client = redis_client.clone();
        let connected_users = app_state.connected_users.clone();
        tokio::spawn(async move {
            let mut pubsub = redis_client
                .get_async_pubsub()
                .await
                .expect("Redis connect failed");
            // Listen for direct messages from Backend or other Gateways
            pubsub
                .subscribe("chat:messages")
                .await
                .expect("Redis subscribe failed");
            let mut stream = pubsub.on_message();

            while let Some(msg) = stream.next().await {
                if let Ok(payload_str) = msg.get_payload::<String>() {
                    // Expect format: { recipientId, deviceId, content, ... }
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&payload_str) {
                        // Extract routing info
                        if let (Some(recipient_id), Some(device_id)) = (
                            json.get("recipientId").and_then(|v| v.as_str()),
                            json.get("deviceId").and_then(|v| v.as_str()),
                        ) {
                            let key = format!("{}:{}", recipient_id, device_id);

                            // Send to ALL active connections for this key (multi-tab support)
                            let senders = {
                                let map = connected_users.lock().unwrap();
                                map.get(&key).cloned()
                            };

                            if let Some(senders) = senders {
                                for tx in &senders {
                                    let _ = tx.send(payload_str.clone());
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    let allow_origin = std::env::var("ALLOW_ORIGIN").unwrap_or_else(|_| "*".to_string());
    let cors = if allow_origin == "*" {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(Any)
    } else {
        let origin = allow_origin
            .parse::<axum::http::HeaderValue>()
            .expect("Invalid ALLOW_ORIGIN");
        CorsLayer::new()
            .allow_origin(origin)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(Any)
    };

    let app = Router::new()
        .route("/health", get(health_check))
        .route("/ws", get(ws_handler))
        // MLS Specific Routes
        .route(
            "/groups/{group_id}/tree",
            get(get_ratchet_tree).post(post_ratchet_tree),
        )
        .layer(cors)
        .with_state(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    tracing::info!("listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
