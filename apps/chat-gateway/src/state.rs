use redis::Client as RedisClient;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::AtomicU64};
use tokio::sync::mpsc;

type ConnectedUser = mpsc::Sender<String>; // Channel to send JSON-encoded delivery frames

pub struct AppState {
    pub redis_client: RedisClient,
    // Map: "UserId:DeviceId" -> { conn_id -> sender } (multiple tabs / reconnects)
    pub connected_users: Arc<Mutex<HashMap<String, HashMap<u64, ConnectedUser>>>>,
    /// Monotonically increasing counter used to assign a unique ID to each WS connection.
    pub next_conn_id: AtomicU64,
    pub jwt_secret: String,
}

impl AppState {
    pub fn new(redis_client: RedisClient, jwt_secret: String) -> Self {
        AppState {
            redis_client,
            connected_users: Arc::new(Mutex::new(HashMap::new())),
            next_conn_id: AtomicU64::new(0),
            jwt_secret,
        }
    }
}
