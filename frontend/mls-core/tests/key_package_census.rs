//! A COUNT OF KEY PACKAGES NAMES NO REMEDY, AND FOR THREE MONTHS THAT WAS THE ONLY NUMBER THERE WAS.
//!
//! `state_composition` reports `KeyPackage 3050x7211906B` - measured on a Mi 9T on 2026-09-09, two
//! thirds of a 10 673 959-byte state, against a one-time pool the protocol sizes at FIFTY. That one
//! number is at least three facts stacked, and they are not reclaimed by the same thing:
//!
//! - EXPIRED bundles, which `prune_key_packages_expired_at` already takes at every load;
//! - LAST-RESORT bundles, superseded only by their owner - the server keeps exactly one and never
//!   hands it out-and-deletes it, so nothing can be racing an earlier one;
//! - ONE-TIME bundles absent from the server, which are ambiguous by construction, because the
//!   delivery service DELETES the row as it hands it out (`devices.controller.ts:112`). "Gone from
//!   the server" therefore means either "a peer is about to send a Welcome built on it" or "its
//!   owner revoked it", and the two want opposite treatment. That ambiguity is the whole reason the
//!   prune uses expiry alone.
//!
//! Dividing 7.2 MB by 50 tells a reader nothing about which of those three they are looking at. The
//! repository's own rule for this file's neighbour says it plainly: *the blob's composition is a
//! HYPOTHESIS until it is weighed, and no prune may be written before it is.* These are ASSERTIONS
//! about the split, not about a byte count - what the census must separate, and what it must refuse
//! to guess.
use mls_core::MlsManager;

const DAY: u64 = 60 * 60 * 24;

fn device(user: &str) -> MlsManager {
    MlsManager::load_or_create(user, "census-test", None).expect("create the device")
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("a clock after 1970")
        .as_secs()
}

#[test]
fn the_two_kinds_are_counted_apart() {
    let m = device("alice-kinds");
    m.generate_key_packages(20).expect("20 prekeys");
    m.generate_last_resort_key_package().expect("a fallback");
    m.generate_last_resort_key_package()
        .expect("a second fallback, as a reconnection would mint");

    let c = m.key_package_census_at(now()).expect("census");

    assert_eq!(
        c.total, 22,
        "every bundle minted must be proven and counted"
    );
    assert_eq!(
        c.last_resort, 2,
        "both fallbacks carry the LastResort extension, including the superseded one - which is \
         the point: the store keeps it and only this axis can see it"
    );
    assert_eq!(c.one_time, 20, "the pool is what is left over");
    assert_eq!(
        c.total,
        c.one_time + c.last_resort,
        "the split is exhaustive"
    );
    assert_eq!(
        c.undecodable, 0,
        "nothing this device minted may be unreadable to it"
    );
}

#[test]
fn a_wholesale_remint_is_visible_without_asking_the_server() {
    let m = device("alice-batches");

    // Three rounds of the shape `republishKeyMaterial` produces: purge the server, mint a pool.
    // Nothing here deletes locally, which IS the leak - so the store should end up holding all
    // three rounds, and the census should say so in a way a count never could.
    for _ in 0..3 {
        m.generate_key_packages(10).expect("a pool");
    }

    let c = m.key_package_census_at(now()).expect("census");

    assert_eq!(
        c.one_time, 30,
        "three rounds accumulate; nothing local sheds them"
    );
    assert!(
        c.largest_batch >= 10,
        "a wholesale remint puts a whole pool on one `not_before`; largest batch was {}",
        c.largest_batch
    );
    assert!(
        c.mint_instants <= 3,
        "three rounds cannot produce more than three mint instants, got {}",
        c.mint_instants
    );
}

#[test]
fn expiry_is_measured_against_the_instant_asked_about_and_not_a_clock() {
    let m = device("alice-horizon");
    m.generate_key_packages(12).expect("12 prekeys");

    let fresh = m.key_package_census_at(now()).expect("census now");
    assert_eq!(
        fresh.expired, 0,
        "nothing minted a moment ago is expired, whatever machine this runs on"
    );

    // THE QUESTION THE 84-DAY BOUND MAKES A READER ASK FIRST, and it is only askable because the
    // clock is a parameter: how much of this debt is reclaimable later, without waiting for later.
    let horizon = m
        .key_package_census_at(now() + 100 * DAY)
        .expect("census later");
    assert_eq!(
        horizon.expired, fresh.total,
        "openmls defaults a lifetime to 84 days, so a hundred days out the whole store is \
         reclaimable by the prune that already runs"
    );
}

#[test]
fn the_census_counts_exactly_what_the_prune_can_reach() {
    let m = device("alice-agreement");
    m.generate_key_packages(15).expect("15 prekeys");
    m.generate_last_resort_key_package().expect("a fallback");

    // THE TWO MUST NOT BE ABLE TO DISAGREE. The census is the evidence a reclaim is argued from,
    // and the prune is what acts on it; they share `for_each_proven_key_package` so that a bundle
    // the census describes is a bundle the prune could take, and this asserts that seam rather
    // than trusting it. A census counting rows the prune cannot reach would argue for a delete
    // that lands somewhere else.
    let at = now() + 100 * DAY;
    let census = m.key_package_census_at(at).expect("census");
    let pruned = m.prune_key_packages_expired_at(at).expect("prune");

    assert_eq!(
        pruned, census.expired,
        "the prune took {} where the census promised {}",
        pruned, census.expired
    );

    let after = m.key_package_census_at(at).expect("census after");
    assert_eq!(
        after.total, 0,
        "everything the census called expired is gone"
    );
}

#[test]
fn a_census_never_mutates_what_it_measures() {
    let m = device("alice-readonly");
    m.generate_key_packages(8).expect("8 prekeys");
    m.generate_last_resort_key_package().expect("a fallback");

    // Read at a horizon where EVERY bundle is expired. A measurement that quietly reclaimed what
    // it counted would be indistinguishable from a prune, and the whole argument for acting on
    // these numbers is that they were taken without touching the state.
    let at = now() + 100 * DAY;
    let first = m.key_package_census_at(at).expect("census");
    let second = m.key_package_census_at(at).expect("census again");

    assert_eq!(
        first, second,
        "reading the census twice must give the same answer"
    );
    assert_eq!(first.total, 9, "and it must still be the whole store");
}
