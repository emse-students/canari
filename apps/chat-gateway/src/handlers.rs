use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures::{sink::SinkExt, stream::StreamExt};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use redis::AsyncCommands;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::mpsc;

use crate::models::{AuthParams, Claims};
use crate::state::AppState;
use crate::ws_dispatch::{
    WsConn, WsFrame, handle_disconnect, handle_reinvite_request, handle_welcome_request,
};

// ── Cookie helper ─────────────────────────────────────────────────────────

/// Extract the value of a named cookie from the `Cookie` HTTP header.
/// Returns `None` if the header is absent or the named cookie is not present.
fn extract_cookie_value(headers: &HeaderMap, key: &str) -> Option<String> {
    let cookie_header = headers.get("cookie")?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some((name, value)) = trimmed.split_once('=')
            && name.trim() == key
        {
            return Some(value.trim().to_string());
        }
    }
    None
}

// ── ConnectionGuard - cleanup on drop ────────────────────────────────────

/// RAII guard that cleans up a WebSocket connection's in-memory entry and
/// Redis presence key when the connection task exits (for any reason).
///
/// Using `Drop` instead of explicit cleanup ensures presence is removed even
/// when the task is cancelled or panics.
struct ConnectionGuard {
    state: Arc<AppState>,
    /// The `"userId:deviceId"` key used in `connected_users`.
    conn_key: String,
    /// The Redis key `user:online:{userId}:{deviceId}` to delete on disconnect.
    redis_key: String,
    /// Unique ID assigned to this connection, used for O(1) removal from the map.
    conn_id: u64,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        // Remove this specific connection by its unique ID, then check whether
        // any other live sessions remain for the same conn_key (e.g. other tabs
        // or a fast reconnect).  This avoids the race where `is_closed()` still
        // returns false for an aborted send_task whose receiver hasn't been
        // dropped yet by the async runtime.
        let still_connected = {
            let mut map = self.state.connected_users.lock().unwrap();
            if let Some(senders) = map.get_mut(&self.conn_key) {
                senders.remove(&self.conn_id);
                // Also prune any other stale senders while the lock is held.
                senders.retain(|_, s| !s.is_closed());
                if senders.is_empty() {
                    map.remove(&self.conn_key);
                    false
                } else {
                    true // another session is alive - keep the presence key
                }
            } else {
                false
            }
        };

        if still_connected {
            tracing::info!(
                "[presence] Skipping DEL for {} - another session is still active",
                self.conn_key
            );
            return;
        }

        tracing::info!(
            "[presence] Cleaning up presence key {} for {}",
            self.redis_key,
            self.conn_key
        );
        let state = self.state.clone();
        let redis_key = self.redis_key.clone();
        let conn_key = self.conn_key.clone();
        // Retry up to 3 times so a brief Redis blip doesn't leave a stale key
        // (TTL=20s is the last-resort fallback if all attempts fail).
        tokio::spawn(async move {
            for attempt in 0u8..3 {
                if attempt > 0 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
                }
                match state.redis_client.get_multiplexed_async_connection().await {
                    Ok(mut con) => {
                        if redis::cmd("DEL")
                            .arg(&redis_key)
                            .query_async::<()>(&mut con)
                            .await
                            .is_ok()
                        {
                            tracing::info!(
                                "[presence] DEL {} ok (attempt {})",
                                conn_key,
                                attempt + 1
                            );
                            return;
                        }
                        tracing::warn!(
                            "[presence] DEL {} failed (attempt {})",
                            conn_key,
                            attempt + 1
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            "[presence] Redis unavailable for DEL of {} (attempt {}): {}",
                            conn_key,
                            attempt + 1,
                            e
                        );
                    }
                }
            }
            tracing::warn!("[presence] DEL abandoned after 3 attempts for {}", conn_key);
        });
    }
}

// ── Public WS upgrade handler ─────────────────────────────────────────────

/// Axum handler for `GET /api/ws`.
///
/// Validates the JWT from the `canari_ws_token` cookie or the `token` query
/// parameter, then upgrades the HTTP connection to a WebSocket and hands off
/// to `handle_socket`.  Returns `401 Unauthorized` if no valid token is found.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<AuthParams>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    let token = extract_cookie_value(&headers, "canari_ws_token").or(params.token);
    let validation = Validation::new(Algorithm::HS256);
    let key = DecodingKey::from_secret(state.jwt_secret.as_bytes());

    let Some(token) = token else {
        return (StatusCode::UNAUTHORIZED, "Missing auth token").into_response();
    };

    match decode::<Claims>(&token, &key, &validation) {
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

/// Drive a single authenticated WebSocket connection.
///
/// Responsibilities:
/// - Registers the outbound sender in `AppState::connected_users`.
/// - Sets (and periodically refreshes) the `user:online:{userId}:{deviceId}` Redis key.
/// - Drains any legacy `pending_welcomes` queued in Redis and flushes them to the client.
/// - Spawns two concurrent tasks: a **send task** (outbound frames + ping heartbeat) and
///   a **recv task** (inbound frame dispatch).
/// - Uses `ConnectionGuard` to ensure cleanup happens even on task cancellation.
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

    // Assign a unique monotonic ID to this connection so ConnectionGuard::drop
    // can remove it from the map without relying on is_closed(), which has a
    // race with abort() on the send task.
    let conn_id = state.next_conn_id.fetch_add(1, Ordering::Relaxed);

    {
        let mut map = state.connected_users.lock().unwrap();
        map.entry(conn_key.clone())
            .or_default()
            .insert(conn_id, tx.clone());
        tracing::info!(
            "Registered connection key: {} (conn_id={}, {} active)",
            conn_key,
            conn_id,
            map[&conn_key].len()
        );
    }

    let redis_key = format!("user:online:{}", conn_key);
    let _guard = ConnectionGuard {
        state: state.clone(),
        conn_key: conn_key.clone(),
        redis_key: redis_key.clone(),
        conn_id,
    };

    // Shared flag: set to true when a Ping is sent and back to false when the
    // corresponding Pong is received.  If still true at the next Ping tick the
    // client has missed an entire interval and is considered dead.
    let awaiting_pong = Arc::new(AtomicBool::new(false));

    // Establish ONE shared Redis connection for this socket's lifetime.
    // MultiplexedConnection is Clone - all clones share the same underlying
    // TCP connection, so we avoid opening a new connection for every frame.
    // If Redis is unavailable at connect time, we proceed in degraded mode
    // (no presence) and attempt to reconnect on the first Pong / frame.
    let redis_conn: Option<redis::aio::MultiplexedConnection> = match state
        .redis_client
        .get_multiplexed_async_connection()
        .await
    {
        Ok(mut con) => {
            // ── Set initial presence key ───────────────────────────────
            if let Err(e) = con.set_ex::<_, _, ()>(&redis_key, "true", 20).await {
                tracing::warn!(
                    "[presence] set_ex on connect failed for {}: {}",
                    conn_key,
                    e
                );
            } else {
                tracing::info!("[presence] Online: {} (TTL=20s)", conn_key);
            }

            // ── Drain legacy pending_welcomes ─────────────────────────
            let welcome_key = format!("pending_welcomes:{}", user_id);
            match redis::cmd("LRANGE")
                .arg(&welcome_key)
                .arg(0)
                .arg(-1)
                .query_async::<Vec<String>>(&mut con)
                .await
            {
                Ok(msgs) if !msgs.is_empty() => {
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
                    if let Err(e) = redis::cmd("DEL")
                        .arg(&welcome_key)
                        .query_async::<()>(&mut con)
                        .await
                    {
                        tracing::warn!(
                            "[presence] DEL pending_welcomes failed for {}: {}",
                            user_id,
                            e
                        );
                    }
                }
                Err(e) => tracing::warn!("[presence] LRANGE pending_welcomes failed: {}", e),
                _ => {}
            }

            Some(con)
        }
        Err(e) => {
            tracing::warn!(
                "[presence] Redis unavailable at connect for {} - proceeding in degraded mode: {}",
                conn_key,
                e
            );
            None
        }
    };

    // ── Send task: relay outbound frames + heartbeat ping ────────────────
    // Ping every 1s. Detection: if awaiting_pong is STILL true when the next
    // tick fires, the client never answered → dead → break immediately.
    // This gives a max dead-connection detection window of ~1 s.
    let conn_key_ping = conn_key.clone();
    let pong_flag_send = awaiting_pong.clone();
    let mut send_task = tokio::spawn(async move {
        let mut ping_interval = tokio::time::interval(std::time::Duration::from_secs(1));
        ping_interval.tick().await; // skip the immediate first tick
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
                    // swap(true): set flag to "awaiting pong".
                    // If it was already true the previous ping went unanswered.
                    if pong_flag_send.swap(true, Ordering::Relaxed) {
                        tracing::warn!(
                            "[heartbeat] No pong from {} - closing dead connection",
                            conn_key_ping
                        );
                        break;
                    }
                    tracing::debug!("[heartbeat] Sending ping to {}", conn_key_ping);
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
        let conn_key_recv = conn_key.clone();
        let pong_flag_recv = awaiting_pong.clone();
        let tx_for_dispatch = tx.clone();

        tokio::spawn(async move {
            // Take ownership of the shared connection (or None in degraded mode).
            // On any Redis error we attempt a single reconnect via the client.
            let mut con_opt = redis_conn;

            while let Some(msg) = receiver.next().await {
                match msg {
                    Ok(Message::Pong(_)) => {
                        // Client is alive: clear the awaiting flag and refresh TTL.
                        pong_flag_recv.store(false, Ordering::Relaxed);
                        refresh_presence(
                            &mut con_opt,
                            &state,
                            &user_id,
                            &device_id,
                            &conn_key_recv,
                        )
                        .await;
                        continue;
                    }
                    Ok(Message::Text(text)) => {
                        // Any inbound data frame proves the client is reachable
                        // end-to-end (not just the nginx TCP layer).
                        pong_flag_recv.store(false, Ordering::Relaxed);
                        refresh_presence(
                            &mut con_opt,
                            &state,
                            &user_id,
                            &device_id,
                            &conn_key_recv,
                        )
                        .await;

                        let json = match serde_json::from_str::<serde_json::Value>(&text) {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::error!("JSON parse error from {}: {}", user_id, e);
                                continue;
                            }
                        };

                        // Client heartbeat - liveness already registered above.
                        if json.get("type").and_then(|v| v.as_str()) == Some("ping") {
                            continue;
                        }

                        let raw_len = text.len();
                        tracing::info!(
                            "Received WS JSON frame from {} ({} bytes)",
                            user_id,
                            raw_len
                        );

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

                        match frame.msg_type.as_str() {
                            "disconnect" => {
                                // Client is going offline intentionally - DEL presence
                                // immediately so peers see them offline right away,
                                // then close the connection cleanly.
                                handle_disconnect(&state, &user_id, &device_id).await;
                                break;
                            }
                            "welcome_request" => {
                                let conn = WsConn {
                                    state: &state,
                                    user_id: &user_id,
                                    device_id: &device_id,
                                    tx: &tx_for_dispatch,
                                };
                                handle_welcome_request(&conn, &frame).await;
                            }
                            "reinvite_request" => {
                                let conn = WsConn {
                                    state: &state,
                                    user_id: &user_id,
                                    device_id: &device_id,
                                    tx: &tx_for_dispatch,
                                };
                                handle_reinvite_request(&conn, &frame).await;
                            }
                            _ => {}
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

// ── Presence refresh helper ───────────────────────────────────────────────

/// Refresh the `user:online:{userId}:{deviceId}` Redis TTL to 20 seconds.
///
/// Uses the socket-local multiplexed connection to avoid opening a new TCP
/// connection per frame.  If the connection is missing or has gone stale, it
/// attempts a single reconnect and stores the new connection back into
/// `con_opt` for future calls.
async fn refresh_presence(
    con_opt: &mut Option<redis::aio::MultiplexedConnection>,
    state: &Arc<AppState>,
    user_id: &str,
    device_id: &str,
    conn_key: &str,
) {
    let redis_key = format!("user:online:{}:{}", user_id, device_id);

    // Try the existing connection first.
    if let Some(con) = con_opt.as_mut() {
        match con.set_ex::<_, _, ()>(&redis_key, "true", 20).await {
            Ok(_) => return,
            Err(e) => {
                tracing::warn!(
                    "[presence] set_ex failed for {} (will reconnect): {}",
                    conn_key,
                    e
                );
                *con_opt = None; // mark as dead
            }
        }
    }

    // Connection is dead or was never established - attempt a single reconnect.
    match state.redis_client.get_multiplexed_async_connection().await {
        Ok(mut new_con) => {
            if let Err(e) = new_con.set_ex::<_, _, ()>(&redis_key, "true", 20).await {
                tracing::warn!(
                    "[presence] set_ex after reconnect failed for {}: {}",
                    conn_key,
                    e
                );
            } else {
                tracing::info!(
                    "[presence] Reconnected to Redis and refreshed TTL for {}",
                    conn_key
                );
                *con_opt = Some(new_con);
            }
        }
        Err(e) => {
            tracing::warn!(
                "[presence] Redis unreachable during presence refresh for {}: {}",
                conn_key,
                e
            );
        }
    }
}

// ── Routing diagnostics ───────────────────────────────────────────────────

/// Log the online/offline status of every group member for a received frame.
///
/// Queries Redis for the `group:members:{groupId}` set and cross-references
/// with the in-memory `connected_users` map.  Emits a single structured log
/// line useful for debugging routing issues.  No-ops when `frame.group_id` is empty.
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
        map.keys().cloned().collect::<Vec<_>>()
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
