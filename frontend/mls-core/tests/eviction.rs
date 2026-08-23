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
//! FOUR PATHS REACH AN EVICTED DEVICE, and all four are pinned here because the fix is only a fix
//! if all four agree:
//!
//!   - the COMMIT, which is where the fact becomes knowable and free (`is_group_active`);
//!   - the SEND, for a device that never received that commit - typed, not a sentence
//!     (`MlsError::Evicted`), so a permanent failure cannot be read as a transient one;
//!   - the RECEIVE, for a frame still routed to a group we are out of. Unclassified it read as
//!     "out of sync", which asked to be re-added to a group we were deliberately removed from and
//!     then learnt from a 403 what the frame itself already proved;
//!   - the RECEIVE OF A LATER EPOCH, which is the SAME frame arriving after the group has committed
//!     again - and the commonest shape of it, because a group does not stop moving when it loses a
//!     member. The epoch-gap fast-fail sits before the decryption that would reveal the eviction,
//!     so this path answered "gap" and reached the same out-of-sync policy by a different road.
use mls_core::{DecryptErrorKind, MlsError, MlsManager};

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

#[test]
fn a_frame_arriving_after_eviction_is_typed_evicted_not_an_out_of_sync() {
    // THE THIRD PATH, and the one that cost the most. A frame still reaches the removed device -
    // in flight when the commit landed, or routed by the server registry the removal cleans
    // best-effort - and `process_message` refuses it because the group is inactive.
    //
    // Unclassified, that refusal was a bare `Process error:`, which the frontend reads as
    // `SenderRatchetGap`/`unknown` and answers with its out-of-sync policy: `requestReAdd`, asking
    // the server to undo a moderation action, followed by a request for the group's commits that
    // can only ever return 403 - learning from a refusal what this very frame already proved.
    let gid = "g-evict-recv";
    let (mut alice, mut bob) = pair(gid);
    let commit = evict_bob(&mut alice, gid);
    bob.process_incoming_message(gid, &commit).expect("applies");

    // alice keeps talking to the group bob is no longer in.
    let frame = alice
        .send_message(gid, b"members only")
        .expect("alice sends");
    let err = bob
        .process_incoming_message(gid, &frame)
        .expect_err("bob cannot read a group he is not in");

    assert!(
        matches!(err, MlsError::Evicted(ref g) if g == gid),
        "expected MlsError::Evicted({gid}), got {err:?}"
    );
    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::Evicted,
        "native and web classify through decrypt_kind and classifyIncomingDecryptError \
         respectively; the two must not be able to disagree about this one"
    );
}

#[test]
fn eviction_is_classified_before_the_generic_process_error_arm() {
    // Order matters here exactly as it does for the four arms already documented in
    // `decrypt_kind`. A frame refused for eviction IS a process error, so a generic arm reached
    // first would classify it `SenderRatchetGap` - the retryable kind - and native would write a
    // row into `pending_mls_messages` for a frame that can never decrypt, on every frame the group
    // still routes. This pins the precedence rather than trusting the arm order to survive edits.
    let raw = MlsError::OpenMls("Process error: GroupStateError(UseAfterEviction)".into());
    assert_eq!(
        raw.decrypt_kind(),
        DecryptErrorKind::SenderRatchetGap,
        "the raw wording is deliberately NOT what carries the meaning - the variant is"
    );
    assert_eq!(
        MlsError::Evicted("g".into()).decrypt_kind(),
        DecryptErrorKind::Evicted
    );
}

#[test]
fn a_later_epoch_frame_after_eviction_is_evicted_not_an_epoch_gap() {
    // THE FOURTH PATH, and the one the other three hid. The receive arm above is reached only for a
    // frame at OUR epoch: the epoch-gap fast-fail returns first for anything ahead of it, before
    // any decryption that could reveal the eviction. And a group keeps committing after it drops a
    // member, so being ahead is the NORMAL state of every frame that still reaches the removed
    // device - the classified path was the exception, not the rule.
    //
    // "Gap" then read as out-of-sync, which is `requestReAdd` against a deliberate removal plus a
    // commit request that can only 403. `is_active()` is local state and already false, so nothing
    // had to be attempted to know better.
    let gid = "g-evict-later-epoch";
    let (mut alice, mut bob) = pair(gid);
    let commit = evict_bob(&mut alice, gid);
    bob.process_incoming_message(gid, &commit).expect("applies");

    // The group moves on without bob: one more commit, so alice is now an epoch ahead of him.
    let carol = make_device("carol", "dev1");
    let kp = carol.generate_key_package().expect("kp");
    alice
        .add_members_bulk(gid, &[kp.as_slice()])
        .expect("add carol");
    alice
        .merge_pending_commit_for(gid)
        .expect("merge add carol");

    let frame = alice
        .send_message(gid, b"members only, one epoch later")
        .expect("alice sends");
    let err = bob
        .process_incoming_message(gid, &frame)
        .expect_err("bob cannot read a group he is not in");

    assert!(
        matches!(err, MlsError::Evicted(ref g) if g == gid),
        "a frame from a LATER epoch is still an eviction, not a gap to recover from: {err:?}"
    );
    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::Evicted,
        "an epoch gap is the retryable kind; charging this frame to it asks the server to undo a          moderation action, once per frame the group still routes"
    );
}

#[test]
fn a_later_epoch_frame_in_a_group_we_are_still_in_is_still_a_gap() {
    // The other half, and the one that keeps the hoist honest: eviction is now decided before the
    // gap, so a genuine gap must survive that. A member who simply missed a commit is exactly the
    // case the fast-fail exists for, and misreading it as an eviction would retire a live
    // conversation on a recoverable condition.
    let gid = "g-gap-still-member";
    let (mut alice, mut bob) = pair(gid);

    // alice commits without bob hearing about it, then talks at the new epoch.
    let carol = make_device("carol", "dev1");
    let kp = carol.generate_key_package().expect("kp");
    alice
        .add_members_bulk(gid, &[kp.as_slice()])
        .expect("add carol");
    alice
        .merge_pending_commit_for(gid)
        .expect("merge add carol");
    let frame = alice
        .send_message(gid, b"bob missed a commit")
        .expect("send");

    let err = bob
        .process_incoming_message(gid, &frame)
        .expect_err("bob is an epoch behind");

    assert!(
        bob.is_group_active(gid).expect("bob still holds it"),
        "missing a commit does not remove anybody"
    );
    assert!(
        !matches!(err, MlsError::Evicted(_)),
        "a member who missed a commit has a gap to recover, not an eviction: {err:?}"
    );
    assert_eq!(
        err.decrypt_kind(),
        DecryptErrorKind::SenderRatchetGap,
        "the gap is the retryable kind, and must stay retryable"
    );
}
