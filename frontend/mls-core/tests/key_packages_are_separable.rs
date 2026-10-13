//! CAN THE KEYPACKAGE PILE LEAVE THE BLOB EVERY CHECKPOINT REWRITES? These are the two facts that
//! answer it, as ASSERTIONS - `heavy_state_checkpoint.rs` measures what it would save.
//!
//! A bundle (`KeyPackage` label: the package, its init private key, its leaf private key) is written
//! once when minted and only ever deleted, yet the whole map is re-encoded and re-sealed on every
//! checkpoint (`state.rs` `serialize_state`). Writing it as its own segment, rewritten only when it
//! changes, is safe only if:
//!
//! 1. **No group needs a bundle once its Welcome is processed.** openmls 0.9 `StagedWelcome::into_group`
//!    copies the bundle's leaf key into the GROUP's `EpochKeyPairs`, so a joined group must keep
//!    working - receive a commit encrypted to that leaf, send, reload - with every `KeyPackage` row
//!    gone. If this failed, a segment written later than the main blob could lose a group.
//! 2. **A bundle that is missing when its Welcome arrives costs THAT join, and nothing else.** This
//!    is the crash between "minted and published" and "segment on disk"; it fixes the write order
//!    (segment durable BEFORE the package is published) and names what breaking it would cost.
//!
//! See `docs/wiki/open-questions.md` ("should the KeyPackage pile leave the blob").
use mls_core::MlsManager;

const DAY: u64 = 60 * 60 * 24;

fn device(user: &str) -> MlsManager {
    MlsManager::load_or_create(user, "d", None).unwrap_or_else(|e| panic!("{user}: {e}"))
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_secs()
}

/// Every `KeyPackage` row, whatever its kind - an instant past every lifetime deletes them all.
fn drop_every_key_package(m: &MlsManager) {
    m.prune_key_packages_expired_at(now() + 100 * DAY)
        .expect("prune");
    assert_eq!(
        m.key_package_count().expect("count"),
        0,
        "no bundle is left"
    );
}

#[test]
fn a_group_joined_by_welcome_needs_no_key_package_row_afterwards() {
    let mut alice = device("alice");
    let mut bob = device("bob");
    let carol = device("carol");
    alice.create_group("g".to_string()).expect("create");

    // The LAST-RESORT package is the hard case: `into_group` keeps its row after the join, so this
    // is the row a split would most plausibly be tempted to treat as still in use.
    let bob_kp = bob
        .generate_last_resort_key_package()
        .expect("bob's fallback");
    bob.generate_key_packages(5).expect("unrelated prekeys");
    let (_, welcome, _, _) = alice
        .add_members_bulk("g", &[&bob_kp.public[..]])
        .expect("add bob");
    alice.merge_pending_commit_for("g").expect("merge");
    let tree = alice.export_ratchet_tree_for("g").expect("tree");
    bob.process_welcome(welcome.as_deref().expect("welcome"), Some(&tree))
        .expect("bob joins");

    // Every bundle gone, then a reload - what a device would load if the segment were lost.
    drop_every_key_package(&bob);
    let snapshot = bob.save_state().expect("save");
    let mut bob = MlsManager::load_or_create("bob", "d", Some(snapshot)).expect("reload");

    // A commit WITH A PATH encrypts its path secret to bob's leaf key - the key that came from the
    // bundle. Adding then removing carol forces one (a Remove always carries a path).
    let carol_kp = carol.generate_key_package().expect("carol kp");
    let (add, _, _, _) = alice
        .add_members_bulk("g", &[&carol_kp[..]])
        .expect("add carol");
    alice.merge_pending_commit_for("g").expect("merge add");
    bob.process_incoming_message("g", &add)
        .expect("bob applies the add");
    let (remove, _) = alice
        .remove_members_for_devices("g", &["carol:d"])
        .expect("remove carol");
    alice.merge_pending_commit_for("g").expect("merge remove");
    bob.process_incoming_message("g", &remove)
        .expect("bob decrypts a path encrypted to the leaf key his bundle carried");

    // And both directions still ratchet.
    let from_alice = alice.send_message("g", b"to bob").expect("alice sends");
    bob.process_incoming_message("g", &from_alice)
        .expect("bob reads alice");
    let from_bob = bob.send_message("g", b"to alice").expect("bob sends");
    alice
        .process_incoming_message("g", &from_bob)
        .expect("alice reads bob");
}

#[test]
fn a_bundle_missing_when_its_welcome_arrives_costs_that_join_and_nothing_else() {
    let mut alice = device("alice2");
    let mut bob = device("bob2");
    bob.create_group("bob-own".to_string())
        .expect("a group bob already has");
    alice.create_group("g2".to_string()).expect("create");

    // Published, then lost before it reached disk: the crash a segment written AFTER publishing
    // would allow.
    let bob_kp = bob.generate_key_package().expect("bob kp");
    drop_every_key_package(&bob);

    let (_, welcome, _, _) = alice
        .add_members_bulk("g2", &[&bob_kp[..]])
        .expect("add bob");
    alice.merge_pending_commit_for("g2").expect("merge");
    let tree = alice.export_ratchet_tree_for("g2").expect("tree");
    assert!(
        bob.process_welcome(welcome.as_deref().expect("welcome"), Some(&tree))
            .is_err(),
        "a Welcome built on a bundle this device no longer holds cannot be opened"
    );

    // What it did NOT cost: the groups bob already had.
    bob.send_message("bob-own", b"still here")
        .expect("an unrelated group is untouched");
}
