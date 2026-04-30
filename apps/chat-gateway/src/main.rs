mod handlers;
mod models;
mod state;
mod ws_dispatch;

use axum::{
    Router,
    http::{Method, StatusCode},
    response::IntoResponse,
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures::stream::StreamExt;
use std::{net::SocketAddr, sync::Arc};
use tower_http::cors::{Any, CorsLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::handlers::{get_presence, ws_handler};
use crate::state::AppState;

/// Decode a standard base64 string to a UTF-8 string, returning None on any error.
fn base64_decode_to_string(input: &str) -> Option<String> {
    let bytes = BASE64.decode(input).ok()?;
    String::from_utf8(bytes).ok()
}

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

    // Kafka archival is handled by the delivery service; gateway no longer
    // needs a producer or a direct HTTP channel to the delivery service.

    let app_state = Arc::new(AppState::new(redis_client.clone(), jwt_secret));

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
                        let payload_len = payload_str.len();
                        tracing::debug!(
                            "Received pub/sub message on {} ({} bytes)",
                            channel_name,
                            payload_len
                        );
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&payload_str) {
                            if channel_name == "chat:messages" {
                                let recipient_id = match json
                                    .get("recipientId")
                                    .and_then(|v| v.as_str())
                                {
                                    Some(v) => v.to_string(),
                                    None => {
                                        tracing::warn!(
                                            "[PubSub] chat:messages payload missing recipientId, dropping"
                                        );
                                        continue;
                                    }
                                };
                                let device_id = match json.get("deviceId").and_then(|v| v.as_str())
                                {
                                    Some(v) => v.to_string(),
                                    None => {
                                        tracing::warn!(
                                            "[PubSub] chat:messages payload missing deviceId for recipient {}, dropping",
                                            recipient_id
                                        );
                                        continue;
                                    }
                                };

                                // welcome_request / reinvite_request control frames: proto is
                                // base64(JSON notification). Decode and relay as plain WS text;
                                // do NOT wrap in the MLS envelope.
                                let is_control = json
                                    .get("isWelcomeRequest")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false)
                                    || json
                                        .get("isReinviteRequest")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);
                                let json_frame = if is_control {
                                    let proto_b64 = match json.get("proto").and_then(|v| v.as_str())
                                    {
                                        Some(v) => v,
                                        None => {
                                            tracing::warn!(
                                                "[PubSub] control frame missing proto for {}:{}, dropping",
                                                recipient_id,
                                                device_id
                                            );
                                            continue;
                                        }
                                    };
                                    match base64_decode_to_string(proto_b64) {
                                        Some(s) => s,
                                        None => {
                                            tracing::warn!(
                                                "[PubSub] control frame invalid base64 proto for {}:{}, dropping",
                                                recipient_id,
                                                device_id
                                            );
                                            continue;
                                        }
                                    }
                                } else {
                                    let proto_b64 = match json.get("proto").and_then(|v| v.as_str())
                                    {
                                        Some(v) if !v.is_empty() => v,
                                        _ => {
                                            tracing::warn!(
                                                "Redis message missing 'proto' field, dropping"
                                            );
                                            continue;
                                        }
                                    };

                                    // Forward flat JSON to the WS client — no proto decode needed.
                                    serde_json::json!({
                                    "senderId": json.get("senderId").and_then(|v| v.as_str()).unwrap_or(""),
                                    "senderDeviceId": json.get("senderDeviceId").and_then(|v| v.as_str()).unwrap_or(""),
                                    "groupId": json.get("groupId").and_then(|v| v.as_str()).unwrap_or(""),
                                    "isWelcome": json.get("isWelcome").and_then(|v| v.as_bool()).unwrap_or(false),
                                    "isCommit": json.get("isCommit").and_then(|v| v.as_bool()).unwrap_or(false),
                                    "ratchetTree": json.get("ratchetTree").cloned().unwrap_or(serde_json::Value::Null),
                                    "proto": proto_b64,
                                    "queuedMessageId": json.get("queuedMessageId").and_then(|v| v.as_str()).unwrap_or("")
                                })
                                .to_string()
                                };

                                let key = format!("{}:{}", recipient_id, device_id);
                                let queue_id = json
                                    .get("queuedMessageId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");

                                tracing::info!(
                                    "[PubSub] route kind={} target={} group={} queuedId={}",
                                    if is_control { "control" } else { "mls" },
                                    key,
                                    json.get("groupId").and_then(|v| v.as_str()).unwrap_or(""),
                                    queue_id
                                );

                                tracing::info!("Looking for connected user: {}", key);

                                // Send to ALL active connections for this key (multi-tab support)
                                let senders = {
                                    let map = connected_users.lock().unwrap();
                                    map.get(&key).cloned()
                                };

                                let mut found = false;
                                let mut any_failed = false;
                                if let Some(senders) = senders {
                                    found = true;
                                    for tx in &senders {
                                        if tx.try_send(json_frame.clone()).is_ok() {
                                            tracing::info!(
                                                "[Gateway] Message directly routed to {}, json_frame length: {} bytes, queuedId={}",
                                                key,
                                                json_frame.len(),
                                                queue_id
                                            );
                                        } else {
                                            // The mpsc channel is full or the receiver was dropped
                                            // (device disconnected). The message is already in the
                                            // DB queue and will be fetched via fetchPendingMessages
                                            // on the next reconnect — it is NOT lost.
                                            tracing::warn!(
                                                "[PubSub] Real-time delivery failed for {} (queuedId={}) — message stays in DB queue, will be fetched on reconnect",
                                                key,
                                                queue_id
                                            );
                                            any_failed = true;
                                        }
                                    }
                                }

                                if any_failed {
                                    // Prune only dead senders instead of wiping all connections
                                    // for this key. A multi-tab user would lose live connections
                                    // if we blindly map.remove() on the first failure.
                                    // If no live senders remain the device is confirmed offline:
                                    // immediately DEL the presence key so the delivery service
                                    // stops routing via pub/sub and goes straight to queue.
                                    let all_gone = {
                                        let mut map = connected_users.lock().unwrap();
                                        if let Some(senders) = map.get_mut(&key) {
                                            senders.retain(|s| !s.is_closed());
                                            if senders.is_empty() {
                                                map.remove(&key);
                                                true
                                            } else {
                                                false
                                            }
                                        } else {
                                            true
                                        }
                                    };
                                    if all_gone {
                                        let rc = redis_client.clone();
                                        let rk = format!("user:online:{}", key);
                                        let k2 = key.clone();
                                        tokio::spawn(async move {
                                            match rc.get_multiplexed_async_connection().await {
                                                Ok(mut con) => {
                                                    if let Err(e) = redis::cmd("DEL")
                                                        .arg(&rk)
                                                        .query_async::<()>(&mut con)
                                                        .await
                                                    {
                                                        tracing::warn!(
                                                            "[presence] DEL failed after delivery failure for {}: {}",
                                                            k2,
                                                            e
                                                        );
                                                    } else {
                                                        tracing::info!(
                                                            "[presence] Removed stale presence key for {} after delivery failure",
                                                            k2
                                                        );
                                                    }
                                                }
                                                Err(e) => tracing::warn!(
                                                    "[presence] Redis unavailable for DEL after delivery failure for {}: {}",
                                                    k2,
                                                    e
                                                ),
                                            }
                                        });
                                    }
                                } else if !found {
                                    tracing::info!(
                                        "[PubSub] {} not connected to this gateway — message stays in DB queue, will be fetched on reconnect (queuedId={}).",
                                        key,
                                        queue_id
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
                                let senders_to_notify: Vec<(String, _)> = {
                                    let map = connected_users.lock().unwrap();
                                    let mut temp = Vec::new();
                                    for u_id in user_ids {
                                        let prefix = format!("{}:", u_id);
                                        for (key, senders) in map.iter() {
                                            if key.starts_with(&prefix) {
                                                for tx in senders {
                                                    temp.push((key.clone(), tx.clone()));
                                                }
                                            }
                                        }
                                    }
                                    temp
                                };

                                let targets_count = senders_to_notify.len();
                                let mut to_remove = Vec::new();
                                for (key, tx) in senders_to_notify {
                                    if let Err(e) = tx.try_send(frame.clone()) {
                                        tracing::warn!(
                                            "Backpressure: dropping channel event for slow client {}: {}",
                                            key,
                                            e
                                        );
                                        to_remove.push(key);
                                    }
                                }

                                if !to_remove.is_empty() {
                                    let mut map = connected_users.lock().unwrap();
                                    for key in to_remove {
                                        map.remove(&key);
                                    }
                                }

                                tracing::info!(
                                    "[Gateway] Channel event distributed to connected users (targets={}).",
                                    targets_count
                                );
                            }
                        } else {
                            tracing::warn!(
                                "[PubSub] Invalid JSON payload on {} ({} bytes), dropping",
                                channel_name,
                                payload_len
                            );
                        }
                    } else {
                        tracing::warn!("[PubSub] Non-string payload on {}, dropping", channel_name);
                    }
                }
                // Stream ended (Redis déconnecté), on réessaie
                tracing::warn!("Stream Redis pub/sub terminé, reconnexion dans 5s...");
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            }
        });
    }

    // Spawn Kafka Consumer Task (Post Broadcast)
    {
        let kafka_brokers =
            std::env::var("KAFKA_BROKERS").unwrap_or_else(|_| "localhost:9092".to_string());
        let connected_users = app_state.connected_users.clone();

        tokio::spawn(async move {
            use rdkafka::ClientConfig;
            use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
            use rdkafka::message::Message;

            tracing::info!("Kafka Consumer connecting to {}", kafka_brokers);

            let consumer: StreamConsumer = ClientConfig::new()
                .set("group.id", "chat-gateway-broadcast")
                .set("bootstrap.servers", &kafka_brokers)
                .set("enable.partition.eof", "false")
                .set("session.timeout.ms", "6000")
                .set("enable.auto.commit", "true")
                .create()
                .expect("Consumer creation failed");

            consumer
                .subscribe(&["post.created"])
                .expect("Can't subscribe to specified topic");

            tracing::info!("Abonné au topic Kafka 'post.created'");

            loop {
                match consumer.recv().await {
                    Err(e) => tracing::warn!("Kafka error: {}", e),
                    Ok(m) => {
                        let payload = match m.payload_view::<str>() {
                            None => "",
                            Some(Ok(s)) => s,
                            Some(Err(e)) => {
                                tracing::warn!(
                                    "Error while deserializing message payload: {:?}",
                                    e
                                );
                                ""
                            }
                        };

                        tracing::info!("Received post.created broadcast: {}", payload);

                        // Broadcast to ALL users
                        let frame = serde_json::json!({
                            "type": "post_created",
                            "data": serde_json::from_str::<serde_json::Value>(payload).unwrap_or(serde_json::json!(null))
                        }).to_string();

                        let senders_to_notify: Vec<(String, _)> = {
                            let map = connected_users.lock().unwrap();
                            let mut temp = Vec::new();
                            for (key, senders) in map.iter() {
                                for tx in senders {
                                    temp.push((key.clone(), tx.clone()));
                                }
                            }
                            temp
                        };

                        let mut count = 0;
                        let mut to_remove = Vec::new();
                        for (key, tx) in senders_to_notify {
                            if let Err(e) = tx.try_send(frame.clone()) {
                                tracing::warn!(
                                    "Backpressure: dropping broadcast frame for slow client {}: {}",
                                    key,
                                    e
                                );
                                to_remove.push(key);
                            } else {
                                count += 1;
                            }
                        }

                        if !to_remove.is_empty() {
                            let mut map = connected_users.lock().unwrap();
                            for key in to_remove {
                                map.remove(&key);
                            }
                        }
                        tracing::info!("Broadcasted post to {} connections", count);

                        if let Err(e) = consumer.commit_message(&m, CommitMode::Async) {
                            tracing::warn!("Failed to commit offset: {}", e);
                        }
                    }
                }
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
        .route("/api/presence", get(get_presence))
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
