use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, State},
    response::{IntoResponse},
    routing::get,
    Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use std::{net::SocketAddr, sync::Arc};
use tokio::sync::broadcast;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::ClientConfig;
use redis::AsyncCommands;
use shared_rust::{MessageSentEvent, MessageReadEvent, TOPIC_CHAT_MESSAGES, TOPIC_MESSAGE_READ};
use chrono::Utc;
use uuid::Uuid;
use serde::Deserialize;

struct AppState {
    redis_client: redis::Client,
    kafka_producer: FutureProducer,
    tx: broadcast::Sender<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WebSocketMessage {
    Send { username: String, content: String },
    Read { message_id: Uuid, user_id: String },
}

#[tokio::main]
async fn main() {

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "chat_gateway=debug,tower_http=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Redis connection
    let redis_client = redis::Client::open("redis://127.0.0.1/").expect("Invalid Redis URL");

    // Kafka Producer
    let kafka_producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", "localhost:9092")
        .set("message.timeout.ms", "5000")
        .create()
        .expect("Producer creation error");

    // Broadcast channel for internal distribution from Redis to Websockets
    let (tx, _rx) = broadcast::channel(100);

    let app_state = Arc::new(AppState {
        redis_client: redis_client.clone(),
        kafka_producer,
        tx: tx.clone(),
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
                    let _ = tx.send(payload);
                }
            }
        });
    }

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .with_state(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    tracing::info!("listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();

    let mut rx = state.tx.subscribe();

    // Task to receive global messages and send to this client
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
        tokio::spawn(async move {
            while let Some(Ok(Message::Text(text))) = receiver.next().await {
                // Parse incoming JSON
                let incoming: Result<WebSocketMessage, _> = serde_json::from_str(&text);
                
                match incoming {
                    Ok(WebSocketMessage::Send { username, content }) => {
                        // Create enriched event
                        let event = MessageSentEvent {
                            id: Uuid::new_v4(),
                            sender_id: Uuid::new_v4().to_string(), // Placeholder for real Auth ID
                            username,
                            content,
                            timestamp: Utc::now(),
                            conversation_id: None,
                        };

                        // Serialize to JSON
                        if let Ok(serialized) = serde_json::to_string(&event) {
                            // 1. Publish to Redis (fan-out)
                            if let Ok(mut con) = state.redis_client.get_multiplexed_async_connection().await {
                                    let _: Result<(), _> = con.publish("chat_events", &serialized).await;
                            }

                            // 2. Publish to Kafka (persistence)
                            let record = FutureRecord::to(TOPIC_CHAT_MESSAGES)
                                .payload(&serialized)
                                .key(&event.sender_id);
                            
                            let _ = state.kafka_producer.send(record, std::time::Duration::from_secs(0)).await;
                        }
                    },
                    Ok(WebSocketMessage::Read { message_id, user_id }) => {
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

