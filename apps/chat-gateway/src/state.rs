use rdkafka::producer::FutureProducer;
use reqwest::Client as HttpClient;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use redis::Client as RedisClient;

pub struct AppState {
    pub redis_client: RedisClient,
    pub kafka_producer: FutureProducer,
    // Map: "UserId:DeviceId" -> Sender
    pub connected_users: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<String>>>>,
    pub jwt_secret: String,
    pub http_client: HttpClient,
}

impl AppState {
    pub fn new(
        redis_client: RedisClient,
        kafka_producer: FutureProducer,
        jwt_secret: String,
        http_client: HttpClient,
    ) -> Self {
        AppState {
            redis_client,
            kafka_producer,
            connected_users: Arc::new(Mutex::new(HashMap::new())),
            jwt_secret,
            http_client,
        }
    }
}