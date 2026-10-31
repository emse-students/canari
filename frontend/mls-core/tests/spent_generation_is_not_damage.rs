//! A FRAME READ TWICE IS A DUPLICATE, NOT A DAMAGED FRAME, AND NOT A FORK QUESTION.
//!
//! OpenMLS refuses the second read of a frame with `SecretReuseError`, and it reaches that only
//! after opening the frame's sender data with this epoch's secret - so the frame was sealed under
//! our own tree and its bytes are intact. The same-epoch refusal arm used to judge a fork claim for
//! it anyway, find the claim agreeing, and say at WARN that "the frame itself is damaged" (DUP-2,
//! 2026-10-25: a joiner's re-fetch after its Welcome re-read a frame live delivery had just read).
//!
//! These pin both halves: the duplicate is still REPORTED as `SecretReuse` to every caller, and it
//! writes nothing at WARN or above; a frame whose bytes really are damaged keeps its WARN. The
//! logger records each line with the thread that wrote it (the tests of this file run in parallel).

use std::sync::{Mutex, OnceLock};
use std::thread::ThreadId;

use log::{Level, LevelFilter, Log, Metadata, Record};
use mls_core::fork_check::ForkFindingKind;
use mls_core::{DecryptErrorKind, MlsManager};

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

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

fn pair_in_group(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_, welcome, _added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob])
        .expect("add bob to group");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");
    (alice, bob)
}

#[test]
fn a_frame_read_twice_is_reported_as_spent_and_says_nothing_at_warn() {
    capture();
    let gid = "g-spent-not-damaged";
    let (mut alice, mut bob) = pair_in_group(gid);
    let frame = alice.send_message(gid, b"read twice").expect("send");
    bob.process_incoming_message(gid, &frame)
        .expect("first read")
        .expect("application");

    let err = bob
        .process_incoming_message(gid, &frame)
        .expect_err("the second read of a frame is refused");
    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::SecretReuse,
        "every caller classifies the duplicate on this kind: {err}"
    );
    assert!(
        bob.take_fork_findings().is_empty(),
        "a spent generation is not a fork question"
    );
    let loud = lines_at(Level::Warn);
    assert!(
        loud.is_empty(),
        "an expected duplicate is not a WARN, and certainly not 'damaged': {loud:?}"
    );
}

#[test]
fn a_damaged_frame_keeps_its_warning() {
    // The control: the arm above must catch the spent generation and nothing else. A flipped byte
    // fails the AEAD, the claim in the clear agrees with ours, and THAT is a damaged frame.
    capture();
    let gid = "g-damaged-still-warns";
    let (mut alice, mut bob) = pair_in_group(gid);
    let mut frame = alice.send_message(gid, b"to be damaged").expect("send");
    let last = frame.len() - 1;
    frame[last] ^= 0x55;
    let err = bob
        .process_incoming_message(gid, &frame)
        .expect_err("a damaged frame is refused");
    assert_ne!(err.decrypt_kind(), DecryptErrorKind::SecretReuse, "{err}");
    let findings = bob.take_fork_findings();
    assert!(
        findings.iter().all(|f| f.kind != ForkFindingKind::Fork),
        "{findings:?}"
    );
    let loud = lines_at(Level::Warn);
    assert!(
        loud.iter()
            .any(|l| l.contains("the frame itself is damaged")),
        "a frame whose bytes are bad still says so: {loud:?}"
    );
}
