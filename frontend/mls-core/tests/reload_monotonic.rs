//! Tests de l'invariant de rechargement epoch-monotone (`reload_is_monotonic`, C2) : un snapshot
//! recharge ne doit jamais faire regresser l'epoch d'un groupe vivant, ni faire disparaitre un
//! groupe vivant. Miroir natif de `swapClientMonotonic` cote WASM/TS.
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

    // epoch 1 : ajout de bob (stage + merge).
    let kp = bob.generate_key_package().expect("kp");
    alice.add_members_bulk(gid, &[&kp]).expect("stage add");
    alice.merge_pending_commit_for(gid).expect("merge add");
    let snapshot_e1 = alice.save_state().expect("snapshot e1");
    assert_eq!(alice.get_epoch(gid).unwrap(), 1);

    // epoch 2 : retrait de bob (stage + merge).
    alice
        .remove_members_for_devices(gid, &["rel-bob:dev1"])
        .expect("stage remove");
    alice.merge_pending_commit_for(gid).expect("merge remove");
    assert_eq!(alice.get_epoch(gid).unwrap(), 2);

    let candidate_e1 = restore("rel-alice", "dev1", snapshot_e1);

    // Live epoch 2 vs candidat epoch 1 -> regression -> refus.
    assert!(
        !alice.reload_is_monotonic(&candidate_e1),
        "un snapshot plus ancien (epoch inferieur) doit etre refuse"
    );
    // Le sens inverse (candidat epoch 1 rechargeant un live epoch 2) est un avancement -> autorise.
    assert!(
        candidate_e1.reload_is_monotonic(&alice),
        "un rechargement vers un epoch superieur ou egal doit etre autorise"
    );
}

#[test]
fn refuses_a_snapshot_missing_a_live_group() {
    let mut alice = make("rel-alice2", "dev1");
    let gid = "g-reload2";
    // Snapshot pris AVANT la creation du groupe (aucun groupe).
    let snapshot_empty = alice.save_state().expect("empty snapshot");
    alice.create_group(gid.to_string()).expect("create");
    assert_eq!(alice.get_epoch(gid).unwrap(), 0);

    let candidate_empty = restore("rel-alice2", "dev1", snapshot_empty);
    // Le live detient gid@0 ; le candidat ne connait pas gid -> disparition -> refus.
    assert!(
        !alice.reload_is_monotonic(&candidate_empty),
        "un snapshot qui perd un groupe vivant doit etre refuse"
    );
}

#[test]
fn allows_an_equal_snapshot() {
    let mut alice = make("rel-alice3", "dev1");
    let gid = "g-reload3";
    alice.create_group(gid.to_string()).expect("create");
    let snapshot = alice.save_state().expect("snapshot");
    let candidate = restore("rel-alice3", "dev1", snapshot);
    // Meme epoch des deux cotes -> monotone (>=) -> autorise.
    assert!(alice.reload_is_monotonic(&candidate));
}
