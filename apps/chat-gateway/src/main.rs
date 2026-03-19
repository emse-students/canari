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

    tracing::info!("=== Chat Gateway démarrage ===");

    // Redis connection
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_string());
    tracing::info!("Connexion Redis: {}", redis_url);
    let redis_client = match redis::Client::open(redis_url.clone()) {
        Ok(c) => {
            tracing::info!("Client Redis créé");
            c
        }
        Err(e) => {
            tracing::error!("URL Redis invalide '{}': {}", redis_url, e);
            std::process::exit(1);
        }
    };

    // JWT Secret
    let jwt_secret = match std::env::var("JWT_SECRET") {
        Ok(s) if !s.is_empty() => {
            tracing::info!("JWT_SECRET configuré ({} chars)", s.len());
            s
        }
        Ok(_) => {
            tracing::error!("JWT_SECRET est vide");
            std::process::exit(1);
        }
        Err(_) => {
            tracing::error!("JWT_SECRET manquant. Générer avec: openssl rand -hex 32");
            std::process::exit(1);
        }
    };

    // Kafka Producer
    let kafka_brokers =
        std::env::var("KAFKA_BROKERS").unwrap_or_else(|_| "localhost:9092".to_string());
    tracing::info!("Connexion Kafka: {}", kafka_brokers);
    let kafka_producer: FutureProducer = match ClientConfig::new()
        .set("bootstrap.servers", &kafka_brokers)
        .set("message.timeout.ms", "5000")
        .create()
    {
        Ok(p) => {
            tracing::info!("Producteur Kafka créé");
            p
        }
        Err(e) => {
            tracing::error!("Erreur création producteur Kafka: {}", e);
            std::process::exit(1);
        }
    };

    let http_client = HttpClient::new();
    let delivery_service_url = std::env::var("DELIVERY_SERVICE_URL")
        .unwrap_or_else(|_| "http://localhost:3001".to_string());
    tracing::info!("Delivery service URL: {}", delivery_service_url);

    let app_state = Arc::new(AppState::new(
        redis_client.clone(),
        kafka_producer,
        jwt_secret,
        http_client,
        delivery_service_url,
    ));

    // Spawn Redis Subscriber Task (Direct Routing) — avec retry en cas d'échec
    {
        let redis_client = redis_client.clone();
        let connected_users = app_state.connected_users.clone();
        tokio::spawn(async move {
            loop {
                tracing::info!("Tentative de connexion au pub/sub Redis...");
                let pubsub_result = redis_client.get_async_pubsub().await;
                let mut pubsub = match pubsub_result {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!("Echec connexion pub/sub Redis: {}. Retry dans 5s...", e);
                        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                        continue;
                    }
                };

                match pubsub.subscribe("chat:messages").await {
                    Ok(_) => tracing::info!("Abonné au canal Redis 'chat:messages'"),
                    Err(e) => {
                        tracing::warn!("Echec abonnement Redis: {}. Retry dans 5s...", e);
                        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                        continue;
                    }
                }

                match pubsub.subscribe("chat:channel_events").await {
                    Ok(_) => tracing::info!("Abonné au canal Redis 'chat:channel_events'"),
                    Err(e) => {
                        tracing::warn!(
                            "Echec abonnement Redis channel_events: {}. Retry dans 5s...",
                            e
                        );
                        tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                        continue;
                    }
                }

                // Listen for direct messages from Backend or other Gateways
                let mut stream = pubsub.on_message();
                while let Some(msg) = stream.next().await {
                    let channel_name = msg.get_channel_name();
                    if let Ok(payload_str) = msg.get_payload::<String>() {
                        tracing::debug!(
                            "Received pub/sub message on {}: {}",
                            channel_name,
                            payload_str
                        );
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&payload_str) {
                            if channel_name == "chat:messages" {
                                let recipient_id =
                                    match json.get("recipientId").and_then(|v| v.as_str()) {
                                        Some(v) => v.to_string(),
                                        None => continue,
                                    };
                                let device_id = match json.get("deviceId").and_then(|v| v.as_str())
                                {
                                    Some(v) => v.to_string(),
                                    None => continue,
                                };

                                let proto_b64 = match json.get("proto").and_then(|v| v.as_str()) {
                                    Some(v) if !v.is_empty() => v,
                                    _ => {
                                        tracing::warn!(
                                            "Redis message missing 'proto' field, dropping"
                                        );
                                        continue;
                                    }
                                };

                                // Forward flat JSON to the WS client — no proto decode needed.
                                let json_frame = serde_json::json!({
                                    "senderId": json.get("senderId").and_then(|v| v.as_str()).unwrap_or(""),
                                    "senderDeviceId": json.get("senderDeviceId").and_then(|v| v.as_str()).unwrap_or(""),
                                    "groupId": json.get("groupId").and_then(|v| v.as_str()).unwrap_or(""),
                                    "isWelcome": json.get("isWelcome").and_then(|v| v.as_bool()).unwrap_or(false),
                                    "ratchetTree": json.get("ratchetTree").cloned().unwrap_or(serde_json::Value::Null),
                                    "proto": proto_b64
                                })
                                .to_string();

                                let key = format!("{}:{}", recipient_id, device_id);

                                tracing::info!("Looking for connected user: {}", key);

                                // Send to ALL active connections for this key (multi-tab support)
                                let senders = {
                                    let map = connected_users.lock().unwrap();
                                    map.get(&key).cloned()
                                };

                                if let Some(senders) = senders {
                                    for tx in &senders {
                                        if tx.send(json_frame.clone()).is_ok() {
                                            tracing::info!(
                                                "[Gateway] Message directly routed to {}, json_frame length: {} bytes",
                                                key,
                                                json_frame.len()
                                            );
                                        } else {
                                            tracing::warn!(
                                                "Failed to send to socket for {} (channel closed)",
                                                key
                                            );
                                        }
                                    }
                                } else {
                                    tracing::warn!(
                                        "User {} not connected to this gateway instance.",
                                        key
                                    );
                                }
                            } else if channel_name == "chat:channel_events" {
                                // Expected payload format:
                                // { "userIds": ["user1", "user2"], "type": "channel_event", "data": { ... } }
                                let user_ids = match json.get("userIds").and_then(|v| v.as_array())
                                {
                                    Some(arr) => {
                                        arr.iter().filter_map(|v| v.as_str()).collect::<Vec<&str>>()
                                    }
                                    None => continue,
                                };

                                let frame = serde_json::json!({
                                    "type": json.get("type").unwrap_or(&serde_json::Value::Null),
                                    "data": json.get("data").unwrap_or(&serde_json::Value::Null)
                                })
                                .to_string();

                                // Find all map keys that start with the user ID
                                let map = connected_users.lock().unwrap();
                                for u_id in user_ids {
                                    // Iterate all keys to find matches prefix (u_id + ":")
                                    let prefix = format!("{}:", u_id);
                                    for (key, senders) in map.iter() {
                                        if key.starts_with(&prefix) {
                                            for tx in senders {
                                                let _ = tx.send(frame.clone());
                                            }
                                        }
                                    }
                                }
                                tracing::info!(
                                    "[Gateway] Channel event distributed to connected users."
                                );
                            }
                        }
                    }
                }
                // Stream ended (Redis déconnecté), on réessaie
                tracing::warn!("Stream Redis pub/sub terminé, reconnexion dans 5s...");
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        });
    }

    let allow_origin = std::env::var("ALLOW_ORIGIN").unwrap_or_else(|_| "*".to_string());
    tracing::info!("CORS ALLOW_ORIGIN: {}", allow_origin);
    let cors = if allow_origin == "*" {
        CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(Any)
    } else {
        match allow_origin.parse::<axum::http::HeaderValue>() {
            Ok(origin) => CorsLayer::new()
                .allow_origin(origin)
                .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                .allow_headers(Any),
            Err(e) => {
                tracing::error!(
                    "ALLOW_ORIGIN invalide '{}': {}. Utilisation de '*' en fallback.",
                    allow_origin,
                    e
                );
                CorsLayer::new()
                    .allow_origin(Any)
                    .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
                    .allow_headers(Any)
            }
        }
    };

    let app = Router::new()
        .route("/api/health", get(health_check))
        .route("/api/ws", get(ws_handler))
        // MLS Specific Routes
        .route(
            "/api/groups/{group_id}/tree",
            get(get_ratchet_tree).post(post_ratchet_tree),
        )
        .layer(cors)
        .with_state(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    tracing::info!("Écoute sur {}", addr);
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => {
            tracing::info!("=== Chat Gateway démarré et prêt sur {} ===", addr);
            l
        }
        Err(e) => {
            tracing::error!("Impossible de bind sur {}: {}", addr, e);
            std::process::exit(1);
        }
    };

    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!("Erreur serveur axum: {}", e);
        std::process::exit(1);
    }
}
