//! THE PURGE WAS HALF DONE FOR THE LIFE OF THE INSTALL: THE SERVER FORGOT, THE DEVICE DID NOT.
//!
//! `republishKeyMaterial` deletes every published one-time prekey and mints up to fifty more, once
//! per 30 s during a `NoMatchingKeyPackage` storm. The server end of that is complete. The local end
//! never existed - nothing dropped the private bundles of the pool just abandoned - so each round
//! left fifty bundles of ~2 364 bytes behind for the 84 days until their lifetimes elapsed.
//!
//! Measured on a Mi 9T on 2026-09-09: `KeyPackage 3051x7214310B` of a 10 676 363-byte state, **2782
//! of them one-time against a pool of fifty**, about fifty-six rounds' worth, and `0 expired` - not
//! one byte of it reclaimable that day by the prune that already runs.
//!
//! ## The safety argument, which is the whole of this file
//!
//! `prune_key_packages_expired_at` refuses to delete on "the server no longer has it", and is right
//! to: the delivery service DELETES the row as it hands it out, so that signal cannot tell "a peer
//! is about to send a Welcome built on this" from "its owner revoked it". The two want opposite
//! treatment and one of them loses a join.
//!
//! A row the server deletes ON ITS OWNER'S INSTRUCTION is different in kind. It was still in the
//! pool at that instant, and being in the pool is the same as never having been handed out - the
//! hand-out is what removes it. So nothing holds it and nothing can build a Welcome on it.
//!
//! That argument lives entirely in WHERE THE LIST COMES FROM, which is why `forget_key_packages`
//! takes one and never derives one. These tests assert both halves: that it forgets what it is
//! given, and that it cannot be talked into reaching anything else.
use mls_core::MlsManager;

fn device(user: &str) -> MlsManager {
    MlsManager::load_or_create(user, "forget-test", None).expect("create the device")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_secs()
}

#[test]
fn what_the_server_says_it_deleted_is_what_goes() {
    let m = device("alice-forget");
    let pool = m.generate_key_packages(10).expect("a pool of 10");
    m.generate_last_resort_key_package().expect("a fallback");

    let before = m.key_package_census_at(now()).expect("census");
    assert_eq!(before.one_time, 10);

    // The shape of a purge: the server reports the rows it removed, which are the ones it still
    // held - never the ones it had already handed out.
    let outcome = m.forget_key_packages(&pool[..6]).expect("forget");

    assert_eq!(
        outcome.forgotten, 6,
        "every payload named a bundle this device held"
    );
    assert_eq!(outcome.not_held, 0);
    assert_eq!(outcome.unreadable, 0);

    let after = m.key_package_census_at(now()).expect("census");
    assert_eq!(
        after.one_time, 4,
        "the four the server did not name must survive"
    );
    assert_eq!(
        after.last_resort, 1,
        "and the fallback is not a one-time prekey"
    );
}

#[test]
fn a_package_the_server_did_not_name_is_untouched() {
    let m = device("alice-untouched");
    let pool = m.generate_key_packages(5).expect("a pool");

    // THIS IS THE HANDED-OUT CASE, and it is the reason the list is a parameter. A prekey a peer
    // fetched is already gone from the server, so a sweep deriving its own set from "absent
    // server-side" would delete exactly this bundle - and the Welcome built on it would then have
    // no private half to open it. Naming only what the purge removed is what spares it.
    let purged = &pool[..4];
    let handed_out = &pool[4];

    m.forget_key_packages(purged).expect("forget");

    assert!(
        m.key_package_has_private(handed_out).expect("ask"),
        "a bundle the purge did not name must still be openable when its Welcome arrives"
    );
}

#[test]
fn forgetting_twice_is_not_an_error_and_is_reported_apart() {
    let m = device("alice-twice");
    let pool = m.generate_key_packages(3).expect("a pool");

    let first = m.forget_key_packages(&pool).expect("forget");
    assert_eq!(first.forgotten, 3);

    // A retry after a dropped response must not look like a fresh sweep. `not_held` is what tells
    // "already done" from "this device never had them", and the second is a keystore that has
    // diverged from what it published - worth more than the bytes.
    let second = m.forget_key_packages(&pool).expect("forget again");
    assert_eq!(second.forgotten, 0, "nothing is left to forget");
    assert_eq!(
        second.not_held, 3,
        "and that fact is reported, not silently a clean sweep"
    );
}

#[test]
fn rubbish_is_counted_and_never_fatal() {
    let m = device("alice-rubbish");
    let pool = m.generate_key_packages(2).expect("a pool");

    let mut batch: Vec<Vec<u8>> = vec![b"not a key package at all".to_vec(), vec![0u8; 4]];
    batch.extend(pool.iter().cloned());

    // Maintenance running behind a purge that already succeeded. A device that cannot parse one
    // stale payload still works, and failing the batch would leave the good half unreclaimed.
    let outcome = m
        .forget_key_packages(&batch)
        .expect("must not fail the batch");
    assert_eq!(outcome.forgotten, 2, "the readable half is still reclaimed");
    assert_eq!(
        outcome.unreadable, 2,
        "and the rest is counted rather than swallowed"
    );
}

#[test]
fn a_held_last_resort_is_offered_back_instead_of_a_fresh_mint() {
    let m = device("alice-reuse");

    assert!(
        m.existing_last_resort_key_package(now())
            .expect("ask")
            .is_none(),
        "a device holding nothing must be told to mint"
    );

    let minted = m.generate_last_resort_key_package().expect("a fallback");
    let offered = m
        .existing_last_resort_key_package(now())
        .expect("ask")
        .expect("the one just minted");

    assert_eq!(
        offered, minted,
        "republishing must offer the very package the device already holds - reuse is what the \
         LastResort extension MEANS, and it is why the delivery service can serve one package to \
         every peer that finds the pool empty"
    );
}

#[test]
fn an_expired_fallback_is_not_offered_and_a_one_time_never_is() {
    let m = device("alice-stale");
    m.generate_key_packages(6)
        .expect("a pool of ordinary prekeys");
    m.generate_last_resort_key_package().expect("a fallback");

    const DAY: u64 = 60 * 60 * 24;
    assert!(
        m.existing_last_resort_key_package(now() + 100 * DAY)
            .expect("ask")
            .is_none(),
        "publishing an elapsed package would have every peer entitled to refuse the Welcome built \
         on it, so past its lifetime the device must mint"
    );

    // And the six ordinary prekeys must never be mistaken for a fallback: an ordinary bundle dies
    // with the first Welcome built on it, so the second peer served it could never join.
    let m2 = device("alice-onetime-only");
    m2.generate_key_packages(6).expect("a pool");
    assert!(
        m2.existing_last_resort_key_package(now())
            .expect("ask")
            .is_none(),
        "a pool of ordinary prekeys is not a fallback, however many of them there are"
    );
}
