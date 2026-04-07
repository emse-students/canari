use redis::Client as RedisClient;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

type ConnectedUser = mpsc::Sender<String>; // Channel to send JSON-encoded delivery frames

pub struct AppState {
    pub redis_client: RedisClient,
    // Map: "UserId:DeviceId" -> list of senders (multiple tabs / reconnects)
    pub connected_users: Arc<Mutex<HashMap<String, Vec<ConnectedUser>>>>,
    pub jwt_secret: String,
}

impl AppState {
    pub fn new(redis_client: RedisClient, jwt_secret: String) -> Self {
        AppState {
            redis_client,
            connected_users: Arc::new(Mutex::new(HashMap::new())),
            jwt_secret,
        }
    }
}
