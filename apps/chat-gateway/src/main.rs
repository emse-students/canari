mod handlers;
mod models;
mod state;

use axum::{
    routing::get,
    Router,
};
use futures::stream::StreamExt;
use std::{net::SocketAddr, sync::Arc};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use rdkafka::{producer::FutureProducer, ClientConfig};
use reqwest::Client as HttpClient;

use crate::state::AppState;
use crate::handlers::{ws_handler, get_ratchet_tree, post_ratchet_tree};

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
    let redis_client = redis::Client::open("redis://127.0.0.1/").expect("Invalid Redis URL");

    // JWT Secret
    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| {
        "9a2f8c4e6b0d71f3e8b925b1234567890abcdef1234567890abcdef12345678".to_string()
    });

    // Kafka Producer
    let kafka_producer: FutureProducer = ClientConfig::new()
        .set("bootstrap.servers", "localhost:9092")
        .set("message.timeout.ms", "5000")
        .create()
        .expect("Producer creation error");

    let http_client = HttpClient::new();

    let app_state = Arc::new(AppState::new(
        redis_client.clone(),
        kafka_producer,
        jwt_secret,
        http_client,
    ));

    // Spawn Redis Subscriber Task (Direct Routing)
    {
        let redis_client = redis_client.clone();
        let connected_users = app_state.connected_users.clone();
        tokio::spawn(async move {
            let mut pubsub = redis_client.get_async_pubsub().await.expect("Redis connect failed");
            // Listen for direct messages from Backend or other Gateways
            pubsub.subscribe("chat:messages").await.expect("Redis subscribe failed");
            let mut stream = pubsub.on_message();

            while let Some(msg) = stream.next().await {
                if let Ok(payload_str) = msg.get_payload::<String>() {
                     // Expect format: { recipientId, deviceId, content, ... }
                     if let Ok(json) = serde_json::from_str::<serde_json::Value>(&payload_str) {
                         // Extract routing info
                         if let (Some(recipient_id), Some(device_id)) = (
                             json.get("recipientId").and_then(|v| v.as_str()),
                             json.get("deviceId").and_then(|v| v.as_str())
                         ) {
                             let key = format!("{}:{}", recipient_id, device_id);
                             
                             // Send to specific connection
                             let tx = {
                                 let map = connected_users.lock().unwrap();
                                 map.get(&key).cloned()
                             };
 
                             if let Some(tx) = tx {
                                 // Forward the FULL JSON packet so client has metadata (type, senderId, etc.)
                                 let _ = tx.send(payload_str.clone());
                             }
                         }
                     }
                }
            }
        });
    }

    let app = Router::new()
        .route("/ws", get(ws_handler))
        // MLS Specific Routes
        .route("/groups/{group_id}/tree", get(get_ratchet_tree).post(post_ratchet_tree))
        .with_state(app_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3000));
    tracing::info!("listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
