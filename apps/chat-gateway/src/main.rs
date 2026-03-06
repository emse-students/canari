use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State, Query, Path},
    response::{IntoResponse, Response, Json},
    routing::get,
    http::StatusCode,
    Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use std::{net::SocketAddr, sync::Arc, collections::HashMap};
use tokio::sync::broadcast;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::ClientConfig;
use redis::AsyncCommands;
use shared_rust::{MessageSentEvent, MessageReadEvent, TOPIC_CHAT_MESSAGES, TOPIC_MESSAGE_READ};
use chrono::Utc;
use uuid::Uuid;
use serde::{Deserialize, Serialize};
use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};
use tower_http::cors::{Any, CorsLayer};

struct AppState {
    redis_client: redis::Client,
    kafka_producer: FutureProducer,
    tx: broadcast::Sender<String>,
    jwt_secret: String,
}

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String, // User ID
    exp: usize,
}

#[derive(Serialize, Deserialize, Clone)]
struct HistoryMessage {
    id: String,
    sender_id: String,
    content: String,
    timestamp: String,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize)]
struct EncryptedPayload {
    ciphertext: String,
    iv: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    keys: Option<HashMap<String, String>>,
    version: u8,
}

#[derive(Deserialize)]
struct AuthParams {
    token: String,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WebSocketMessage {
    #[serde(rename_all = "camelCase")]
    MlsMessage {
        payload: String,  // Opaque MLS ciphertext (Base64)
        group_id: Option<String>, // Optional group_id to organize by conversation
    },
    #[serde(rename_all = "camelCase")]
    MlsWelcome {
        payload: String,  // MLS Welcome message (Base64)
        target_user_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    KeyPackagePublish {
        payload: String,  // Opaque KeyPackage (Base64)
    },
    #[serde(rename_all = "camelCase")]
    ConversationRequest {
        target_user_id: String,  // User requesting conversation with
    },
    #[serde(rename_all = "camelCase")]
    Read { message_id: Uuid },
}

/// Envelope générique envoyé aux clients WebSocket
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutgoingEnvelope {
    #[serde(rename = "type")]
    msg_type: String,
    sender_id: String,
    content: String,
}

// Logic extracted for testing
fn process_incoming(text: &str) -> Result<WebSocketMessage, serde_json::Error> {
    serde_json::from_str(text) // Can be replaced by protobuf or other serialization if needed
}

// REST Payload for Ratchet Tree storage
#[derive(Serialize, Deserialize)]
struct RatchetTreePayload {
    data: String, // Base64 encoded Tree
    version: u64,
}

#[tokio::main] // use tokio to run the async main function
async fn main() {

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "chat_gateway=debug,tower_http=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Redis connection
    let redis_client = redis::Client::open("redis://127.0.0.1/").expect("Invalid Redis URL");
    
    // JWT Secret
    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| "9a2f8c4e6b0d71f3e8b925b1234567890abcdef1234567890abcdef12345678".to_string());

    // Kafka Producer
    let kafka_producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", "localhost:9092")
        .set("message.timeout.ms", "5000")
        .create()
        .expect("Producer creation error");

    // Broadcast channel for internal distribution from Redis to Websocket clients
    let (tx, _rx) = broadcast::channel(100);

    let app_state = Arc::new(AppState {
        redis_client: redis_client.clone(),
        kafka_producer,
        tx: tx.clone(),
        jwt_secret,
    });

    // Spawn Redis Subscriber Task
    {
        let redis_client = redis_client.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut pubsub = redis_client.get_async_pubsub().await.expect("Redis connect failed");
            pubsub.subscribe("chat_events").await.expect("Redis subscribe failed");
            let mut stream = pubsub.on_message();
            
            while let Some(msg) = stream.next().await {
                if let Ok(payload) = msg.get_payload::<String>() {
                    // Broadcast to all WebSocket clients
                    let _ = tx.send(payload);
                }
            }
        });
    }

    let cors = CorsLayer::new()
        // allow `GET` and `POST` when accessing the resource
        .allow_methods(Any)
        // allow requests from any origin
        .allow_origin(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/ws", get(ws_handler))
        // MLS Specific Routes
        .route("/keys/{user_id}", get(get_key_package))
        .route("/groups/{group_id}/tree", get(get_ratchet_tree).post(post_ratchet_tree))
        .route("/history/{group_id}", get(get_history))
        .layer(cors)
        .with_state(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    tracing::info!("listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

// --- REST Handlers for MLS ---

async fn get_key_package(
    Path(user_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let mut con = match state.redis_client.get_multiplexed_async_connection().await {
        Ok(con) => con,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Redis error").into_response(),
    };

    let key: String = format!("key_package:{}", user_id);
    let result: Result<String, _> = con.get(key).await;

    match result {
        Ok(pkg) => (StatusCode::OK, pkg).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Key Package not found").into_response(),
    }
}

async fn get_ratchet_tree(
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

async fn post_ratchet_tree(
    Path(group_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RatchetTreePayload>,
) -> impl IntoResponse {
    let mut con = match state.redis_client.get_multiplexed_async_connection().await {
        Ok(con) => con,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Redis error").into_response(),
    };

    let key = format!("group:{}:tree", group_id);
    // In a real app, verify 'payload.version' > current version to avoid race conditions
    let _: Result<(), _> = con.set(key, payload.data).await;

    StatusCode::OK.into_response()
}

async fn get_history(
    Path(group_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let mut con = match state.redis_client.get_multiplexed_async_connection().await {
        Ok(con) => con,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, "Redis error").into_response(),
    };

    let history_key = format!("history:{}", group_id);
    
    // Get all messages from Redis Stream (0 = oldest, + = newest)
    let result: Result<Vec<(String, Vec<(String, String)>)>, _> = 
        redis::cmd("XRANGE")
            .arg(&history_key)
            .arg("-")
            .arg("+")
            .query_async(&mut con)
            .await;

    match result {
        Ok(entries) => {
            let messages: Vec<HistoryMessage> = entries
                .into_iter()
                .filter_map(|(id, fields)| {
                    let mut msg = HistoryMessage {
                        id: id.clone(),
                        sender_id: String::new(),
                        content: String::new(),
                        timestamp: String::new(),
                    };
                    
                    for (key, value) in fields {
                        match key.as_str() {
                            "sender_id" => msg.sender_id = value,
                            "content" => msg.content = value,
                            "timestamp" => msg.timestamp = value,
                            _ => {}
                        }
                    }
                    
                    // Only include if we have the essential fields
                    if !msg.sender_id.is_empty() && !msg.content.is_empty() {
                        Some(msg)
                    } else {
                        None
                    }
                })
                .collect();
            
            (StatusCode::OK, Json(messages)).into_response()
        },
        Err(_) => {
            // Empty history is OK - return empty array
            (StatusCode::OK, Json(Vec::<HistoryMessage>::new())).into_response()
        }
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<AuthParams>,
    State(state): State<Arc<AppState>>,
) -> Response {
    let validation = Validation::new(Algorithm::HS256);
    let key = DecodingKey::from_secret(state.jwt_secret.as_bytes());

    match decode::<Claims>(&params.token, &key, &validation) {
        Ok(token_data) => {
             ws.on_upgrade(move |socket| handle_socket(socket, state, token_data.claims.sub))
        },
        Err(_) => {
            (StatusCode::UNAUTHORIZED, "Invalid parameters").into_response()
        }
    }
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, user_id: String) {
    let (mut sender, mut receiver) = socket.split();

    // Subscribe first to avoid missing real-time messages during the fetch
    let mut rx = state.tx.subscribe();

    // 1. Send pending Welcome messages immediately
    if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
        let key = format!("pending_welcomes:{}", user_id);
        loop {
            // LPOP returns one element or nil
            let result: Result<Option<String>, _> = redis::cmd("LPOP")
                .arg(&key)
                .query_async(&mut con)
                .await;
            
            match result {
                Ok(Some(msg)) => {
                    if sender.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                _ => break, // Empty or error
            }
        }
    }

    // Task to receive all messages and send them to this client
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Task to receive messages from this client
    let mut recv_task = {
        let state = state.clone();
        let user_id = user_id.clone();
        tokio::spawn(async move {
            while let Some(Ok(Message::Text(text))) = receiver.next().await {
                // Parse incoming data
                let incoming = process_incoming(&text);
                
                match incoming {
                    Ok(WebSocketMessage::MlsMessage { payload, group_id }) => {
                        
                        // Gateway acts as passive Delivery Service
                        // We do not parse inner content, just route it.

                        // Create enriched event for Kafka/history
                        let event = MessageSentEvent {
                            id: Uuid::new_v4(),
                            sender_id: user_id.clone(),
                            username: "Anonymous".to_string(), 
                            content: payload.clone(), // Store Opaque MLS blob
                            timestamp: Utc::now(),
                            conversation_id: group_id.clone(),
                        };

                        // WebSocket envelope with explicit type field
                        let ws_envelope = OutgoingEnvelope {
                            msg_type: "mlsMessage".to_string(),
                            sender_id: user_id.clone(),
                            content: payload.clone(),
                        };

                        // Serialize to JSON
                        if let Ok(ws_serialized) = serde_json::to_string(&ws_envelope) {
                            // 1. Publish to Redis (fan-out to WebSocket clients)
                            if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
                                    let _: Result<(), _> = con.publish("chat_events", &ws_serialized).await;
                                    
                                    // 2. Store in Redis Stream for history (if group_id provided)
                                    if let Some(ref gid) = group_id {
                                        let stream_key = format!("history:{}", gid);
                                        let _: Result<String, _> = redis::cmd("XADD")
                                            .arg(&stream_key)
                                            .arg("*")
                                            .arg("sender_id").arg(user_id.clone())
                                            .arg("content").arg(payload.clone())
                                            .arg("timestamp").arg(event.timestamp.to_rfc3339())
                                            .query_async(&mut con)
                                            .await;
                                    }
                            }

                            // 3. Publish to Kafka (persistence) — full event
                            if let Ok(kafka_serialized) = serde_json::to_string(&event) {
                                let record = FutureRecord::to(TOPIC_CHAT_MESSAGES)
                                    .payload(&kafka_serialized)
                                    .key(&event.sender_id);
                                
                                let _ = state.kafka_producer.send(record, std::time::Duration::from_secs(0)).await;
                            }
                        }
                    },
                    Ok(WebSocketMessage::MlsWelcome { payload, target_user_id }) => {
                        // Welcome message : on le diffuse tel quel via Redis
                        tracing::info!("Received MLS Welcome from user {}", user_id);
                        let env = OutgoingEnvelope {
                            msg_type: "mlsWelcome".to_string(),
                            sender_id: user_id.clone(),
                            content: payload,
                        };
                        if let Ok(serialized) = serde_json::to_string(&env) {
                            if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
                                // 1. Live broadcast
                                let _: Result<(), _> = con.publish("chat_events", &serialized).await;

                                // 2. Store if offline (target provided)
                                if let Some(target) = target_user_id {
                                    let key = format!("pending_welcomes:{}", target);
                                    let _: Result<(), _> = con.rpush(key, &serialized).await;
                                }
                            }
                        }
                    },
                    Ok(WebSocketMessage::KeyPackagePublish { payload }) => {
                         // TODO: Store KeyPackage in Redis for other users to fetch
                         // Key: "key_package:{user_id}"
                         tracing::info!("Received KeyPackage from user {}", user_id);
                         if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
                            let _: Result<(), _> = con.set(format!("key_package:{}", user_id), payload).await;
                         }
                    },
                    Ok(WebSocketMessage::ConversationRequest { target_user_id }) => {
                        // User A requests conversation with User B
                        tracing::info!("Conversation request from {} to {}", user_id, target_user_id);
                        
                        // Create a notification envelope
                        let notification = OutgoingEnvelope {
                            msg_type: "conversationRequest".to_string(),
                            sender_id: user_id.clone(),
                            content: target_user_id.clone(),
                        };
                        
                        if let Ok(serialized) = serde_json::to_string(&notification) {
                            // Publish to Redis for real-time delivery to target user
                            if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
                                let _: Result<(), _> = con.publish("chat_events", &serialized).await;
                            }
                        }
                    },
                    Ok(WebSocketMessage::Read { message_id }) => {
                        let event = MessageReadEvent {
                            message_id,
                            user_id: user_id.clone(),
                            timestamp: Utc::now(),
                            conversation_id: None
                        };

                         if let Ok(serialized) = serde_json::to_string(&event) {
                            // 1. Publish to Redis (fan-out)
                            if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
                                let _: Result<(), _> = con.publish("chat_events", &serialized).await;
                            }

                            // 2. Publish to Kafka
                            let record = FutureRecord::to(TOPIC_MESSAGE_READ)
                                .payload(&serialized)
                                .key(&event.user_id);
                            
                            let _ = state.kafka_producer.send(record, std::time::Duration::from_secs(0)).await;
                        }
                    },
                    Err(e) => {
                        tracing::warn!("Failed to parse message: {:?}", e);
                    }
                }
            }
        })
    };


    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_incoming_send() {
        let json = r#"{"type": "mlsMessage", "payload": "BASE64_BLOB"}"#;
        let result = process_incoming(json).unwrap();
        match result {
            WebSocketMessage::MlsMessage { payload } => {
                assert_eq!(payload, "BASE64_BLOB");
            }
            _ => panic!("Wrong variant"),
        }
    }

    #[test]
    fn test_process_incoming_read() {
        let id = Uuid::new_v4();
        let json = format!(r#"{{"type": "read", "messageId": "{}"}}"#, id);
        let result = process_incoming(&json).unwrap();
         match result {
            WebSocketMessage::Read { message_id } => {
                assert_eq!(message_id, id);
            },
            _ => panic!("Wrong variant"),
        }
    }

    #[test]
    fn test_process_incoming_invalid() {
        let json = r#"{"type": "unknown", "foo": "bar"}"#;
        let result = process_incoming(json);
        assert!(result.is_err());
    }

    #[test]
    fn test_process_incoming_malformed() {
        let json = r#"{"type": "send", "username": "Alice"}"#; // Missing content
        let result = process_incoming(json);
        assert!(result.is_err());
    }
}

