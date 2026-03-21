use axum::{
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use chrono::Utc;
use futures::{sink::SinkExt, stream::StreamExt};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use rdkafka::producer::FutureRecord;
use redis::AsyncCommands;
use shared_rust::{MessageSentEvent, TOPIC_CHAT_MESSAGES};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::models::{AuthParams, Claims, RatchetTreePayload, Recipient};
use crate::state::AppState;

// --- REST Handlers for MLS ---

pub async fn get_ratchet_tree(
    Path(group_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let mut con = match state.redis_client.get_multiplexed_async_connection().await {
        Ok(con) => con,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Redis error").into_response(),
    };

    let key = format!("group:{}:tree", group_id);
    let result: Result<String, _> = con.get(key).await;

    match result {
        Ok(tree) => (StatusCode::OK, tree).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Tree not found").into_response(),
    }
}

pub async fn post_ratchet_tree(
    Path(group_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RatchetTreePayload>,
) -> impl IntoResponse {
    let mut con = match state.redis_client.get_multiplexed_async_connection().await {
        Ok(con) => con,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Redis error").into_response(),
    };

    let key = format!("group:{}:tree", group_id);
    let _: Result<(), _> = con.set(key, payload.data).await;
    StatusCode::OK.into_response()
}

// --- WebSocket Handler ---

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<AuthParams>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let validation = Validation::new(Algorithm::HS256);
    let key = DecodingKey::from_secret(state.jwt_secret.as_bytes());

    match decode::<Claims>(&params.token, &key, &validation) {
        Ok(token_data) => {
            let device_id = params.device_id.unwrap_or_else(|| "unknown".to_string());
            ws.on_upgrade(move |socket| {
                handle_socket(socket, state, token_data.claims.sub, device_id)
            })
        }
        Err(_) => (StatusCode::UNAUTHORIZED, "Invalid parameters").into_response(),
    }
}

#[allow(clippy::collapsible_if)]
async fn handle_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    user_id: String,
    device_id: String,
) {
    tracing::info!(
        "New WebSocket connection: User={}, Device={}",
        user_id,
        device_id
    );

    let (mut sender, mut receiver) = socket.split();

    // Create channel for this specific client
    let (tx, mut rx) = mpsc::unbounded_channel();
    let conn_key = format!("{}:{}", user_id, device_id);

    // Register connection — push into the list for this key (supports multiple tabs)
    {
        let mut map = state.connected_users.lock().unwrap();
        map.entry(conn_key.clone()).or_default().push(tx);
        tracing::info!(
            "Registered connection key: {} ({} active)",
            conn_key,
            map[&conn_key].len()
        );
    }

    // Register presence in Redis
    let redis_key = format!("user:online:{}", conn_key);
    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
        let _: Result<(), _> = con.set_ex(&redis_key, "true", 3600).await;

        // Connect to Pending Welcomes (Legacy/Upstream compatibility)
        let welcome_key = format!("pending_welcomes:{}", user_id);
        let pending: Result<Vec<String>, _> = redis::cmd("LRANGE")
            .arg(&welcome_key)
            .arg(0)
            .arg(-1)
            .query_async(&mut con)
            .await;

        if let Ok(msgs) = pending {
            for msg in msgs {
                // Legacy pending_welcomes entries are JSON strings.
                // Build a JSON delivery frame directly.
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&msg) {
                    let b64_payload = parsed["content"]
                        .as_str()
                        .or_else(|| parsed["payload"].as_str())
                        .unwrap_or_default();
                    let sender_id = parsed["senderId"]
                        .as_str()
                        .or_else(|| parsed["sender_id"].as_str())
                        .unwrap_or_default()
                        .to_string();
                    let group_id = parsed["groupId"]
                        .as_str()
                        .or_else(|| parsed["group_id"].as_str())
                        .unwrap_or_default()
                        .to_string();
                    let json_msg = serde_json::json!({
                        "senderId": sender_id,
                        "senderDeviceId": "",
                        "groupId": group_id,
                        "isWelcome": true,
                        "proto": b64_payload
                    })
                    .to_string();
                    if sender.send(Message::Text(json_msg.into())).await.is_err() {
                        break;
                    }
                }
            }
            let _: Result<(), _> = redis::cmd("DEL")
                .arg(&welcome_key)
                .query_async(&mut con)
                .await;
        }
    }

    // Task to receive all messages from Redis/Backend and send to this client
    let conn_key_ping = conn_key.clone();
    let mut send_task = tokio::spawn(async move {
        let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));

        loop {
            tokio::select! {
              msg_opt = rx.recv() => {
                if let Some(msg) = msg_opt {
                    // msg is a JSON string: { senderId, senderDeviceId, groupId, isWelcome, proto: base64(ciphertext) }
                    if sender.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                } else {
                    break; // Channel closed
                }
              }
              _ = ping_interval.tick() => {
                tracing::debug!("Sending ping to {} to keep connection alive", conn_key_ping);
                if sender.send(Message::Ping(vec![].into())).await.is_err() {
                    break;
                }
              }
            }
        }
    });

    // Task to receive messages fro this client
    let mut recv_task = {
        let state = state.clone();
        let user_id = user_id.clone();
        let device_id = device_id.clone();

        tokio::spawn(async move {
            while let Some(msg) = receiver.next().await {
                // Refresh presence on ANY activity
                let redis_key = format!("user:online:{}:{}", user_id, device_id);
                if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
                    let _: Result<(), _> = con.set_ex(&redis_key, "true", 3600).await;
                }

                match msg {
                    Ok(Message::Text(text)) => {
                        tracing::info!(
                            "Received WS JSON frame from {} ({} bytes)",
                            user_id,
                            text.len()
                        );
                        let json = match serde_json::from_str::<serde_json::Value>(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::error!("JSON parse error from {}: {}", user_id, e);
                                continue;
                            }
                        };

                        let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        let proto_b64 = json
                            .get("proto")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default();
                        let ciphertext = match B64.decode(proto_b64) {
                            Ok(b) => b,
                            Err(e) => {
                                tracing::error!("Base64 decode error from {}: {}", user_id, e);
                                continue;
                            }
                        };
                        let group_id = json
                            .get("groupId")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        let recipients: Vec<Recipient> = json
                            .get("recipients")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|r| {
                                        Some(Recipient {
                                            user_id: r.get("userId")?.as_str()?.to_string(),
                                            device_id: r
                                                .get("deviceId")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or_default()
                                                .to_string(),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();

                        match msg_type {
                            "mls" => {
                                tracing::info!(
                                    "Processing MLS frame. GroupID: {:?}, recipients: {}",
                                    group_id,
                                    recipients.len()
                                );

                                // Archive to Kafka (base64-encode for JSON compatibility)
                                let payload_b64 = B64.encode(&ciphertext);
                                if let Ok(serialized) = serde_json::to_string(&MessageSentEvent {
                                    id: Uuid::new_v4(),
                                    sender_id: user_id.clone(),
                                    username: "Anonymous".to_string(),
                                    content: payload_b64.clone(),
                                    timestamp: Utc::now(),
                                    conversation_id: Some(group_id.clone())
                                        .filter(|s| !s.is_empty()),
                                }) {
                                    let record = FutureRecord::to(TOPIC_CHAT_MESSAGES)
                                        .payload(&serialized)
                                        .key(&user_id);
                                    let _ = state
                                        .kafka_producer
                                        .send(record, std::time::Duration::from_secs(0))
                                        .await;

                                    // Archive to Redis Stream (base64 for history service compat)
                                    if !group_id.is_empty() {
                                        if let Ok(mut con) = state
                                            .redis_client
                                            .get_multiplexed_async_connection()
                                            .await
                                        {
                                            let stream_key = format!("history:{}", group_id);
                                            let _: Result<String, _> = redis::cmd("XADD")
                                                .arg(&stream_key)
                                                .arg("*")
                                                .arg("sender_id")
                                                .arg(user_id.clone())
                                                .arg("content")
                                                .arg(payload_b64)
                                                .arg("timestamp")
                                                .arg(Utc::now().to_rfc3339())
                                                .query_async(&mut con)
                                                .await;
                                        }
                                    }
                                }

                                // Route to recipients
                                let mut target_recipients: Vec<Recipient> = recipients;

                                if target_recipients.is_empty() && !group_id.is_empty() {
                                    if let Ok(mut con) =
                                        state.redis_client.get_multiplexed_async_connection().await
                                    {
                                        let key = format!("group:members:{}", group_id);
                                        if let Ok(members) =
                                            con.smembers::<_, Vec<String>>(&key).await
                                        {
                                            for m in members {
                                                let parts: Vec<&str> = m.split(':').collect();
                                                if parts.len() == 2 {
                                                    target_recipients.push(Recipient {
                                                        user_id: parts[0].to_string(),
                                                        device_id: parts[1].to_string(),
                                                    });
                                                }
                                            }
                                        }
                                    }
                                }

                                tracing::info!("Target recipients: {}", target_recipients.len());

                                if !target_recipients.is_empty() {
                                    let mut offline_list: Vec<Recipient> = Vec::new();

                                    for recipient in target_recipients {
                                        if recipient.device_id.is_empty() {
                                            offline_list.push(recipient);
                                            continue;
                                        }

                                        let target_key = format!(
                                            "{}:{}",
                                            recipient.user_id, recipient.device_id
                                        );
                                        let redis_presence_key =
                                            format!("user:online:{}", target_key);
                                        let mut is_online = false;

                                        if let Ok(mut con) = state
                                            .redis_client
                                            .get_multiplexed_async_connection()
                                            .await
                                        {
                                            if let Ok(true) =
                                                con.exists::<_, bool>(&redis_presence_key).await
                                            {
                                                is_online = true;
                                                let routing = serde_json::json!({
                                                    "recipientId": recipient.user_id,
                                                    "deviceId": recipient.device_id,
                                                    "senderId": user_id,
                                                    "senderDeviceId": device_id,
                                                    "groupId": group_id,
                                                    "isWelcome": false,
                                                    "proto": B64.encode(&ciphertext)
                                                })
                                                .to_string();
                                                let _: Result<(), _> =
                                                    con.publish("chat:messages", &routing).await;
                                            }
                                        }

                                        if !is_online {
                                            offline_list.push(recipient);
                                        }
                                    }

                                    if !offline_list.is_empty() {
                                        let body = serde_json::json!({
                                            "recipients": offline_list
                                                .iter()
                                                .map(|r| serde_json::json!({
                                                    "userId": r.user_id,
                                                    "deviceId": if r.device_id.is_empty() { serde_json::Value::Null } else { r.device_id.clone().into() }
                                                }))
                                                .collect::<Vec<_>>(),
                                            "senderId": user_id,
                                            "senderDeviceId": device_id,
                                            "groupId": group_id,
                                            "isWelcome": false,
                                            "proto": B64.encode(&ciphertext)
                                        });
                                        if let Err(e) = state
                                            .http_client
                                            .post(format!(
                                                "{}/mls-api/send",
                                                state.delivery_service_url
                                            ))
                                            .json(&body)
                                            .send()
                                            .await
                                        {
                                            tracing::error!("Offline delivery failed: {}", e);
                                        }
                                    }
                                }
                            }

                            "welcome" => {
                                tracing::info!("Processing Welcome frame for group {}", group_id);

                                for recipient in recipients {
                                    if recipient.device_id.is_empty() {
                                        // Fan-out via delivery service
                                        let body = serde_json::json!({
                                            "recipients": [{ "userId": recipient.user_id, "deviceId": serde_json::Value::Null }],
                                            "senderId": user_id,
                                            "senderDeviceId": device_id,
                                            "groupId": group_id,
                                            "isWelcome": true,
                                            "proto": B64.encode(&ciphertext)
                                        });
                                        let _ = state
                                            .http_client
                                            .post(format!(
                                                "{}/mls-api/send",
                                                state.delivery_service_url
                                            ))
                                            .json(&body)
                                            .send()
                                            .await;
                                        continue;
                                    }

                                    let target_key =
                                        format!("{}:{}", recipient.user_id, recipient.device_id);
                                    let redis_presence_key = format!("user:online:{}", target_key);
                                    let mut sent = false;

                                    if let Ok(mut con) =
                                        state.redis_client.get_multiplexed_async_connection().await
                                    {
                                        if let Ok(true) =
                                            con.exists::<_, bool>(&redis_presence_key).await
                                        {
                                            let routing = serde_json::json!({
                                                "recipientId": recipient.user_id,
                                                "deviceId": recipient.device_id,
                                                "senderId": user_id,
                                                "senderDeviceId": device_id,
                                                "groupId": group_id,
                                                "isWelcome": true,
                                                "proto": B64.encode(&ciphertext)
                                            })
                                            .to_string();
                                            let _: Result<(), _> =
                                                con.publish("chat:messages", &routing).await;
                                            sent = true;
                                        }
                                    }

                                    if !sent {
                                        let body = serde_json::json!({
                                            "recipients": [{ "userId": recipient.user_id, "deviceId": recipient.device_id }],
                                            "senderId": user_id,
                                            "senderDeviceId": device_id,
                                            "groupId": group_id,
                                            "isWelcome": true,
                                            "proto": B64.encode(&ciphertext)
                                        });
                                        let _ = state
                                            .http_client
                                            .post(format!(
                                                "{}/mls-api/send",
                                                state.delivery_service_url
                                            ))
                                            .json(&body)
                                            .send()
                                            .await;
                                    }
                                }
                            }

                            "read" => {
                                let message_id = json
                                    .get("messageId")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                tracing::info!("Read receipt for message {}", message_id);
                            }

                            _ => {
                                tracing::warn!(
                                    "Unknown message type '{}' from {}",
                                    msg_type,
                                    user_id
                                );
                            }
                        }
                    }
                    Ok(Message::Close(c)) => {
                        tracing::info!("Client closed connection: {:?}", c);
                        break;
                    }
                    Err(e) => {
                        tracing::error!("WebSocket Error from {}: {}", user_id, e);
                        break;
                    }
                    _ => {} // Non-text frames (binary, ping/pong) ignored
                }
            }
        })
    };

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };

    // Cleanup — remove only dead senders for this key
    {
        let mut map = state.connected_users.lock().unwrap();
        if let Some(senders) = map.get_mut(&conn_key) {
            senders.retain(|s| !s.is_closed());
            if senders.is_empty() {
                map.remove(&conn_key);
            }
        }
    }
    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
        let _: Result<(), _> = con.del(&redis_key).await;
    }
}
#[derive(serde::Deserialize)]
pub struct PresenceQuery {
    pub users: String,
}

pub async fn get_presence(
    Query(query): Query<PresenceQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    use std::collections::HashMap;
    let mut presence = HashMap::new();
    let users_list: Vec<&str> = query.users.split(',').collect();

    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
        for user in users_list {
            if user.trim().is_empty() {
                continue;
            }
            let pattern = format!("user:online:{}:*", user);
            if let Ok(keys) = redis::cmd("KEYS")
                .arg(&pattern)
                .query_async::<Vec<String>>(&mut con)
                .await
            {
                presence.insert(user.to_string(), !keys.is_empty());
            } else {
                presence.insert(user.to_string(), false);
            }
        }
    }

    (StatusCode::OK, Json(presence)).into_response()
}
