//! A periodic leaf refresh (an empty commit WITH a path) for post-compromise security.
//!
//! Until 2026-10-22 no device here ever updated its own leaf, so a device whose leaf secrets leaked
//! once could keep deriving every later epoch's path secrets until somebody removed it. These pin
//! what the refresh has to be for the rest of the product to treat it as harmless:
//!
//! - it is STAGED like every other commit here ([[C7]] Option A): the epoch moves on the server's
//!   answer, never before - so a refused refresh leaves no fork;
//! - it replaces the committer's leaf and NOTHING ELSE: the tree names the same identities before
//!   and after, on both sides, so a peer that applies it has no departure and no arrival to react to;
//! - the leaf it produces carries no KeyPackage lifetime, which is how the caller tells a refreshed
//!   leaf from one still holding the key material it was ADMITTED with.
use mls_core::{MlsError, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs()
}

/// alice creates `gid` and adds bob; both end at epoch 1.
fn alice_and_bob(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_c, welcome, _added, _skipped) = alice.add_members_bulk(gid, &[&kp_bob]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");
    (alice, bob)
}

#[test]
fn a_self_update_is_staged_then_merged_and_the_peer_follows_it() {
    let gid = "g-refresh";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let epoch = bob.get_epoch(gid).expect("epoch");

    let (commit, base) = bob.stage_self_update(gid).expect("stage self update");
    assert!(
        !base.is_empty(),
        "the successor base travels with the commit (COMM-22)"
    );
    assert_eq!(
        bob.get_epoch(gid).expect("epoch"),
        epoch,
        "staging must not advance the epoch (validate-then-merge)"
    );

    bob.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(bob.get_epoch(gid).expect("epoch"), epoch + 1);

    // The peer applies it like any commit, and it carries no application payload.
    let applied = alice
        .process_incoming_message(gid, &commit)
        .expect("alice applies the refresh");
    assert!(applied.is_none(), "a refresh is a commit, not a message");
    assert_eq!(alice.get_epoch(gid).expect("epoch"), epoch + 1);

    // And the group still works in both directions at the new epoch.
    let frame = bob
        .send_message(gid, b"after the refresh")
        .expect("bob sends");
    assert_eq!(
        alice
            .process_incoming_message(gid, &frame)
            .expect("alice decrypts")
            .as_deref(),
        Some(&b"after the refresh"[..])
    );
    let back = alice.send_message(gid, b"and back").expect("alice sends");
    assert_eq!(
        bob.process_incoming_message(gid, &back)
            .expect("bob decrypts")
            .as_deref(),
        Some(&b"and back"[..])
    );
}

#[test]
fn a_self_update_changes_no_membership_on_either_side() {
    // THE PROPERTY EVERY DOWNSTREAM CONSUMER RESTS ON: a refresh is neither a departure nor an
    // arrival. Anything that reacts to a membership change (a Graine seed rotation on a key group,
    // a "joined" or "left" line, the stray-leaf collector) must find nothing to do.
    let gid = "g-refresh-members";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let before_alice = alice.member_identities(gid).expect("alice tree");
    let before_bob = bob.member_identities(gid).expect("bob tree");

    let (commit, _base) = bob.stage_self_update(gid).expect("stage");
    bob.merge_pending_commit_for(gid).expect("merge");
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice applies");

    assert_eq!(
        alice.member_identities(gid).expect("alice tree"),
        before_alice
    );
    assert_eq!(bob.member_identities(gid).expect("bob tree"), before_bob);
}

#[test]
fn the_refreshed_leaf_no_longer_carries_its_admission_lifetime() {
    // A leaf admitted from a KeyPackage carries that package's lifetime, whose `not_before` dates
    // the key material. After a refresh the leaf comes from a commit and carries none - which is
    // how the caller can tell "never refreshed, minted at T" from "refreshed since".
    let gid = "g-refresh-age";
    let (_alice, mut bob) = alice_and_bob(gid);

    let minted = bob
        .own_leaf_minted_at(gid)
        .expect("readable")
        .expect("an admitted leaf carries its KeyPackage lifetime");
    let now = now_secs();
    assert!(
        minted <= now + 5 && minted + 120 >= now,
        "minted {minted} should be about now ({now}): not_before is backdated by the openmls margin, which this undoes"
    );

    let _ = bob.stage_self_update(gid).expect("stage");
    // Still the admitted leaf while the commit is only staged.
    assert_eq!(bob.own_leaf_minted_at(gid).expect("readable"), Some(minted));
    bob.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(
        bob.own_leaf_minted_at(gid).expect("readable"),
        None,
        "the merged refresh replaced the leaf"
    );
}

#[test]
fn a_creator_leaf_is_dated_until_its_own_commit_replaces_it() {
    // The group's creator never processed a Welcome; its leaf is dated by the package it was built
    // from - until the creator commits. A commit this device makes carries a path (openmls includes
    // one in every member commit it builds), so the Add that brought bob in ALREADY refreshed
    // alice's leaf, and her leaf reads as refreshed from then on.
    let gid = "g-refresh-creator";
    let mut alice = make_device("alice", "dev1");
    let bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    assert!(
        alice.own_leaf_minted_at(gid).expect("readable").is_some(),
        "a creator leaf carries a lifetime"
    );

    let kp_bob = bob.generate_key_package().expect("kp bob");
    let _ = alice.add_members_bulk(gid, &[&kp_bob]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    assert_eq!(
        alice.own_leaf_minted_at(gid).expect("readable"),
        None,
        "the committer's own path replaced its leaf"
    );
}

#[test]
fn a_remove_commit_refreshes_the_committer_leaf_too() {
    // Why the caller records a refresh after EVERY commit of its own, not only after a self-update:
    // a Remove carries a path, so the committer's leaf is new key material at that epoch.
    let gid = "g-refresh-remove";
    let (_alice, mut bob) = alice_and_bob(gid);
    assert!(bob.own_leaf_minted_at(gid).expect("readable").is_some());
    let _ = bob
        .remove_members_for_devices(gid, &["alice:dev1"])
        .expect("stage remove");
    bob.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(bob.own_leaf_minted_at(gid).expect("readable"), None);
}

#[test]
fn the_own_leaf_key_names_the_leaf_only_this_device_commits_replace_it() {
    // The refresh ledger keys each date on this key, so a date written for a former leaf (a write an
    // unclean exit lost after the merge reached disk) is never read as the age of the current one.
    // That only holds if the key moves on OUR merged commits and on nothing else.
    let gid = "g-refresh-key";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let admitted = bob
        .own_leaf_encryption_key(gid)
        .expect("readable")
        .expect("a member has a leaf");

    let (commit, _base) = bob.stage_self_update(gid).expect("stage");
    assert_eq!(
        bob.own_leaf_encryption_key(gid).expect("readable").as_ref(),
        Some(&admitted),
        "a staged commit has not replaced the leaf yet"
    );
    bob.merge_pending_commit_for(gid).expect("merge");
    let refreshed = bob
        .own_leaf_encryption_key(gid)
        .expect("readable")
        .expect("still a member");
    assert_ne!(refreshed, admitted, "the merged refresh replaced the leaf");
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice applies");

    // Another member's commit - a path of hers - leaves our leaf as it was.
    let (theirs, _base) = alice.stage_self_update(gid).expect("alice stages");
    alice.merge_pending_commit_for(gid).expect("alice merges");
    bob.process_incoming_message(gid, &theirs)
        .expect("bob applies");
    assert_eq!(
        bob.own_leaf_encryption_key(gid).expect("readable").as_ref(),
        Some(&refreshed),
        "a peer's commit does not touch this device's leaf"
    );
    assert!(matches!(
        bob.own_leaf_encryption_key("g-unknown"),
        Err(MlsError::GroupNotFound(_))
    ));
}

#[test]
fn a_refused_self_update_clears_cleanly_and_can_be_staged_again() {
    let gid = "g-refresh-refused";
    let (_alice, mut bob) = alice_and_bob(gid);
    let epoch = bob.get_epoch(gid).expect("epoch");
    let minted = bob.own_leaf_minted_at(gid).expect("readable");

    let _ = bob.stage_self_update(gid).expect("stage");
    bob.clear_pending_commit_for(gid)
        .expect("the server refused: clear");
    assert_eq!(bob.get_epoch(gid).expect("epoch"), epoch, "no fork");
    assert_eq!(
        bob.own_leaf_minted_at(gid).expect("readable"),
        minted,
        "the leaf is the one it was before the refused refresh"
    );

    let _ = bob
        .stage_self_update(gid)
        .expect("stage again after a refusal");
    bob.merge_pending_commit_for(gid).expect("merge");
    assert_eq!(bob.get_epoch(gid).expect("epoch"), epoch + 1);
}

#[test]
fn a_self_update_is_refused_while_another_commit_is_pending() {
    // One staged commit at a time: the second would overwrite the first one's pending state and the
    // server's answer would then merge the wrong commit.
    let gid = "g-refresh-pending";
    let (mut alice, _bob) = alice_and_bob(gid);
    let _ = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("stage a remove");
    assert!(alice.stage_self_update(gid).is_err());
}

#[test]
fn a_self_update_keeps_every_identity_and_signature_key_so_the_graine_run_continues() {
    // What a Graine run reads as a DEPARTURE is a Remove, or an `(identity, signature key)` pair
    // leaving the tree; an external commit is an arrival. A refresh is a member commit with no
    // proposal and does not rotate the signature key, so every pair is the same before and after,
    // on the committer and on the peer that applies it - and a seed must not rotate for it.
    let gid = "g-refresh-graine";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let pairs = |m: &MlsManager| -> Vec<(String, Vec<u8>)> {
        m.member_identities(gid)
            .expect("tree")
            .into_iter()
            .map(|id| {
                let key = m
                    .member_signature_key(gid, &id)
                    .expect("readable")
                    .expect("a leaf for every identity");
                (id, key)
            })
            .collect()
    };
    let before_alice = pairs(&alice);
    let before_bob = pairs(&bob);
    assert_eq!(before_alice, before_bob, "one tree, seen from both sides");

    let (commit, _base) = bob.stage_self_update(gid).expect("stage");
    bob.merge_pending_commit_for(gid).expect("merge");
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice applies");

    assert_eq!(pairs(&bob), before_bob, "the committer keeps every pair");
    assert_eq!(pairs(&alice), before_alice, "the peer sees no pair leave");
}

#[test]
fn the_own_context_matches_the_base_published_for_the_same_epoch_on_the_same_branch() {
    let gid = "g-refresh-base";
    let (mut alice, bob) = alice_and_bob(gid);
    // The base the server serves for the current epoch: any member's export of it.
    let published = alice.export_group_info(gid).expect("alice's base");
    assert!(
        bob.own_context_matches_base(gid, &published)
            .expect("comparable")
    );
    assert!(
        alice
            .own_context_matches_base(gid, &published)
            .expect("comparable")
    );

    // A base of an older epoch is not this device's context.
    let _ = alice.stage_self_update(gid).expect("stage");
    alice.merge_pending_commit_for(gid).expect("merge");
    assert!(
        !alice
            .own_context_matches_base(gid, &published)
            .expect("comparable")
    );
}

#[test]
fn a_device_forked_at_the_same_epoch_number_does_not_match_the_published_base() {
    // THE FORK THE EPOCH GATE CANNOT SEE: both devices merged a DIFFERENT commit from epoch 1, so
    // both are at epoch 2 and the server's number check would accept either one's next commit. The
    // published base (here alice's branch) carries the transcript and tree hashes of epoch 2 as the
    // server has it, and bob's own context differs from it.
    let gid = "g-refresh-fork";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let _ = alice.stage_self_update(gid).expect("alice stages");
    alice.merge_pending_commit_for(gid).expect("alice merges");
    let _ = bob.stage_self_update(gid).expect("bob stages");
    bob.merge_pending_commit_for(gid)
        .expect("bob merges, never seeing alice's");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        bob.get_epoch(gid).expect("epoch"),
        "same epoch number on both branches"
    );

    let published = alice.export_group_info(gid).expect("alice's base");
    assert!(
        alice
            .own_context_matches_base(gid, &published)
            .expect("comparable")
    );
    assert!(
        !bob.own_context_matches_base(gid, &published)
            .expect("comparable"),
        "the forked device must not see its context as the published one"
    );
}

#[test]
fn a_base_that_does_not_parse_is_an_error_not_a_verdict() {
    let gid = "g-refresh-garbage";
    let (alice, _bob) = alice_and_bob(gid);
    assert!(matches!(
        alice.own_context_matches_base(gid, b"not a group info"),
        Err(MlsError::InvalidData)
    ));
    assert!(matches!(
        alice.own_context_matches_base("nope", b"x"),
        Err(MlsError::GroupNotFound(_))
    ));
}

#[test]
fn a_staged_commit_whose_answer_was_lost_survives_a_reload_and_merges_afterwards() {
    // An UNANSWERED commit is kept pending, durably, until a resubmission settles it - possibly at
    // the next connection, after a restart. So the pending commit must live in the saved state, and
    // the reloaded device must be able to merge it (the resubmission says accepted) and the peer
    // must then still follow it.
    let gid = "g-refresh-reload";
    let (mut alice, mut bob) = alice_and_bob(gid);
    let epoch = bob.get_epoch(gid).expect("epoch");
    let (commit, _base) = bob.stage_self_update(gid).expect("stage");
    let saved = bob.save_state().expect("save with the commit pending");

    let mut reloaded =
        MlsManager::load_or_create("bob", "dev1", Some(saved.clone())).expect("reload");
    assert_eq!(
        reloaded.get_epoch(gid).expect("epoch"),
        epoch,
        "still pending"
    );
    assert!(
        reloaded.stage_self_update(gid).is_err(),
        "the pending commit is still there, so a second one is refused"
    );
    reloaded
        .merge_pending_commit_for(gid)
        .expect("merged after the reload");
    assert_eq!(reloaded.get_epoch(gid).expect("epoch"), epoch + 1);
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice applies it");
    let frame = reloaded.send_message(gid, b"after").expect("send");
    assert_eq!(
        alice
            .process_incoming_message(gid, &frame)
            .expect("decrypt")
            .as_deref(),
        Some(&b"after"[..])
    );

    // And the other answer: a reloaded device can clear it just as well.
    let mut again = MlsManager::load_or_create("bob", "dev1", Some(saved)).expect("reload");
    again
        .clear_pending_commit_for(gid)
        .expect("cleared after the reload");
    assert_eq!(again.get_epoch(gid).expect("epoch"), epoch);
}

#[test]
fn a_self_update_on_an_unknown_group_is_a_typed_absence() {
    let mut alice = make_device("alice", "dev1");
    assert!(matches!(
        alice.stage_self_update("nope"),
        Err(MlsError::GroupNotFound(_))
    ));
    assert!(matches!(
        alice.own_leaf_minted_at("nope"),
        Err(MlsError::GroupNotFound(_))
    ));
}
