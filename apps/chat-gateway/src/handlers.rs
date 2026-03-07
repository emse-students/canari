use axum::{
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use chrono::Utc;
use futures::{sink::SinkExt, stream::StreamExt};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use rdkafka::producer::FutureRecord;
use redis::AsyncCommands;
use shared_rust::{MessageSentEvent, TOPIC_CHAT_MESSAGES};
use std::sync::Arc;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::models::{
    AuthParams, Claims, RatchetTreePayload, Recipient, WebSocketMessage, process_incoming,
};
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
                if sender.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            let _: Result<(), _> = redis::cmd("DEL")
                .arg(&welcome_key)
                .query_async(&mut con)
                .await;
        }
    }

    // Task to receive all messages from Redis/Backend and send to this client
    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
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
                        tracing::info!("Received WS message from {}: {}", user_id, text);
                        let incoming = process_incoming(&text);

                        match incoming {
                            Ok(WebSocketMessage::MlsMessage {
                                payload,
                                group_id,
                                recipients,
                            }) => {
                                tracing::info!(
                                    "Processing MLS Message. GroupID: {:?}, Explicit Recipients: {:?}",
                                    group_id,
                                    recipients
                                );

                                // 1. Log generic event to Kafka (for history/audit)
                                // ...

                                if let Ok(serialized) = serde_json::to_string(&MessageSentEvent {
                                    id: Uuid::new_v4(),
                                    sender_id: user_id.clone(),
                                    username: "Anonymous".to_string(),
                                    content: payload.clone(),
                                    timestamp: Utc::now(),
                                    conversation_id: group_id.clone(),
                                }) {
                                    let record = FutureRecord::to(TOPIC_CHAT_MESSAGES)
                                        .payload(&serialized)
                                        .key(&user_id);
                                    let _ = state
                                        .kafka_producer
                                        .send(record, std::time::Duration::from_secs(0))
                                        .await;

                                    // 1b. Add to Redis Stream History (Upstream Feature)
                                    if let Some(ref gid) = group_id {
                                        if let Ok(mut con) = state
                                            .redis_client
                                            .get_multiplexed_async_connection()
                                            .await
                                        {
                                            let stream_key = format!("history:{}", gid);
                                            let _: Result<String, _> = redis::cmd("XADD")
                                                .arg(&stream_key)
                                                .arg("*")
                                                .arg("sender_id")
                                                .arg(user_id.clone())
                                                .arg("content")
                                                .arg(payload.clone())
                                                .arg("timestamp")
                                                .arg(Utc::now().to_rfc3339())
                                                .query_async(&mut con)
                                                .await;
                                        }
                                    }
                                }

                                // 2. Route Message (Online vs Offline)
                                let mut target_recipients: Vec<Recipient> =
                                    recipients.clone().unwrap_or_default();

                                // If explicit recipients missing, fetch from Group Members (Redis)
                                if target_recipients.is_empty() {
                                    if let Some(gid) = &group_id {
                                        if let Ok(mut con) = state
                                            .redis_client
                                            .get_multiplexed_async_connection()
                                            .await
                                        {
                                            let key = format!("group:members:{}", gid);
                                            // Get members from Redis Set
                                            if let Ok(members) =
                                                con.smembers::<_, Vec<String>>(&key).await
                                            {
                                                tracing::info!(
                                                    "Found {} members in Group {:?}",
                                                    members.len(),
                                                    gid
                                                );
                                                for m in members {
                                                    let parts: Vec<&str> = m.split(':').collect();
                                                    if parts.len() == 2 {
                                                        let r_uid = parts[0].to_string();
                                                        let r_did = parts[1].to_string();

                                                        target_recipients.push(Recipient {
                                                            user_id: r_uid,
                                                            device_id: Some(r_did),
                                                        });
                                                    }
                                                }
                                            } else {
                                                tracing::warn!(
                                                    "Failed to fetch members for Group {:?}",
                                                    gid
                                                );
                                            }
                                        }
                                    }
                                }

                                tracing::info!(
                                    "Target Recipients count: {}",
                                    target_recipients.len()
                                );

                                if !target_recipients.is_empty() {
                                    let mut offline_list = Vec::new();

                                    for recipient in target_recipients {
                                        let mut device_ids = Vec::new();

                                        // If device_id is provided, target only that device
                                        if let Some(ref d_id) = recipient.device_id {
                                            device_ids.push(d_id.clone());
                                        } else {
                                            tracing::info!(
                                                "Recipient {} has no device_id. Delegating to Delivery Service.",
                                                recipient.user_id
                                            );
                                            offline_list.push(recipient);
                                            continue;
                                        }

                                        for d_id in device_ids {
                                            let target_key =
                                                format!("{}:{}", recipient.user_id, d_id);
                                            let redis_presence_key =
                                                format!("user:online:{}", target_key);
                                            let mut is_online = false;

                                            if let Ok(mut con) = state
                                                .redis_client
                                                .get_multiplexed_async_connection()
                                                .await
                                            {
                                                if let Ok(exists) =
                                                    con.exists::<_, bool>(&redis_presence_key).await
                                                {
                                                    if exists {
                                                        is_online = true;
                                                        tracing::info!(
                                                            "Recipient {} is ONLINE. Publishing to Redis.",
                                                            target_key
                                                        );
                                                        let packet = serde_json::json!({
                                                            "recipientId": recipient.user_id,
                                                            "deviceId": d_id,
                                                            "content": payload,
                                                            "senderId": user_id,
                                                            "senderDeviceId": device_id,
                                                            "groupId": group_id
                                                        });
                                                        let _: Result<(), _> = con
                                                            .publish(
                                                                "chat:messages",
                                                                packet.to_string(),
                                                            )
                                                            .await;
                                                    }
                                                }
                                            }

                                            if !is_online {
                                                tracing::info!(
                                                    "Recipient {} is OFFLINE. Adding to offline list.",
                                                    target_key
                                                );
                                                // Push original recipient structure (with the specific deviceId we found/used)
                                                offline_list.push(Recipient {
                                                    user_id: recipient.user_id.clone(),
                                                    device_id: Some(d_id),
                                                });
                                            }
                                        }
                                    }

                                    // 3. Batch send offline messages to Storage Service
                                    if !offline_list.is_empty() {
                                        tracing::info!(
                                            "Sending {} messages to Offline Storage.",
                                            offline_list.len()
                                        );
                                        let body = serde_json::json!({
                                            "senderId": user_id,
                                            "recipients": offline_list,
                                            "content": payload,
                                            "groupId": group_id
                                        });

                                        let res = state
                                            .http_client
                                            .post(format!(
                                                "{}/mls-api/send",
                                                state.delivery_service_url
                                            ))
                                            .json(&body)
                                            .send()
                                            .await;

                                        if let Err(e) = res {
                                            tracing::error!(
                                                "Failed to send offline messages: {}",
                                                e
                                            );
                                        } else {
                                            tracing::info!("Offline messages sent successfully.");
                                        }
                                    }
                                }
                            }
                            Ok(WebSocketMessage::WelcomeMessage {
                                payload,
                                group_id,
                                recipients,
                            }) => {
                                // Explicit Welcome Message routing (Direct to specific user/device usually)
                                tracing::info!(
                                    "Processing Welcome Message for Group {:?}",
                                    group_id
                                );

                                // Forward to recipients via Redis PubSub if online, else HTTP
                                for recipient in recipients {
                                    if let Some(d_id) = recipient.device_id {
                                        let target_key = format!("{}:{}", recipient.user_id, d_id);
                                        let redis_presence_key =
                                            format!("user:online:{}", target_key);

                                        let mut sent = false;
                                        if let Ok(mut con) = state
                                            .redis_client
                                            .get_multiplexed_async_connection()
                                            .await
                                        {
                                            if let Ok(true) =
                                                con.exists::<_, bool>(&redis_presence_key).await
                                            {
                                                let packet = serde_json::json!({
                                                    "recipientId": recipient.user_id,
                                                    "deviceId": d_id,
                                                    "content": payload, // Base64 Welcome
                                                    "type": "mlsWelcome", // Tag it so client knows
                                                    "senderId": user_id,
                                                    "groupId": group_id
                                                });
                                                let _: Result<(), _> = con
                                                    .publish("chat:messages", packet.to_string())
                                                    .await;
                                                sent = true;
                                            }
                                        }

                                        if !sent {
                                            // Offline fallback
                                            let body = serde_json::json!({
                                                "senderId": user_id,
                                                "recipients": [ { "userId": recipient.user_id, "deviceId": d_id } ],
                                                "content": payload,
                                                "groupId": group_id
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
                                    } else {
                                        // Fan-out to all devices via Delivery Service logic
                                        tracing::info!(
                                            "Welcome message without target DeviceID for user {} -> Delegating fan-out.",
                                            recipient.user_id
                                        );
                                        // Send immediately via HTTP to Delivery Service to handle fan-out
                                        let body = serde_json::json!({
                                            "senderId": user_id,
                                            "recipients": [ { "userId": recipient.user_id, "deviceId": null } ],
                                            "content": payload,
                                            "groupId": group_id,
                                            "type": "mlsWelcome"
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
                            Ok(WebSocketMessage::Read { message_id }) => {
                                tracing::info!("Read receipt: {}", message_id);
                            }
                            Err(e) => {
                                tracing::error!("Failed to parse message: {}", e);
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
                    _ => {} // Binary or other ignored
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
