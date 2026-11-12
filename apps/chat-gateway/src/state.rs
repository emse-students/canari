use crate::audience::PresenceAudience;
use redis::Client as RedisClient;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::AtomicU64};
use tokio::sync::mpsc;

/// Alias for the per-connection outbound channel sender.
/// Each live WebSocket connection owns one of these; the pub/sub loop clones
/// and stores senders here so it can push frames without holding the lock.
type ConnectedUser = mpsc::Sender<String>;

/// Live sockets this process holds at most, all accounts together.
pub const MAX_CONNECTIONS: usize = 1_000;

/// Live sockets one ACCOUNT holds at most on this process, all its devices together. A person has
/// a few devices and a few tabs; thirty-two leaves room for every one of them and for the overlap
/// of their reconnections.
pub const MAX_CONNECTIONS_PER_ACCOUNT: usize = 32;

/// Why [`AppState::admit`] did not register a socket. Each carries the count that decided.
#[derive(Debug, PartialEq, Eq)]
pub enum AdmissionRefusal {
    /// The account already holds [`AppState::max_connections_per_account`] sockets here.
    Account { held: usize },
    /// The process already holds [`AppState::max_connections`] sockets.
    Process { held: usize },
}

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
    /// Per connection (`conn_id`): what its socket declared ([`crate::addressing::SessionCaps`]).
    /// Read by the pub/sub loop's edge filter ([`crate::addressing::deliverable_sessions`]); the
    /// cross-process fact is the sessions hash.
    pub session_caps: Arc<Mutex<HashMap<u64, crate::addressing::SessionCaps>>>,
    /// [`MAX_CONNECTIONS`] outside tests.
    pub max_connections: usize,
    /// [`MAX_CONNECTIONS_PER_ACCOUNT`] outside tests.
    pub max_connections_per_account: usize,
    /// Says an account's refused sockets once, then at each power of ten of their count.
    pub refused_admissions: crate::log_repeat::RepeatCounter,
    /// This process's identity in the shared sessions hash, so two gateway processes - which both
    /// number their connections from 0 - never write the same session field.
    pub instance_id: String,
    /// HS256 secret used to validate the `canari_ws_token` JWT on upgrade.
    pub jwt_secret: String,
    /// Who may see whose presence: asked of chat-delivery and social-service on every
    /// `POST /api/presence` and its legacy `GET` (WP-PRESENCE).
    pub presence_audience: PresenceAudience,
    /// How many legacy `GET /api/presence` calls this process still serves, reported once per
    /// window - the measurement that decides the route's removal.
    pub legacy_presence_gets: crate::presence::LegacyGetTally,
    /// The sorted set the anonymous census series lives in ([`crate::census::SAMPLES_KEY`] outside
    /// tests, which use a key of their own so they never touch what production reads).
    pub census_key: String,
    /// The coarse (5-minute, 30-day) series of the census ([`crate::census::COARSE_KEY`] outside
    /// tests).
    pub census_coarse_key: String,
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
            max_connections: MAX_CONNECTIONS,
            max_connections_per_account: MAX_CONNECTIONS_PER_ACCOUNT,
            refused_admissions: crate::log_repeat::RepeatCounter::new(4_096),
            instance_id: uuid::Uuid::new_v4().to_string(),
            jwt_secret,
            presence_audience,
            legacy_presence_gets: crate::presence::LegacyGetTally::new(std::time::Instant::now()),
            census_key: crate::census::SAMPLES_KEY.to_string(),
            census_coarse_key: crate::census::COARSE_KEY.to_string(),
        }
    }

    /// Register the socket `conn_id` of `user_id`'s device `conn_key`, or refuse it.
    ///
    /// THE COUNT AND THE INSERTION ARE ONE STEP UNDER THE MAP LOCK, so two sockets arriving
    /// together are judged one after the other and neither limit can be passed. The account is
    /// counted before the process: a refusal names the narrower reason.
    ///
    /// A new socket of a device is added BESIDE its siblings, never replaces them (the
    /// duplicate-connection rule, `handlers::handle_socket`). `declared` is recorded while the lock
    /// is held, so the pub/sub loop never sees this session without its declaration.
    ///
    /// Returns how many sockets the device now holds here.
    pub fn admit(
        &self,
        user_id: &str,
        conn_key: &str,
        conn_id: u64,
        sender: ConnectedUser,
        declared: crate::addressing::SessionCaps,
    ) -> Result<usize, AdmissionRefusal> {
        let mut map = self.connected_users.lock().unwrap();
        let of_account = format!("{user_id}:");
        let mut held_by_account = 0;
        let mut held = 0;
        for (key, senders) in map.iter() {
            held += senders.len();
            if key.starts_with(&of_account) {
                held_by_account += senders.len();
            }
        }
        if held_by_account >= self.max_connections_per_account {
            return Err(AdmissionRefusal::Account {
                held: held_by_account,
            });
        }
        if held >= self.max_connections {
            return Err(AdmissionRefusal::Process { held });
        }
        let senders = map.entry(conn_key.to_string()).or_default();
        senders.insert(conn_id, sender);
        self.note_session_caps(conn_id, declared);
        Ok(senders.len())
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
    pub fn note_session_caps(&self, conn_id: u64, declared: crate::addressing::SessionCaps) {
        self.session_caps.lock().unwrap().insert(conn_id, declared);
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

    /// Ask for a socket; the receiver is returned with the answer so an admitted one stays open.
    fn ask(
        state: &AppState,
        user_id: &str,
        device: &str,
        conn_id: u64,
    ) -> (Result<usize, AdmissionRefusal>, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel::<String>(1);
        let answer = state.admit(
            user_id,
            &format!("{user_id}:{device}"),
            conn_id,
            tx,
            crate::addressing::SessionCaps::default(),
        );
        (answer, rx)
    }

    #[test]
    fn a_socket_is_added_beside_its_siblings_and_counted() {
        let state = state();
        let (first, _a) = ask(&state, "user-1", "device-1", 1);
        let (second, _b) = ask(&state, "user-1", "device-1", 2);

        assert_eq!(first, Ok(1));
        assert_eq!(second, Ok(2));
        assert!(state.session_caps.lock().unwrap().contains_key(&2));
    }

    #[test]
    fn an_account_is_refused_past_its_limit_whatever_the_device() {
        let mut state = state();
        state.max_connections_per_account = 3;
        let _held: Vec<_> = (0..3)
            .map(|i| ask(&state, "user-1", &format!("device-{i}"), i))
            .collect();

        let (refused, _rx) = ask(&state, "user-1", "device-9", 9);

        assert_eq!(refused, Err(AdmissionRefusal::Account { held: 3 }));
        assert!(
            !state
                .connected_users
                .lock()
                .unwrap()
                .contains_key("user-1:device-9")
        );
        assert!(!state.session_caps.lock().unwrap().contains_key(&9));
    }

    #[test]
    fn one_account_at_its_limit_does_not_refuse_another() {
        let mut state = state();
        state.max_connections_per_account = 1;
        let (_first, _a) = ask(&state, "user-1", "device-1", 1);

        // `user-10` starts with `user-1`: an account is told apart by its whole id.
        let (other, _b) = ask(&state, "user-10", "device-1", 2);

        assert_eq!(other, Ok(1));
    }

    #[test]
    fn the_process_is_refused_past_its_limit() {
        let mut state = state();
        state.max_connections = 2;
        let (_x, _a) = ask(&state, "user-1", "device-1", 1);
        let (_y, _b) = ask(&state, "user-2", "device-1", 2);

        let (refused, _rx) = ask(&state, "user-3", "device-1", 3);

        assert_eq!(refused, Err(AdmissionRefusal::Process { held: 2 }));
    }

    #[test]
    fn a_socket_that_left_gives_its_place_back() {
        let mut state = state();
        state.max_connections_per_account = 1;
        let (_first, _a) = ask(&state, "user-1", "device-1", 1);
        state.remove_session(KEY, 1);

        let (again, _b) = ask(&state, "user-1", "device-1", 2);

        assert_eq!(again, Ok(1));
    }

    /// Two sockets asking together are judged one after the other: with one place left, exactly
    /// one of many concurrent askers gets it.
    #[test]
    fn concurrent_askers_never_pass_the_limit() {
        let mut state = state();
        state.max_connections_per_account = 1;
        let state = std::sync::Arc::new(state);

        let askers: Vec<_> = (0..16)
            .map(|i| {
                let state = state.clone();
                std::thread::spawn(move || ask(&state, "user-1", &format!("device-{i}"), i))
            })
            .collect();
        let answers: Vec<_> = askers.into_iter().map(|t| t.join().unwrap()).collect();

        assert_eq!(answers.iter().filter(|(a, _)| a.is_ok()).count(), 1);
    }

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
