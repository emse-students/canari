use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures::stream::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Decode a standard base64 string to a UTF-8 string, returning `None` on any error.
fn base64_decode_to_string(input: &str) -> Option<String> {
    let bytes = BASE64.decode(input).ok()?;
    String::from_utf8(bytes).ok()
}

/// Alias for the per-connection outbound channel sender.
/// Each live WebSocket connection owns one of these; the pub/sub loop clones
/// and stores senders here so it can push frames without holding the lock.
type ConnectedUser = mpsc::Sender<String>;

/// Shared type alias for the connected users map.
type ConnectedUsers = Arc<Mutex<HashMap<String, HashMap<u64, ConnectedUser>>>>;

/// Spawns a Redis pub/sub subscriber that listens on `chat:messages` and
/// `chat:channel_events`, routing frames to connected WebSocket clients.
/// Reconnects automatically with a 5-second back-off if the connection drops.
pub fn spawn_redis_subscriber(redis_client: redis::Client, connected_users: ConnectedUsers) {
    tokio::spawn(async move {
        loop {
            tracing::info!("Attempting Redis pub/sub connection...");
            let pubsub_result = redis_client.get_async_pubsub().await;
            let mut pubsub = match pubsub_result {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("Redis pub/sub connection failed: {}. Retry in 5s...", e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    continue;
                }
            };

            match pubsub.subscribe("chat:messages").await {
                Ok(_) => tracing::info!("Subscribed to Redis channel 'chat:messages'"),
                Err(e) => {
                    tracing::warn!("Redis subscribe failed: {}. Retry in 5s...", e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    continue;
                }
            }

            match pubsub.subscribe("chat:channel_events").await {
                Ok(_) => tracing::info!("Subscribed to Redis channel 'chat:channel_events'"),
                Err(e) => {
                    tracing::warn!(
                        "Redis subscribe to channel_events failed: {}. Retry in 5s...",
                        e
                    );
                    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
                    continue;
                }
            }

            // Listen for direct messages from backend services or other gateway instances.
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
                            let device_id = match json.get("deviceId").and_then(|v| v.as_str()) {
                                Some(v) => v.to_string(),
                                None => {
                                    tracing::warn!(
                                        "[PubSub] chat:messages payload missing deviceId for recipient {}, dropping",
                                        recipient_id
                                    );
                                    continue;
                                }
                            };

                            // welcome_request control frames: proto is base64(JSON notification).
                            // Decode and relay as plain WS text; do NOT wrap in the MLS envelope.
                            let is_control = json
                                .get("isWelcomeRequest")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let json_frame = if is_control {
                                // Control frames carry a base64-encoded JSON notification
                                // in `proto`; decode it so the client receives plain JSON.
                                let proto_b64 = match json.get("proto").and_then(|v| v.as_str()) {
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
                                let proto_b64 = match json.get("proto").and_then(|v| v.as_str()) {
                                    Some(v) if !v.is_empty() => v,
                                    _ => {
                                        tracing::warn!(
                                            "Redis message missing 'proto' field, dropping"
                                        );
                                        continue;
                                    }
                                };

                                // Forward flat JSON to the WS client - no proto decode needed.
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

                            // Send to ALL active connections for this key (multi-tab support).
                            let senders = {
                                let map = connected_users.lock().unwrap();
                                map.get(&key).cloned()
                            };

                            let mut found = false;
                            let mut any_failed = false;
                            if let Some(senders) = senders {
                                found = true;
                                for tx in senders.values() {
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
                                        // on the next reconnect - it is NOT lost.
                                        tracing::warn!(
                                            "[PubSub] Real-time delivery failed for {} (queuedId={}) - message stays in DB queue, will be fetched on reconnect",
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
                                        senders.retain(|_, s| !s.is_closed());
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
                                    "[PubSub] {} not connected to this gateway - message stays in DB queue, will be fetched on reconnect (queuedId={}).",
                                    key,
                                    queue_id
                                );
                            }
                        } else if channel_name == "chat:channel_events" {
                            // Expected payload format:
                            // { "userIds": ["user1", "user2"], "type": "channel_event", "data": { … } }
                            let user_ids = match json.get("userIds").and_then(|v| v.as_array()) {
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

                            // Find all map keys that start with the user ID.
                            let senders_to_notify: Vec<(String, _)> = {
                                let map = connected_users.lock().unwrap();
                                let mut temp = Vec::new();
                                for u_id in user_ids {
                                    let prefix = format!("{}:", u_id);
                                    for (key, senders) in map.iter() {
                                        if key.starts_with(&prefix) {
                                            for tx in senders.values() {
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
            // Stream ended (Redis disconnected) - retry with back-off.
            tracing::warn!("Redis pub/sub stream ended, reconnecting in 5s...");
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    });
}

/// Spawns a Kafka consumer that broadcasts `post.created` events to all connected
/// WebSocket clients with at-least-once delivery semantics.
///
/// Auto-commit is disabled; offsets are committed manually only after the frame has
/// been successfully enqueued to at least one client. If no clients are connected,
/// the offset is still committed (the message is not relevant for replay).
pub fn spawn_kafka_consumer(kafka_brokers: String, connected_users: ConnectedUsers) {
    tokio::spawn(async move {
        use rdkafka::ClientConfig;
        use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
        use rdkafka::message::Message as KafkaMessage;

        // Retry loop: if initialization fails (Kafka down at startup), keep retrying.
        let consumer: StreamConsumer = loop {
            match ClientConfig::new()
                .set("group.id", "chat-gateway-broadcast")
                .set("bootstrap.servers", &kafka_brokers)
                .set("enable.partition.eof", "false")
                .set("session.timeout.ms", "6000")
                // Disable auto-commit so we control exactly when offsets advance.
                .set("enable.auto.commit", "false")
                .create::<StreamConsumer>()
            {
                Ok(c) => break c,
                Err(e) => {
                    tracing::warn!("[kafka] Consumer creation failed: {} - retrying in 10s", e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
                }
            }
        };

        // Retry subscribe separately.
        loop {
            match consumer.subscribe(&["post.created"]) {
                Ok(_) => break,
                Err(e) => {
                    tracing::warn!("[kafka] Subscribe failed: {} - retrying in 10s", e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
                }
            }
        }

        tracing::info!("[kafka] Subscribed to topic 'post.created' (at-least-once mode)");

        loop {
            match consumer.recv().await {
                Err(e) => tracing::warn!("[kafka] Receive error: {}", e),
                Ok(m) => {
                    let payload = match m.payload_view::<str>() {
                        None => "",
                        Some(Ok(s)) => s,
                        Some(Err(e)) => {
                            tracing::warn!("[kafka] Payload deserialization error: {:?}", e);
                            ""
                        }
                    };

                    tracing::info!("[kafka] post.created received ({} bytes)", payload.len());

                    let frame = serde_json::json!({
                        "type": "post_created",
                        "data": serde_json::from_str::<serde_json::Value>(payload)
                            .unwrap_or(serde_json::Value::Null)
                    })
                    .to_string();

                    let senders_to_notify: Vec<(String, _)> = {
                        let map = connected_users.lock().unwrap();
                        map.iter()
                            .flat_map(|(key, senders)| {
                                senders.values().map(|tx| (key.clone(), tx.clone()))
                            })
                            .collect()
                    };

                    let mut delivered = 0usize;
                    for (key, tx) in senders_to_notify {
                        match tx.try_send(frame.clone()) {
                            Ok(_) => delivered += 1,
                            Err(e) => tracing::debug!(
                                "[kafka] Backpressure: skipping slow client {}: {}",
                                key,
                                e
                            ),
                        }
                    }

                    tracing::info!(
                        "[kafka] Broadcasted post.created to {} client(s)",
                        delivered
                    );

                    // Commit offset AFTER delivery attempts (at-least-once).
                    // We always commit even if delivered == 0 to avoid replaying
                    // broadcasts to an empty room on restart.
                    if let Err(e) = consumer.commit_message(&m, CommitMode::Async) {
                        tracing::warn!("[kafka] Offset commit failed: {}", e);
                    }
                }
            }
        }
    });
}
