use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use futures::{sink::SinkExt, stream::StreamExt};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use redis::AsyncCommands;
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::models::{AuthParams, Claims};
use crate::state::AppState;
use crate::ws_dispatch::WsFrame;

// ── ConnectionGuard — cleanup on drop ────────────────────────────────────

struct ConnectionGuard {
    state: Arc<AppState>,
    conn_key: String,
    redis_key: String,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        tracing::info!(
            "Executing guaranteed cleanup (Drop) for connection keys {} / {}",
            self.conn_key,
            self.redis_key
        );
        {
            let mut map = self.state.connected_users.lock().unwrap();
            if let Some(senders) = map.get_mut(&self.conn_key) {
                senders.retain(|s| !s.is_closed());
                if senders.is_empty() {
                    map.remove(&self.conn_key);
                }
            }
        }
        let state = self.state.clone();
        let redis_key = self.redis_key.clone();
        tokio::spawn(async move {
            if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
                let _: Result<(), _> = redis::cmd("DEL")
                    .arg(&redis_key)
                    .query_async(&mut con)
                    .await;
            }
        });
    }
}

// ── Public WS upgrade handler ─────────────────────────────────────────────

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

// ── Socket lifecycle ──────────────────────────────────────────────────────

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

    let (mut ws_sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(256);
    let conn_key = format!("{}:{}", user_id, device_id);

    {
        let mut map = state.connected_users.lock().unwrap();
        map.entry(conn_key.clone()).or_default().push(tx.clone());
        tracing::info!(
            "Registered connection key: {} ({} active)",
            conn_key,
            map[&conn_key].len()
        );
    }

    let redis_key = format!("user:online:{}", conn_key);
    let _guard = ConnectionGuard {
        state: state.clone(),
        conn_key: conn_key.clone(),
        redis_key: redis_key.clone(),
    };

    // Set initial presence + drain any legacy pending_welcomes from Redis.
    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
        let _: Result<(), _> = con.set_ex(&redis_key, "true", 120).await;

        let welcome_key = format!("pending_welcomes:{}", user_id);
        let pending: Result<Vec<String>, _> = redis::cmd("LRANGE")
            .arg(&welcome_key)
            .arg(0)
            .arg(-1)
            .query_async(&mut con)
            .await;

        if let Ok(msgs) = pending {
            for msg in msgs {
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
                    if ws_sender
                        .send(Message::Text(json_msg.into()))
                        .await
                        .is_err()
                    {
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

    // ── Send task: relay outbound frames + periodic presence refresh ──────
    let conn_key_ping = conn_key.clone();
    let redis_key_ping = redis_key.clone();
    let redis_client_ping = state.redis_client.clone();
    let mut send_task = tokio::spawn(async move {
        let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tokio::select! {
                msg_opt = rx.recv() => {
                    match msg_opt {
                        Some(msg) => {
                            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                _ = ping_interval.tick() => {
                    if let Ok(mut con) = redis_client_ping.get_multiplexed_async_connection().await {
                        let _: Result<(), _> = con.set_ex(&redis_key_ping, "true", 120).await;
                    }
                    tracing::debug!("Sending ping to {} to keep connection alive", conn_key_ping);
                    if ws_sender.send(Message::Ping(vec![].into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // ── Recv task: parse frames + dispatch ────────────────────────────────
    let mut recv_task = {
        let state = state.clone();
        let user_id = user_id.clone();
        let device_id = device_id.clone();

        tokio::spawn(async move {
            while let Some(msg) = receiver.next().await {
                // Refresh presence on any activity.
                {
                    let redis_key = format!("user:online:{}:{}", user_id, device_id);
                    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await
                    {
                        let _: Result<(), _> = con.set_ex(&redis_key, "true", 120).await;
                    }
                }

                match msg {
                    Ok(Message::Text(text)) => {
                        let raw_len = text.len();
                        tracing::info!(
                            "Received WS JSON frame from {} ({} bytes)",
                            user_id,
                            raw_len
                        );

                        let json = match serde_json::from_str::<serde_json::Value>(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::error!("JSON parse error from {}: {}", user_id, e);
                                continue;
                            }
                        };

                        let frame = match WsFrame::parse(&json) {
                            Some(f) => f,
                            None => {
                                tracing::error!("Base64 decode error in frame from {}", user_id);
                                continue;
                            }
                        };

                        tracing::info!(
                            "[WS RX] from={}:{} type={} group={} rawBytes={}",
                            user_id,
                            device_id,
                            frame.msg_type,
                            if frame.group_id.is_empty() {
                                "<none>"
                            } else {
                                &frame.group_id
                            },
                            raw_len
                        );

                        if frame.msg_type == "welcome_request"
                            || frame.msg_type == "reinvite_request"
                        {
                            tracing::warn!(
                                "[WS RX] control frame '{}' received from {}:{} but WS dispatch is currently diagnostic-only",
                                frame.msg_type,
                                user_id,
                                device_id
                            );
                        }

                        log_routing_diagnostics(&state, &user_id, &device_id, &frame).await;
                    }
                    Ok(Message::Close(c)) => {
                        tracing::info!("Client closed connection: {:?}", c);
                        break;
                    }
                    Err(e) => {
                        tracing::error!("WebSocket Error from {}: {}", user_id, e);
                        break;
                    }
                    _ => {}
                }
            }
        })
    };

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
    // Cleanup handled by ConnectionGuard's Drop.
}

// ── Routing diagnostics ───────────────────────────────────────────────────

async fn log_routing_diagnostics(
    state: &Arc<AppState>,
    user_id: &str,
    device_id: &str,
    frame: &WsFrame,
) {
    if frame.group_id.is_empty() {
        tracing::info!(
            "[ROUTE] type={} from={}:{} (no groupId)",
            frame.msg_type,
            user_id,
            device_id
        );
        return;
    }

    let online_all: Vec<String> = {
        let map = state.connected_users.lock().unwrap();
        map.keys().cloned().collect()
    };

    let member_status: Vec<String> =
        if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
            let key = format!("group:members:{}", frame.group_id);
            let members: Vec<String> = con.smembers(&key).await.unwrap_or_default();
            members
                .iter()
                .map(|m| {
                    let status = if online_all.contains(m) {
                        "ONLINE"
                    } else {
                        "OFFLINE"
                    };
                    format!("{} [{}]", m, status)
                })
                .collect()
        } else {
            vec!["<redis-unavailable>".to_string()]
        };

    tracing::info!(
        "[ROUTE] type={} group={} from={}:{} | members: {}",
        frame.msg_type,
        frame.group_id,
        user_id,
        device_id,
        if member_status.is_empty() {
            "<none registered>".to_string()
        } else {
            member_status.join(", ")
        }
    );
}

// ── Presence endpoint ─────────────────────────────────────────────────────

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
