use crate::audience::PresenceAudience;
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
    /// Handle to the Redis instance used for pub/sub, presence keys, and `pending_welcome_notify` lists.
    pub redis_client: RedisClient,
    /// Maps `"userId:deviceId"` to a set of live outbound senders keyed by `conn_id`.
    /// The inner `HashMap<u64, ConnectedUser>` supports multiple simultaneous tabs or
    /// a fast reconnect where the old sender has not been cleaned up yet.
    pub connected_users: Arc<Mutex<HashMap<String, HashMap<u64, ConnectedUser>>>>,
    /// Monotonically increasing counter used to assign a unique ID to each WS connection.
    /// Allows `ConnectionGuard::drop` to remove exactly one entry from `connected_users`
    /// without risking a race on `is_closed()`.
    pub next_conn_id: AtomicU64,
    /// Per connection (`conn_id`): whether its socket declared
    /// [`crate::addressing::ADDRESSED_HISTORY_CAPABILITY`]. Read by the pub/sub loop's edge filter
    /// ([`crate::addressing::addressed_recipients`]); the cross-process fact is the sessions hash.
    pub session_caps: Arc<Mutex<HashMap<u64, bool>>>,
    /// This process's identity in the shared sessions hash, so two gateway processes - which both
    /// number their connections from 0 - never write the same session field.
    pub instance_id: String,
    /// HS256 secret used to validate the `canari_ws_token` JWT on upgrade.
    pub jwt_secret: String,
    /// Who may see whose presence: asked of chat-delivery and social-service on every
    /// `GET /api/presence` (WP-PRESENCE).
    pub presence_audience: PresenceAudience,
}

impl AppState {
    /// Create a new `AppState` from an open Redis client, a JWT secret string and the client that
    /// establishes the presence audience.
    pub fn new(
        redis_client: RedisClient,
        jwt_secret: String,
        presence_audience: PresenceAudience,
    ) -> Self {
        AppState {
            redis_client,
            connected_users: Arc::new(Mutex::new(HashMap::new())),
            next_conn_id: AtomicU64::new(0),
            session_caps: Arc::new(Mutex::new(HashMap::new())),
            instance_id: uuid::Uuid::new_v4().to_string(),
            jwt_secret,
            presence_audience,
        }
    }

    /// Unregister one connection and answer whether the DEVICE is still online.
    ///
    /// Removes `conn_id` from `conn_key`'s session set, prunes any sender whose
    /// receiver is already gone, and drops the whole entry when nothing is left.
    /// Returns `true` when at least one other live session remains, i.e. when the
    /// caller must NOT delete the presence key.
    ///
    /// The pruning is why `is_closed()` alone is not enough: an aborted send task
    /// can still report `false` until the runtime drops its receiver, so the
    /// authoritative removal is by `conn_id`.
    pub fn remove_session(&self, conn_key: &str, conn_id: u64) -> bool {
        self.session_caps.lock().unwrap().remove(&conn_id);
        let mut map = self.connected_users.lock().unwrap();
        let Some(senders) = map.get_mut(conn_key) else {
            return false;
        };
        senders.remove(&conn_id);
        senders.retain(|_, s| !s.is_closed());
        if senders.is_empty() {
            map.remove(conn_key);
            return false;
        }
        true
    }

    /// Record what the socket `conn_id` declared on upgrade (`caps=`).
    pub fn note_session_caps(&self, conn_id: u64, addressed_history: bool) {
        self.session_caps
            .lock()
            .unwrap()
            .insert(conn_id, addressed_history);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an `AppState` with no I/O: `Client::open` only parses the URL, it
    /// does not connect, and neither method under test touches Redis.
    fn state() -> AppState {
        AppState::new(
            RedisClient::open("redis://127.0.0.1/").unwrap(),
            "test-secret".to_string(),
            PresenceAudience::new(String::new(), String::new(), String::new()),
        )
    }

    /// Register a live session and return the receiver that keeps it open - it
    /// must be held by the caller, since dropping it closes the stored sender.
    fn register(state: &AppState, conn_key: &str, conn_id: u64) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel::<String>(1);
        state
            .connected_users
            .lock()
            .unwrap()
            .entry(conn_key.to_string())
            .or_default()
            .insert(conn_id, tx);
        rx
    }

    const KEY: &str = "user-1:device-1";

    #[test]
    fn a_lone_connection_leaving_takes_the_device_offline() {
        let state = state();
        let _rx = register(&state, KEY, 1);

        assert!(!state.remove_session(KEY, 1));
        assert!(!state.connected_users.lock().unwrap().contains_key(KEY));
    }

    /// The regression this pair of methods exists for: an explicit
    /// `{"type":"disconnect"}` frame from one tab must NOT delete a presence key
    /// that another tab of the same device is still holding.
    #[test]
    fn a_sibling_tab_keeps_the_device_online() {
        let state = state();
        let _leaving = register(&state, KEY, 1);
        let _staying = register(&state, KEY, 2);

        assert!(state.remove_session(KEY, 1));
    }

    /// A sender whose receiver is gone is not a session: it must not hold the
    /// presence key open for a connection that has actually left.
    #[test]
    fn a_sender_with_no_receiver_does_not_count_as_a_session() {
        let state = state();
        let _leaving = register(&state, KEY, 1);
        drop(register(&state, KEY, 2));

        assert!(!state.remove_session(KEY, 1));
        assert!(!state.connected_users.lock().unwrap().contains_key(KEY));
    }

    /// Another DEVICE of the same user has its own key and must never be read as
    /// a sibling session.
    #[test]
    fn another_device_is_not_a_sibling_session() {
        let state = state();
        let _here = register(&state, KEY, 1);
        let _elsewhere = register(&state, "user-1:device-2", 2);

        assert!(!state.remove_session(KEY, 1));
        assert!(
            state
                .connected_users
                .lock()
                .unwrap()
                .contains_key("user-1:device-2")
        );
    }

    /// Removing a connection that is not registered answers "offline" rather than
    /// panicking - the guard runs on every exit path, including one that never
    /// completed registration.
    #[test]
    fn removing_an_unknown_connection_is_not_an_error() {
        let state = state();

        assert!(!state.remove_session(KEY, 99));
    }
}
