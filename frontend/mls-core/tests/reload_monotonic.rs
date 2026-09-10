//! Tests for the epoch-monotonic reload invariant (`reload_is_monotonic`, C2): a reloaded snapshot
//! must never regress a live group's epoch, nor make a live group disappear. Native mirror of
//! `swapClientMonotonic` on the WASM/TS side.
use mls_core::MlsManager;

fn make(user: &str, dev: &str) -> MlsManager {
    MlsManager::load_or_create(user, dev, None).expect("make manager")
}

fn restore(user: &str, dev: &str, snapshot: Vec<u8>) -> MlsManager {
    MlsManager::load_or_create(user, dev, Some(snapshot)).expect("restore manager")
}

#[test]
fn refuses_a_snapshot_that_regresses_a_live_group_epoch() {
    let mut alice = make("rel-alice", "dev1");
    let bob = make("rel-bob", "dev1");
    let gid = "g-reload";
    alice.create_group(gid.to_string()).expect("create");

    // epoch 1: add bob (stage + merge).
    let kp = bob.generate_key_package().expect("kp");
    alice.add_members_bulk(gid, &[&kp]).expect("stage add");
    alice.merge_pending_commit_for(gid).expect("merge add");
    let snapshot_e1 = alice.save_state().expect("snapshot e1");
    assert_eq!(alice.get_epoch(gid).unwrap(), 1);

    // epoch 2: remove bob (stage + merge).
    alice
        .remove_members_for_devices(gid, &["rel-bob:dev1"])
        .expect("stage remove");
    alice.merge_pending_commit_for(gid).expect("merge remove");
    assert_eq!(alice.get_epoch(gid).unwrap(), 2);

    let candidate_e1 = restore("rel-alice", "dev1", snapshot_e1);

    // Live epoch 2 vs candidate epoch 1 -> regression -> refused.
    assert!(
        !alice.reload_is_monotonic(&candidate_e1),
        "an older snapshot (lower epoch) must be refused"
    );
    // The other way round (candidate epoch 1 reloading a live epoch 2) is an advance -> allowed.
    assert!(
        candidate_e1.reload_is_monotonic(&alice),
        "a reload to a higher or equal epoch must be allowed"
    );
}

#[test]
fn refuses_a_snapshot_missing_a_live_group() {
    let mut alice = make("rel-alice2", "dev1");
    let gid = "g-reload2";
    // Snapshot taken BEFORE the group is created (no group at all).
    let snapshot_empty = alice.save_state().expect("empty snapshot");
    alice.create_group(gid.to_string()).expect("create");
    assert_eq!(alice.get_epoch(gid).unwrap(), 0);

    let candidate_empty = restore("rel-alice2", "dev1", snapshot_empty);
    // The live manager holds gid@0; the candidate does not know gid -> disappearance -> refused.
    assert!(
        !alice.reload_is_monotonic(&candidate_empty),
        "a snapshot that loses a live group must be refused"
    );
}

#[test]
fn allows_an_equal_snapshot() {
    let mut alice = make("rel-alice3", "dev1");
    let gid = "g-reload3";
    alice.create_group(gid.to_string()).expect("create");
    let snapshot = alice.save_state().expect("snapshot");
    let candidate = restore("rel-alice3", "dev1", snapshot);
    // Same epoch on both sides -> monotonic (>=) -> allowed.
    assert!(alice.reload_is_monotonic(&candidate));
}

/// THE AXIS THE EPOCH GUARD CANNOT SEE, PINNED AS A MEASUREMENT RATHER THAN AN ARGUMENT.
///
/// The three tests above establish what `reload_is_monotonic` protects: no live group disappears,
/// no live group regresses. This one establishes what it does NOT protect, because that gap is the
/// standing candidate for the prekey purge loop in `docs/wiki/backlog.md` and it had never been
/// written down as a fact.
///
/// A snapshot taken before a connection's mint holds every group at exactly its live epoch, so the
/// guard accepts it - correctly, on its own terms. The keystore it installs is missing all fifty
/// freshly published bundles, and `key_package_has_private` then answers `false` about packages
/// this device minted seconds earlier. That answer is what `reconcilePublishedKeyPackages` reads as
/// "the server holds an orphan" before purging the pool.
#[test]
fn a_snapshot_predating_a_mint_passes_the_epoch_guard_while_losing_every_minted_key_package() {
    let mut alice = make("rel-alice-kp", "dev1");
    let gid = "g-reload-kp";
    alice.create_group(gid.to_string()).expect("create");

    // What the resume path would find on disk had the blob been written before the mint.
    let before_mint = alice.save_state().expect("snapshot before the mint");
    let count_before = alice.key_package_count().expect("count before");

    // Exactly the batch a connection mints when the pool reads as empty.
    let published = alice.generate_key_packages(50).expect("50 prekeys");
    assert_eq!(published.len(), 50);
    assert_eq!(
        alice.key_package_count().expect("count after"),
        count_before + 50,
        "the count must follow a mint, or it cannot witness a loss"
    );

    let candidate = restore("rel-alice-kp", "dev1", before_mint);

    // THE EPOCH GUARD SEES NOTHING WRONG - no group moved, so this reload is accepted today.
    assert!(
        alice.reload_is_monotonic(&candidate),
        "a snapshot predating only a MINT regresses no epoch, so the epoch guard must accept it -          if this ever fails, the guard has grown a second axis and the accusation in          `recharger_mls_au_resume` should become a refusal"
    );

    // AND YET IT DROPS ALL FIFTY. This is the whole finding.
    assert_eq!(
        candidate.key_package_count().expect("candidate count"),
        count_before,
        "the reloaded keystore must be the pre-mint one - otherwise this test proves nothing"
    );

    // Stated as the reconciliation itself would observe it: the installed manager can back none of
    // the packages the device published, so every one of them reads as a server orphan.
    let unrecognised = published
        .iter()
        .filter(|kp| !candidate.key_package_has_private(kp).unwrap_or(false))
        .count();
    assert_eq!(
        unrecognised, 50,
        "all fifty published packages must be unrecognisable to the reloaded manager - this is the          `purged 50/50` line measured on the Mi 9T, reproduced without a phone"
    );
}

/// A SUBSTITUTION LEAVES THE COUNT UNCHANGED, AND THE DETECTOR COMPARED COUNTS.
///
/// The test above drops fifty bundles and adds none, so a cardinality check catches it. The shape
/// measured on the Mi 9T on 2026-09-08 was not that one: `reconcilePublishedKeyPackages` printed
/// `REFUSED to purge 6/50 prekey(s) this session published itself` on two consecutive reconnections
/// (six of the device's own mints unbacked by the installed keystore) while
/// `[RESUME] reload DROPS KEY MATERIAL` did not print once. A keystore that has since dropped six
/// bundles and minted six more holds exactly as many as the snapshot did, and `cand < live` is FALSE
/// on it. The downstream symptom was visible and the detector written for its cause was silent.
///
/// So this builds that state rather than the easy one: expire the first batch out of the live
/// keystore and mint a second of the same size, giving two keystores of EQUAL size with DISJOINT
/// contents. A count says they agree. The set difference names all six, and
/// `key_package_has_private` - the question the reconciliation actually asks - agrees with the set.
#[test]
fn a_same_count_substitution_is_invisible_to_a_count_and_named_by_the_key_set() {
    const NINETY_DAYS: u64 = 90 * 24 * 60 * 60;

    let mut alice = make("rel-alice-sub", "dev1");
    alice
        .create_group("g-reload-sub".to_string())
        .expect("create");

    // Six bundles, then the snapshot the resume path would find on disk.
    let first_batch = alice.generate_key_packages(6).expect("first six");
    let before_swap = alice.save_state().expect("snapshot holding the first six");
    let candidate = restore("rel-alice-sub", "dev1", before_swap);

    // The live keystore moves on: the first six age out and six fresh ones replace them. Pruning
    // BEFORE the second mint is what keeps the sizes equal - the whole point of this test.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after the epoch")
        .as_secs();
    let pruned = alice
        .prune_key_packages_expired_at(now + NINETY_DAYS * 4)
        .expect("prune the first batch");
    assert_eq!(
        pruned, 6,
        "the first six must age out, or there is no substitution to measure"
    );
    let second_batch = alice.generate_key_packages(6).expect("second six");

    let live_keys = alice.key_package_keys().expect("live keys");
    let cand_keys = candidate.key_package_keys().expect("candidate keys");

    // THE COUNT CANNOT SEE IT, AND THIS IS THE DEFECT STATED AS AN ASSERTION. The old guard's
    // condition was `cand < live`; here the two are EQUAL, so it logged nothing on exactly this
    // shape while the reconciliation downstream was refusing to purge six unbacked bundles.
    assert_eq!(
        cand_keys.len(),
        live_keys.len(),
        "the substitution must leave the cardinalities equal - otherwise a count would have caught          it and this test is measuring the easy case again"
    );

    // THE SET DOES. All six the live manager holds are absent from the reloaded one.
    let lost = live_keys.difference(&cand_keys).count();
    assert_eq!(
        lost, 6,
        "the set difference must name the six bundles the reload would drop, where the count said          the two keystores agreed"
    );

    // And it agrees with the question the reconciliation actually asks, which is the whole point:
    // the reloaded manager cannot back what was minted after the snapshot, and can back what it kept.
    let unrecognised_new = second_batch
        .iter()
        .filter(|kp| !candidate.key_package_has_private(kp).unwrap_or(false))
        .count();
    assert_eq!(
        unrecognised_new, 6,
        "every bundle minted after the snapshot must be unrecognisable to the reloaded manager -          this is the `REFUSED to purge 6/50` line, reproduced without a phone"
    );
    let unrecognised_old = first_batch
        .iter()
        .filter(|kp| !candidate.key_package_has_private(kp).unwrap_or(false))
        .count();
    assert_eq!(
        unrecognised_old, 0,
        "the bundles the snapshot DID capture must still be backed - otherwise this is measuring a          restore that lost everything, not a substitution"
    );
}
