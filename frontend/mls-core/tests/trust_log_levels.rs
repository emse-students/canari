//! THE LEVEL A LINE IS LOGGED AT IS PART OF ITS CONTRACT: an expected case at ERROR is noise a
//! reader learns to skip, and an inconsistency at WARN is one nobody looks at. These pin the levels
//! of the device-trust paths, read from a logger that records each line with the thread that wrote
//! it (the tests of this file run in parallel in one process).

use std::sync::{Mutex, OnceLock};
use std::thread::ThreadId;

use ciborium::{de::from_reader, ser::into_writer};
use log::{Level, LevelFilter, Log, Metadata, Record};
use mls_core::{MlsManager, PersistedState};

struct Capture(Mutex<Vec<(ThreadId, Level, String)>>);

impl Log for Capture {
    fn enabled(&self, _: &Metadata) -> bool {
        true
    }
    fn log(&self, record: &Record) {
        self.0.lock().unwrap().push((
            std::thread::current().id(),
            record.level(),
            format!("{} {}", record.target(), record.args()),
        ));
    }
    fn flush(&self) {}
}

fn capture() -> &'static Capture {
    static CAPTURE: OnceLock<&'static Capture> = OnceLock::new();
    CAPTURE.get_or_init(|| {
        let c: &'static Capture = Box::leak(Box::new(Capture(Mutex::new(Vec::new()))));
        log::set_logger(c).expect("one logger");
        log::set_max_level(LevelFilter::Trace);
        c
    })
}

/// Every line THIS thread logged at `level` or more severe, from mls-core.
fn lines_at(level: Level) -> Vec<String> {
    let me = std::thread::current().id();
    capture()
        .0
        .lock()
        .unwrap()
        .iter()
        .filter(|(t, l, m)| *t == me && *l <= level && m.starts_with("mls_core"))
        .map(|(_, _, m)| m.clone())
        .collect()
}

fn device(user: &str, dev: &str) -> MlsManager {
    MlsManager::load_or_create(user, dev, None).expect("device")
}

/// A MEMBER'S COMMIT REACHING A DEVICE WHOSE EXTERNAL JOIN IS STILL PENDING is an ordinary race:
/// both commits were built on the same epoch, and the joiner's group already stands at the epoch its
/// own join creates, so the member's commit reads as a PAST handshake - dropped as `Ok(None)`,
/// nothing merged. It is not an error, and nothing logs it at WARN or above.
#[test]
fn a_commit_racing_a_pending_external_join_is_not_an_error() {
    capture();
    let gid = "g-race-ext-join";
    let mut alice = device("alice", "dev1");
    let mut bob = device("bob", "dev1");
    alice.create_group(gid.into()).expect("create");
    let kp = bob.generate_key_package().unwrap();
    let ((_, welcome, _, _), _) = alice
        .add_members_bulk_with_base(gid, &[&kp], &["bob:dev1"])
        .expect("add");
    alice.merge_pending_commit_for(gid).expect("merge");
    let tree = alice.export_ratchet_tree_for(gid).unwrap();
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&tree))
        .expect("join");
    let info = alice.export_group_info(gid).expect("info");

    let mut carol = device("carol", "dev1");
    carol.join_by_external_commit(&info).expect("stage join");
    let (commit, _) = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("remove");
    alice.merge_pending_commit_for(gid).expect("merge");

    let before = lines_at(Level::Warn).len();
    let epoch = carol.get_epoch(gid).unwrap();
    let outcome = carol.process_incoming_message(gid, &commit);
    assert!(matches!(outcome, Ok(None)), "{outcome:?}");
    assert_eq!(carol.get_epoch(gid).unwrap(), epoch, "nothing merged");
    assert_eq!(
        lines_at(Level::Warn).len(),
        before,
        "{:?}",
        lines_at(Level::Warn)
    );
}

/// A PERSISTED PIN NOT KEYED CANONICALLY cannot have been written by this code: dropping it is an
/// inconsistency in the sealed state, said at ERROR.
#[test]
fn a_dropped_non_canonical_pin_is_an_error() {
    capture();
    let alice = device("alice", "dev1");
    let mut state: PersistedState = from_reader(alice.save_state().unwrap().as_slice()).unwrap();
    let mut odd = state.device_pins[0].clone();
    odd.identity = "ALICE:dev1".into();
    state.device_pins.push(odd);
    state.device_pins_pruned.push("BOB:dev1".into());
    let mut bytes = Vec::new();
    into_writer(&state, &mut bytes).unwrap();
    MlsManager::load_or_create("alice", "dev1", Some(bytes)).expect("reload");

    let errors = lines_at(Level::Error);
    assert!(
        errors.iter().any(|l| l.contains("ALICE:dev1")),
        "the pin drop is an ERROR: {errors:?}"
    );
    assert!(
        errors.iter().any(|l| l.contains("BOB:dev1")),
        "the pruned drop is an ERROR: {errors:?}"
    );
}
