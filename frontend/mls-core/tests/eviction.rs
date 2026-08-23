//! Being removed from a group, from the removed device's own point of view.
//!
//! The Remove commit NAMES the device it evicts. Applying it is therefore the instant that device
//! could know it is out - and until this was written, that instant produced nothing: the merge
//! answered `Ok(None)`, exactly as any other structural commit does, and the only thing left that
//! could tell the two apart was the next send being refused.
//!
//! That is learning by failing what a fact already stated, and it cost more than a diagnosis. The
//! refusal crossed the FFI boundary as `MlsError::OpenMls("Encrypt error: ... UseAfterEviction")`,
//! indistinguishable from a transient encrypt failure, so the frontend outbox retried it up its
//! whole backoff ladder against a group that would refuse every single attempt.
//!
//! Two things are pinned here, and they are the two halves of the fix: the fact is readable at the
//! commit (`is_group_active`), and the refusal - for the device that never received the commit at
//! all - is a TYPE rather than a sentence (`MlsError::Evicted`).
use mls_core::{MlsError, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// alice creates `gid` with bob in it, and both devices are left at the same epoch.
fn pair(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("alice", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");

    let mut bob = make_device("bob", "dev1");
    let kp = bob.generate_key_package().expect("kp");
    let (_commit, welcome, _added, _skipped) =
        alice.add_members_bulk(gid, &[kp.as_slice()]).expect("add");
    alice.merge_pending_commit_for(gid).expect("merge add");
    let tree = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&tree))
        .expect("bob joins");
    (alice, bob)
}

/// alice removes bob and returns the commit, merged on alice's side.
fn evict_bob(alice: &mut MlsManager, gid: &str) -> Vec<u8> {
    let commit = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("remove bob");
    alice.merge_pending_commit_for(gid).expect("merge remove");
    commit
}

#[test]
fn the_removed_device_reads_its_own_eviction_off_the_commit() {
    let gid = "g-evict-read";
    let (mut alice, mut bob) = pair(gid);

    assert!(
        bob.is_group_active(gid).expect("bob holds the group"),
        "a member is active before anything removes it"
    );

    let commit = evict_bob(&mut alice, gid);
    bob.process_incoming_message(gid, &commit)
        .expect("bob applies the commit that removes him");

    assert!(
        !bob.is_group_active(gid).expect("bob still HOLDS the state"),
        "the Remove commit named this device: applying it is when the eviction becomes knowable, \
         and it must be knowable without attempting a send"
    );
}

#[test]
fn the_remover_stays_active_in_the_group_it_shrank() {
    // The obvious half, and worth pinning: `is_group_active` must answer membership, not "did a
    // Remove commit happen here". A predicate that went false for everyone on any removal would
    // retire the remover's own conversation.
    let gid = "g-evict-remover";
    let (mut alice, _bob) = pair(gid);
    evict_bob(&mut alice, gid);

    assert!(
        alice.is_group_active(gid).expect("alice holds the group"),
        "removing another member does not remove yourself"
    );
}

#[test]
fn holding_a_group_and_being_in_it_are_different_questions() {
    // The removed device still HOLDS local state for the group - which is precisely why the
    // frontend's `getLocalGroups().includes(id)` stayed true after an eviction and let the outbox
    // conclude the group was sendable.
    let gid = "g-evict-held";
    let (mut alice, mut bob) = pair(gid);
    let commit = evict_bob(&mut alice, gid);
    bob.process_incoming_message(gid, &commit).expect("applies");

    assert!(
        bob.get_known_groups().contains(&gid.to_string()),
        "the state is still held after an eviction - it is simply no longer usable"
    );
    assert!(!bob.is_group_active(gid).expect("held"), "and not a member");
}

#[test]
fn a_group_never_joined_is_an_error_not_an_eviction() {
    // Never-joined and removed-from are opposite facts and only one of them retires a conversation.
    // Answering `false` for an unheld group would retire every conversation not yet loaded.
    let alice = make_device("alice", "dev1");
    assert!(
        matches!(
            alice.is_group_active("g-never-created"),
            Err(MlsError::GroupNotFound(_))
        ),
        "an unheld group is an error, never `not a member`"
    );
}

#[test]
fn a_send_after_eviction_is_typed_evicted_not_a_generic_encrypt_error() {
    // The backstop, for a device that was offline across the whole removal and sends before it
    // drains its inbox: it never applied the commit, so `is_group_active` cannot help and OpenMLS
    // refuses the send. That refusal must arrive as a TYPE. Carried as `OpenMls(String)` it was
    // read as transient - the one classification that turns a permanent failure into a retry loop.
    let gid = "g-evict-send";
    let (mut alice, mut bob) = pair(gid);
    let commit = evict_bob(&mut alice, gid);
    bob.process_incoming_message(gid, &commit).expect("applies");

    let err = bob
        .send_message(gid, b"nobody will ever read this")
        .expect_err("an evicted device cannot encrypt for the group");

    assert!(
        matches!(err, MlsError::Evicted(ref g) if g == gid),
        "expected MlsError::Evicted({gid}), got {err:?}"
    );
    // The token is the contract across both FFI boundaries: `classifyOutgoingSendError` reads it,
    // and the outbox fails the entry permanently on it.
    assert!(
        err.to_string().starts_with("EVICTED: "),
        "the discriminator must survive the string-only WASM/Tauri boundary, got {err}"
    );
}

#[test]
fn a_healthy_member_sends_normally() {
    // Guards the arm above against the other kind of mistake: classifying too much as an eviction.
    let gid = "g-evict-control";
    let (_alice, mut bob) = pair(gid);
    assert!(
        bob.send_message(gid, b"hello").is_ok(),
        "a member still in the group encrypts as before"
    );
}
