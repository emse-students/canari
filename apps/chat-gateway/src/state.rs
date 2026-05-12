use redis::Client as RedisClient;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::AtomicU64};
use tokio::sync::mpsc;

/// Alias for the per-connection outbound channel sender.
/// Each live WebSocket connection owns one of these; the pub/sub loop clones
/// and stores senders here so it can push frames without holding the lock.
type ConnectedUser = mpsc::Sender<String>;

/// Shared application state injected into every Axum handler via `State<Arc<AppState>>`.
pub struct AppState {
    /// Handle to the Redis instance used for pub/sub, presence keys, and pending-welcome lists.
    pub redis_client: RedisClient,
    /// Maps `"userId:deviceId"` to a set of live outbound senders keyed by `conn_id`.
    /// The inner `HashMap<u64, ConnectedUser>` supports multiple simultaneous tabs or
    /// a fast reconnect where the old sender has not been cleaned up yet.
    pub connected_users: Arc<Mutex<HashMap<String, HashMap<u64, ConnectedUser>>>>,
    /// Monotonically increasing counter used to assign a unique ID to each WS connection.
    /// Allows `ConnectionGuard::drop` to remove exactly one entry from `connected_users`
    /// without risking a race on `is_closed()`.
    pub next_conn_id: AtomicU64,
    /// HS256 secret used to validate the `canari_ws_token` JWT on upgrade.
    pub jwt_secret: String,
}

impl AppState {
    /// Create a new `AppState` from an open Redis client and a JWT secret string.
    pub fn new(redis_client: RedisClient, jwt_secret: String) -> Self {
        AppState {
            redis_client,
            connected_users: Arc::new(Mutex::new(HashMap::new())),
            next_conn_id: AtomicU64::new(0),
            jwt_secret,
        }
    }
}
