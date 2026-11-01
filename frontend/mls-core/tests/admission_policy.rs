//! Admission policy: the rule that names an entry no member made into a CLOSED group (a
//! conversation) - and, since the owner's decision of 2026-10-31, the proof that it REFUSES NOTHING.
//!
//! The server holds every GroupInfo and accepts every commit, so a server under hostile control can
//! build an external commit for an identity of its choosing and hand it to every member. #2815
//! refused such a commit unmerged and froze the group; legitimate paths produce exactly that commit
//! (a skipped KeyPackage, a swept or evicted only leaf), so the rule is DISARMED: the verdict is
//! computed and logged, and the commit is MERGED as before (`mls-core` `admission.rs`).
//!
//! The rule is a PURE FUNCTION OF (the tree at the commit's base epoch, the commit): two honest
//! members at the same epoch hold the same tree, so they reach the same verdict whenever each of
//! them processes the commit. Nothing else is read.
//!
//! - A member (`Sender::Member`) may add anyone: a human invitation, signed by the member's leaf.
//! - An external commit is `Admitted` by a closed group's rule only if its user ALREADY has a leaf in
//!   the pre-commit tree: a new device of a member, or a device rejoining after losing its state.
//!   Any other is `Uninvited` - and merged, while the rule is disarmed.
//! - Three states. A group nobody classified keeps the behaviour it always had; the app opens a
//!   key-distribution group, whose members enter by external commit by design, and closes nothing
//!   while the rule is disarmed. An `open` choice survives a save and a reload; a `closed` one is
//!   dropped at load (no build writes it any more), and `forget_group` forgets either.
//!
//! The one case this policy cannot name is a device FORGED under an existing member's identity:
//! a `BasicCredential` binds nothing, so only a device endorsement signed by one of that user's
//! leaves can tell it apart. It is the `#[ignore]`d test at the end.
use mls_core::{AdmissionPolicy, AdmissionVerdict, MlsManager, judge_external_commit};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// alice creates a conversation group and adds bob by an ordinary member Add.
fn conversation_alice_bob(gid: &str) -> (MlsManager, MlsManager) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_c, welcome, _added, _skipped) = alice.add_members_bulk(gid, &[&kp_bob]).expect("add bob");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");
    // The app classifies a conversation as closed on every device that holds it.
    alice.set_admission_policy(gid, AdmissionPolicy::Closed);
    bob.set_admission_policy(gid, AdmissionPolicy::Closed);
    (alice, bob)
}

/// `who` builds an external commit against the GroupInfo `source` exports - which is exactly what
/// a server holding that GroupInfo can do for any identity it likes.
fn external_commit_from(source: &MlsManager, gid: &str, who: &mut MlsManager) -> Vec<u8> {
    let group_info = source.export_group_info(gid).expect("export group_info");
    let (_gid, commit) = who
        .join_by_external_commit(&group_info)
        .expect("external commit is buildable by anyone holding the GroupInfo");
    commit
}

fn sorted_identities(m: &MlsManager, gid: &str) -> Vec<String> {
    let mut ids = m.member_identities(gid).expect("member identities");
    ids.sort();
    ids
}

/// The group still works for the members it had: alice sends, bob reads.
fn assert_still_converged(alice: &mut MlsManager, bob: &mut MlsManager, gid: &str) {
    let ciphertext = alice.send_message(gid, b"still us").expect("alice sends");
    let plaintext = bob
        .process_incoming_message(gid, &ciphertext)
        .expect("bob decrypts")
        .expect("application message");
    assert_eq!(plaintext, b"still us");
}

/// The rule's verdict on `entrant` entering `gid` by external commit, judged on `member`'s CURRENT
/// tree - which is the pre-commit tree when it is asked before the commit is processed.
fn verdict_on(member: &MlsManager, gid: &str, entrant: &str) -> AdmissionVerdict {
    judge_external_commit(
        member.admission_policy(gid),
        &sorted_identities(member, gid),
        Some(entrant),
    )
}

#[test]
fn an_external_commit_by_a_user_absent_from_the_tree_is_merged_while_the_rule_is_disarmed() {
    // THE OWNER'S DECISION OF 2026-10-31: refusing this commit froze the conversation for every
    // legitimate self-rejoin (a skipped KeyPackage, a swept or evicted only leaf). The verdict still
    // names it, and every member MERGES it - the same epoch, the same roster, still converged.
    let gid = "g-admission-intruder";
    let (mut alice, mut bob) = conversation_alice_bob(gid);
    let epoch_before = alice.get_epoch(gid).expect("epoch");

    let mut mallory = make_device("mallory", "dev1");
    let commit = external_commit_from(&alice, gid, &mut mallory);
    assert_eq!(
        verdict_on(&alice, gid, "mallory:dev1"),
        AdmissionVerdict::Uninvited(Some("mallory:dev1".to_string())),
        "the rule still names the entry no member made"
    );

    for (name, member) in [("alice", &mut alice), ("bob", &mut bob)] {
        member
            .process_incoming_message(gid, &commit)
            .unwrap_or_else(|e| panic!("{name} must merge it while the rule is disarmed: {e:?}"));
        assert_eq!(
            member.get_epoch(gid).expect("epoch"),
            epoch_before + 1,
            "{name}: the commit advanced the epoch"
        );
        assert!(
            sorted_identities(member, gid).contains(&"mallory:dev1".to_string()),
            "{name}: the entrant holds a leaf"
        );
    }

    assert_still_converged(&mut alice, &mut bob, gid);
}

#[test]
fn the_verdict_names_the_identity_it_judged() {
    // The line a user and an operator both read: WHICH identity entered.
    let gid = "g-admission-named";
    let (_alice, bob) = conversation_alice_bob(gid);
    assert_eq!(
        verdict_on(&bob, gid, "mallory:dev7"),
        AdmissionVerdict::Uninvited(Some("mallory:dev7".to_string()))
    );
    assert_eq!(
        judge_external_commit(Some(AdmissionPolicy::Closed), &[], None),
        AdmissionVerdict::Uninvited(None),
        "an unreadable credential cannot be vouched for"
    );
}

#[test]
fn a_member_add_of_a_new_user_is_accepted() {
    // A human invitation: built and signed by a member's own device.
    let gid = "g-admission-member-add";
    let (mut alice, mut bob) = conversation_alice_bob(gid);
    let carol = make_device("carol", "dev1");
    let kp_carol = carol.generate_key_package().expect("kp carol");

    let (commit, _welcome, _added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_carol])
        .expect("alice adds carol");
    alice.merge_pending_commit_for(gid).expect("merge");

    bob.process_incoming_message(gid, &commit)
        .expect("a member's Add is accepted");
    assert!(
        sorted_identities(&bob, gid).contains(&"carol:dev1".to_string()),
        "carol is in bob's tree"
    );
}

#[test]
fn an_external_commit_by_a_new_device_of_an_existing_user_is_accepted() {
    let gid = "g-admission-new-device";
    let (mut alice, _bob) = conversation_alice_bob(gid);
    let mut bob_phone = make_device("bob", "dev2");
    let commit = external_commit_from(&alice, gid, &mut bob_phone);
    assert_eq!(
        verdict_on(&alice, gid, "bob:dev2"),
        AdmissionVerdict::Admitted
    );

    alice
        .process_incoming_message(gid, &commit)
        .expect("bob already has a leaf, so his new device may enter");
    assert!(sorted_identities(&alice, gid).contains(&"bob:dev2".to_string()));
}

#[test]
fn a_device_rejoining_after_losing_its_state_is_accepted() {
    // The recovery ladder's rung 2: the same identity, a fresh instance, its old leaf still in the
    // tree. The rule reads the PRE-commit tree, where that leaf stands.
    let gid = "g-admission-rejoin";
    let (mut alice, _bob) = conversation_alice_bob(gid);
    let mut bob_reinstalled = make_device("bob", "dev1");
    let commit = external_commit_from(&alice, gid, &mut bob_reinstalled);
    assert_eq!(
        verdict_on(&alice, gid, "bob:dev1"),
        AdmissionVerdict::Admitted
    );

    alice
        .process_incoming_message(gid, &commit)
        .expect("a member's own device rejoining is accepted");
}

// ---- The legitimate paths that produce an entry no member made (review of #2817) ---------------
//
// One named test each. Every one is the commit #2815 refused and froze on; each must be MERGED, the
// group must stay converged, and the verdict still names it (the `[UNINVITED_ENTRY]` count the
// fix-forward is read on).

/// `entrant` lets itself into `gid` from `alice`'s base; alice (and `others`) merge the commit, and
/// the entrant can read what alice sends next.
fn merged_and_converged(
    alice: &mut MlsManager,
    others: &mut [&mut MlsManager],
    entrant: &mut MlsManager,
    entrant_id: &str,
    gid: &str,
) {
    let commit = external_commit_from(alice, gid, entrant);
    assert_eq!(
        verdict_on(alice, gid, entrant_id),
        AdmissionVerdict::Uninvited(Some(entrant_id.to_string())),
        "the rule still names it"
    );
    entrant
        .merge_pending_commit_for(gid)
        .expect("the entrant's join is accepted");
    alice
        .process_incoming_message(gid, &commit)
        .expect("alice merges it");
    for other in others.iter_mut() {
        other
            .process_incoming_message(gid, &commit)
            .expect("every member merges it");
    }
    let ciphertext = alice
        .send_message(gid, b"welcome back")
        .expect("alice sends");
    let plaintext = entrant
        .process_incoming_message(gid, &ciphertext)
        .expect("the entrant decrypts")
        .expect("application message");
    assert_eq!(plaintext, b"welcome back");
}

#[test]
fn a_1_1_peer_whose_key_package_was_skipped_at_creation_enters_and_is_merged() {
    // alice created the 1:1 while bob had no usable KeyPackage, so the tree holds alice alone and
    // bob's first device enters by its own external commit - the 1:1 IS that peer.
    let gid = "g-legit-skipped-kp";
    let mut alice = make_device("alice", "dev1");
    alice.create_group(gid.to_string()).expect("create");
    alice.set_admission_policy(gid, AdmissionPolicy::Closed);
    let mut bob = make_device("bob", "dev1");
    merged_and_converged(&mut alice, &mut [], &mut bob, "bob:dev1", gid);
}

#[test]
fn a_user_whose_only_device_was_revoked_and_swept_comes_back_and_is_merged() {
    // bob's only device was revoked, so a member's stray sweep removed its leaf; bob's new device
    // holds no leaf of its user any more.
    let gid = "g-legit-swept";
    let (mut alice, _bob) = conversation_alice_bob(gid);
    alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("the sweep removes the revoked leaf");
    alice.merge_pending_commit_for(gid).expect("merge");
    let mut bob_new = make_device("bob", "dev2");
    merged_and_converged(&mut alice, &mut [], &mut bob_new, "bob:dev2", gid);
}

#[test]
fn a_user_whose_only_leaf_was_evicted_on_a_standing_seat_rejoins_and_is_merged() {
    // bob's only leaf was evicted (a duplicate-leaf repair, a fork heal) while his roster seat still
    // stands (`unhonoured-seat`): the same device id rejoins with no leaf of its user in the tree.
    let gid = "g-legit-evicted";
    let (mut alice, _bob) = conversation_alice_bob(gid);
    let mut carol = make_device("carol", "dev1");
    let kp = carol.generate_key_package().expect("kp");
    let (_c, welcome, _a, _s) = alice.add_members_bulk(gid, &[&kp]).expect("add carol");
    alice.merge_pending_commit_for(gid).expect("merge");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    carol
        .process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("carol joins");
    let eviction = {
        let (commit, _base) = alice
            .remove_members_for_devices(gid, &["bob:dev1"])
            .expect("evict bob's only leaf");
        commit
    };
    alice.merge_pending_commit_for(gid).expect("merge");
    carol
        .process_incoming_message(gid, &eviction)
        .expect("carol merges the eviction");
    let mut bob_again = make_device("bob", "dev1");
    merged_and_converged(
        &mut alice,
        &mut [&mut carol],
        &mut bob_again,
        "bob:dev1",
        gid,
    );
}

#[test]
fn the_verdict_is_the_same_for_a_member_that_processes_it_late() {
    // Determinism across desynchronised members: bob is one commit behind when the intruder's
    // commit is built. He catches up by replaying alice's legitimate Add, then meets the intruder's
    // commit at the same epoch alice did - and must reach the same verdict.
    let gid = "g-admission-late";
    let (mut alice, mut bob) = conversation_alice_bob(gid);
    let carol = make_device("carol", "dev1");
    let kp_carol = carol.generate_key_package().expect("kp carol");
    let (add_carol, _w, _a, _s) = alice
        .add_members_bulk(gid, &[&kp_carol])
        .expect("add carol");
    alice.merge_pending_commit_for(gid).expect("merge");

    let mut mallory = make_device("mallory", "dev1");
    let intrusion = external_commit_from(&alice, gid, &mut mallory);

    let alice_verdict = verdict_on(&alice, gid, "mallory:dev1");
    alice
        .process_incoming_message(gid, &intrusion)
        .expect("alice merges it");
    bob.process_incoming_message(gid, &add_carol)
        .expect("bob replays the legitimate Add");
    let bob_verdict = verdict_on(&bob, gid, "mallory:dev1");
    bob.process_incoming_message(gid, &intrusion)
        .expect("bob merges it late");

    assert_eq!(alice_verdict, bob_verdict);
    assert!(matches!(alice_verdict, AdmissionVerdict::Uninvited(_)));
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        bob.get_epoch(gid).expect("epoch"),
        "both merged it, at the same epoch"
    );
}

#[test]
fn a_leaf_of_one_user_never_vouches_for_another_user() {
    // The rule is per USER in the pre-commit tree, never "someone already entered this way".
    let gid = "g-admission-chain";
    let (alice, mut bob) = conversation_alice_bob(gid);
    let mut mallory = make_device("mallory", "dev1");
    let first = external_commit_from(&alice, gid, &mut mallory);
    bob.process_incoming_message(gid, &first)
        .expect("merged while the rule is disarmed");

    assert!(matches!(
        verdict_on(&bob, gid, "eve:dev1"),
        AdmissionVerdict::Uninvited(_)
    ));
    assert_eq!(
        verdict_on(&bob, gid, "mallory:dev2"),
        AdmissionVerdict::Admitted,
        "mallory now holds a leaf, so a further device of hers is a member's device"
    );
}

#[test]
fn a_group_nobody_classified_keeps_merging_external_commits() {
    // Every group of a state written before this field, until a session classifies it: closing it by
    // default would make the background engine refuse every community newcomer right after an
    // update, before the app ever ran.
    let gid = "g-admission-unclassified";
    let mut alice = make_device("alice", "dev1");
    alice.create_group(gid.to_string()).expect("create");
    assert_eq!(alice.admission_policy(gid), None, "nobody classified it");

    let mut carol = make_device("carol", "dev1");
    let commit = external_commit_from(&alice, gid, &mut carol);
    alice
        .process_incoming_message(gid, &commit)
        .expect("an unclassified group merges the external commit, as before");
}

#[test]
fn an_opened_key_distribution_group_accepts_a_new_user_by_external_commit() {
    // The community key group: its roster is social-service's, and its members enter by external
    // commit by design. The app opens it on every device that holds it.
    let gid = "g-admission-key-group";
    let (mut alice, _bob) = conversation_alice_bob(gid);
    alice.set_admission_policy(gid, AdmissionPolicy::Open);

    let mut carol = make_device("carol", "dev1");
    let commit = external_commit_from(&alice, gid, &mut carol);
    alice
        .process_incoming_message(gid, &commit)
        .expect("an open group accepts a new user's external commit");
}

#[test]
fn an_open_classification_survives_a_reload_and_a_closed_one_is_dropped() {
    // An `open` key group must stay open across a restart. A `closed` conversation is a dev build's
    // leftover (review of #2817): nothing classifies one any more, and the verdict it produced would
    // WARN on every legitimate join - so the load drops it.
    let gid = "g-admission-reload";
    let (mut alice, _bob) = conversation_alice_bob(gid);
    alice.set_admission_policy("g-admission-reload-key", AdmissionPolicy::Open);
    let snapshot = alice.save_state().expect("save");

    let restored = MlsManager::load_or_create("alice", "dev1", Some(snapshot)).expect("reload");
    assert_eq!(
        restored.admission_policy(gid),
        None,
        "a closed classification is dropped at load"
    );
    assert_eq!(
        restored.admission_policy("g-admission-reload-key"),
        Some(AdmissionPolicy::Open),
        "a policy set before the group exists is kept too"
    );
}

#[test]
fn a_classification_made_after_a_save_is_in_the_next_save() {
    // The state is cached between saves and rebuilt only when something marks it dirty: a policy set
    // after a save that did not, would be lost at the next restart - a conversation silently
    // reopened.
    let gid = "g-admission-resave";
    let (mut alice, _bob) = conversation_alice_bob(gid);
    alice.save_state().expect("first save fills the cache");
    alice.set_admission_policy("g-admission-resave-key", AdmissionPolicy::Open);
    let snapshot = alice.save_state().expect("second save");

    let restored = MlsManager::load_or_create("alice", "dev1", Some(snapshot)).expect("reload");
    assert_eq!(
        restored.admission_policy("g-admission-resave-key"),
        Some(AdmissionPolicy::Open)
    );
}

#[test]
fn forgetting_a_group_forgets_its_classification() {
    // Review of #2817: the map is bounded by the groups held, not by every group ever held. A key
    // group healed by forget-and-re-Welcome is opened again where it is registered.
    let gid = "g-admission-forget";
    let (mut alice, _bob) = conversation_alice_bob(gid);
    alice.set_admission_policy("g-admission-forget-key", AdmissionPolicy::Open);
    alice.forget_group(gid, 0);
    assert_eq!(alice.admission_policy(gid), None);
    assert_eq!(
        alice.admission_policy("g-admission-forget-key"),
        Some(AdmissionPolicy::Open),
        "only the forgotten group's entry goes"
    );
    let restored =
        MlsManager::load_or_create("alice", "dev1", Some(alice.save_state().expect("save")))
            .expect("reload");
    assert_eq!(
        restored.admission_policy(gid),
        None,
        "and the next save says so"
    );
}

#[test]
fn classifying_one_group_leaves_the_others_alone() {
    let (mut alice, _bob) = conversation_alice_bob("g-admission-open-one");
    alice
        .create_group("g-admission-other".to_string())
        .expect("second group");
    alice.set_admission_policy("g-admission-open-one", AdmissionPolicy::Open);
    assert_eq!(alice.admission_policy("g-admission-other"), None);
    assert_eq!(
        alice.admission_policy("g-admission-open-one"),
        Some(AdmissionPolicy::Open)
    );
}

#[test]
fn the_wire_names_round_trip() {
    for policy in [AdmissionPolicy::Closed, AdmissionPolicy::Open] {
        assert_eq!(AdmissionPolicy::parse(policy.as_str()), Some(policy));
    }
    assert_eq!(AdmissionPolicy::parse("unclassified"), None);
    assert_eq!(AdmissionPolicy::parse(""), None);
}

#[test]
#[ignore = "needs a device endorsement (design (b)): a BasicCredential binds `userId:deviceId` to nothing, \
            so a server can mint a device under an existing member's identity and this policy admits it"]
fn a_device_forged_under_an_existing_members_identity_is_refused() {
    // What a hostile server does once the rule above exists: it does not need its own account, it
    // mints `bob:forged` and builds the external commit itself. Nothing bob's real devices signed
    // vouches for it. Today this is indistinguishable from `an_external_commit_by_a_new_device_of_
    // an_existing_user_is_accepted`; the endorsement is what will separate the two.
    let gid = "g-admission-forged";
    let (alice, _bob) = conversation_alice_bob(gid);
    assert!(matches!(
        verdict_on(&alice, gid, "bob:forged"),
        AdmissionVerdict::Uninvited(_)
    ));
}
