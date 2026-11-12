use crate::audience::PresenceAudience;
use redis::Client as RedisClient;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, atomic::AtomicU64};
use tokio::sync::mpsc;

/// Alias for the per-connection outbound channel sender.
/// Each live WebSocket connection owns one of these; the pub/sub loop clones
/// and stores senders here so it can push frames without holding the lock.
type ConnectedUser = mpsc::Sender<String>;

/// Live sockets this process holds at most, all accounts together. Not yet set against a measured
/// peak: the census (`GET /api/admin/presence/history?window=30d`) is the reading owed, see
/// `docs/wiki/services/chat-gateway.md`.
pub const MAX_CONNECTIONS: usize = 1_000;

/// Devices one account may enrol: chat-delivery's `MAX_DEVICES_PER_USER`
/// (`apps/chat-delivery-service/src/retention.constants.ts`), which is the source; a test reads
/// both and fails when they differ.
pub const MAX_DEVICES_PER_ACCOUNT: usize = 15;

/// Live sockets one ACCOUNT holds at most on this process, all its devices together.
///
/// THIS IS THE ONLY BOUND ON AN ACCOUNT: a socket's `device_id` is chosen by its client, so a
/// limit per device would bound nothing. What it has to leave room for:
///
/// - one socket per device, not per tab - only the leader tab of a browser connects;
/// - the sockets a device has not released yet: on a flapping link a device can hold three or four
///   that the gateway has not declared dead (about a minute each, the heartbeat's tolerance);
/// - the busiest account measured (2026-09-12) had 6 live devices, so 6 x 4 = 24 fits;
/// - every device an account may enrol with one socket and its replacement (2 x 15 = 30), which
///   the assertion below holds.
pub const MAX_CONNECTIONS_PER_ACCOUNT: usize = 32;

const _: () = assert!(MAX_CONNECTIONS_PER_ACCOUNT >= 2 * MAX_DEVICES_PER_ACCOUNT);

/// The subject a full PROCESS is counted under in [`AppState::refused_admissions`]: one line for
/// it, not one per account it turned away.
pub const PROCESS_REFUSAL_SUBJECT: &str = "process";

/// Drop the senders of `key` whose socket is gone, and the key with them when none is left.
///
/// ONLY A CLOSED SENDER LEAVES THE MAP. A sender that is merely FULL belongs to a live socket that
/// is slow to read; that socket still holds its place, and [`AppState::admit`] counts the map, so
/// removing it here would let its account pass the limit while the socket lives.
///
/// Returns `true` when the device has no live sender left on this process.
pub fn prune_closed_senders(
    connected_users: &Mutex<HashMap<String, HashMap<u64, ConnectedUser>>>,
    key: &str,
) -> bool {
    let mut map = connected_users.lock().unwrap();
    let Some(senders) = map.get_mut(key) else {
        return true;
    };
    senders.retain(|_, sender| !sender.is_closed());
    if senders.is_empty() {
        map.remove(key);
        return true;
    }
    false
}

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
    /// Says a subject's refused sockets once, then at each power of ten of their count
    /// ([`AppState::note_refusal`]); a subject is forgotten when it is admitted with room to spare
    /// ([`AppState::admit`]), so a later episode is said from its first refusal again.
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
        let active = senders.len();
        drop(map);
        self.note_session_caps(conn_id, declared);
        // A REFUSAL EPISODE ENDS WHEN ITS SUBJECT IS ADMITTED WITH ROOM TO SPARE - a fact, not a
        // delay. "With room to spare" because a subject sitting AT its limit is admitted each time
        // one of its sockets leaves and refused again at once: that is one episode, not many.
        if held_by_account + 1 < self.max_connections_per_account {
            self.refused_admissions.forget(user_id);
        }
        if held + 1 < self.max_connections {
            self.refused_admissions.forget(PROCESS_REFUSAL_SUBJECT);
        }
        Ok(active)
    }

    /// Count one refusal, and answer its ordinal when it is worth a line (the 1st, 10th, 100th...
    /// of its episode). The subject is the ACCOUNT for an account at its limit, and the process
    /// itself when the process is full.
    pub fn note_refusal(&self, user_id: &str, refusal: &AdmissionRefusal) -> Option<u64> {
        let subject = match refusal {
            AdmissionRefusal::Account { .. } => user_id,
            AdmissionRefusal::Process { .. } => PROCESS_REFUSAL_SUBJECT,
        };
        self.refused_admissions.hit(subject)
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

    /// The device limit is chat-delivery's, and this crate holds a copy: both are read here, so a
    /// change of one without the other fails. Read at RUN time from the checkout - the gateway's
    /// own build context does not hold the other service.
    #[test]
    fn the_device_limit_is_chat_deliverys() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../chat-delivery-service/src/retention.constants.ts");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} is not readable: {e}", path.display()));

        let expected = format!("export const MAX_DEVICES_PER_USER = {MAX_DEVICES_PER_ACCOUNT};");
        assert!(
            source.lines().any(|line| line == expected),
            "{} no longer holds the line `{expected}`",
            path.display()
        );
    }

    #[test]
    fn a_full_channel_keeps_its_place_and_a_closed_one_leaves() {
        let mut state = state();
        state.max_connections_per_account = 2;
        let (slow_tx, _slow_rx) = mpsc::channel::<String>(1);
        slow_tx.try_send("fills the channel".to_string()).unwrap();
        assert!(slow_tx.try_send("refused: full".to_string()).is_err());
        let (gone_tx, gone_rx) = mpsc::channel::<String>(1);
        let caps = crate::addressing::SessionCaps::default;
        state.admit("user-1", KEY, 1, slow_tx, caps()).unwrap();
        state.admit("user-1", KEY, 2, gone_tx, caps()).unwrap();
        drop(gone_rx);

        let all_gone = prune_closed_senders(&state.connected_users, KEY);

        assert!(!all_gone);
        let (one_more, _a) = ask(&state, "user-1", "device-2", 3);
        assert_eq!(one_more, Ok(1));
        // The slow socket is still counted: the account is at its limit of two.
        let (refused, _b) = ask(&state, "user-1", "device-3", 4);
        assert_eq!(refused, Err(AdmissionRefusal::Account { held: 2 }));
    }

    #[test]
    fn a_device_with_no_sender_left_is_gone() {
        let state = state();
        let (tx, rx) = mpsc::channel::<String>(1);
        state
            .admit(
                "user-1",
                KEY,
                1,
                tx,
                crate::addressing::SessionCaps::default(),
            )
            .unwrap();
        drop(rx);

        assert!(prune_closed_senders(&state.connected_users, KEY));
        assert!(state.connected_users.lock().unwrap().is_empty());
        assert!(prune_closed_senders(
            &state.connected_users,
            "user-9:never-seen"
        ));
    }

    #[test]
    fn a_second_episode_of_refusals_is_said_from_its_first() {
        let mut state = state();
        state.max_connections_per_account = 2;
        let at_limit = AdmissionRefusal::Account { held: 2 };
        let (_first, _a) = ask(&state, "user-1", "device-1", 1);
        let (_second, _b) = ask(&state, "user-1", "device-2", 2);
        assert_eq!(state.note_refusal("user-1", &at_limit), Some(1));
        assert_eq!(state.note_refusal("user-1", &at_limit), None);

        // One socket leaves and the account takes the place back: it is AT its limit again, the
        // same episode.
        state.remove_session("user-1:device-2", 2);
        let (_again, _c) = ask(&state, "user-1", "device-2", 3);
        assert_eq!(state.note_refusal("user-1", &at_limit), None);

        // Both leave, and it is admitted with room to spare: the episode is over.
        state.remove_session("user-1:device-1", 1);
        state.remove_session("user-1:device-2", 3);
        let (_fresh, _d) = ask(&state, "user-1", "device-1", 4);

        assert_eq!(state.note_refusal("user-1", &at_limit), Some(1));
    }

    #[test]
    fn a_full_process_is_one_subject_whatever_the_account() {
        let mut state = state();
        state.max_connections = 2;
        let full = AdmissionRefusal::Process { held: 2 };
        let (_first, _a) = ask(&state, "user-1", "device-1", 1);
        let (_second, _b) = ask(&state, "user-2", "device-1", 2);

        assert_eq!(state.note_refusal("user-3", &full), Some(1));
        assert_eq!(state.note_refusal("user-4", &full), None);
        // Neither account was counted under its own name.
        assert_eq!(
            state.note_refusal("user-4", &AdmissionRefusal::Account { held: 32 }),
            Some(1)
        );

        // The process empties and admits with room to spare: its episode is over.
        state.remove_session("user-1:device-1", 1);
        state.remove_session("user-2:device-1", 2);
        let (_fresh, _c) = ask(&state, "user-5", "device-1", 3);

        assert_eq!(state.note_refusal("user-6", &full), Some(1));
    }

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
