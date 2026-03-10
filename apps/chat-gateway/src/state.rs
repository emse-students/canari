use rdkafka::producer::FutureProducer;
use redis::Client as RedisClient;
use reqwest::Client as HttpClient;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

type ConnectedUser = mpsc::UnboundedSender<String>; // Channel to send JSON-encoded delivery frames

pub struct AppState {
    pub redis_client: RedisClient,
    pub kafka_producer: FutureProducer,
    // Map: "UserId:DeviceId" -> list of senders (multiple tabs / reconnects)
    // Channel carries JSON strings: { senderId, senderDeviceId, groupId, isWelcome, proto: base64(ciphertext) }
    pub connected_users: Arc<Mutex<HashMap<String, Vec<ConnectedUser>>>>,
    pub jwt_secret: String,
    pub http_client: HttpClient,
    pub delivery_service_url: String,
}

impl AppState {
    pub fn new(
        redis_client: RedisClient,
        kafka_producer: FutureProducer,
        jwt_secret: String,
        http_client: HttpClient,
        delivery_service_url: String,
    ) -> Self {
        AppState {
            redis_client,
            kafka_producer,
            connected_users: Arc::new(Mutex::new(HashMap::new())),
            jwt_secret,
            http_client,
            delivery_service_url,
        }
    }
}
