//! Tests du flux valider-puis-merger (C7 Option A) sur le chemin REMOVE.
//!
//! `remove_members_for_*` *stage* desormais le commit sans le merger. L'appelant le confirme
//! (`merge_pending_commit_for`) apres acceptation serveur, ou l'annule (`clear_pending_commit_for`)
//! sur rejet. Invariant : tant que le commit n'est pas confirme, l'epoch local n'avance pas -
//! donc un rejet serveur ne laisse jamais l'appareil sur une branche forkee.
use mls_core::MlsManager;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("device '{user_id}:{device_id}': {e}"))
}

/// alice cree un groupe et y ajoute bob (l'ajout reste merge-immediat). Setup commun.
fn group_with_alice_bob() -> (MlsManager, &'static str) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let gid = "g-pending";
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_c, welcome, _added, rt, _skipped) =
        alice.add_members_bulk(gid, &[&kp_bob]).expect("add bob");
    bob.process_welcome(welcome.as_deref().unwrap(), rt.as_deref())
        .expect("bob joins");
    (alice, gid)
}

#[test]
fn remove_stages_without_advancing_epoch_then_confirm_merges() {
    let (mut alice, gid) = group_with_alice_bob();
    let epoch_before = alice.get_epoch(gid).expect("epoch");

    // Stage le retrait de bob : l'epoch local NE DOIT PAS avancer (commit non merge).
    let _commit = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("stage remove");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before,
        "stage ne doit pas avancer l'epoch (validate-then-merge)"
    );

    // Confirme (le serveur a accepte) : l'epoch avance enfin d'exactement 1.
    alice.merge_pending_commit_for(gid).expect("confirm");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before + 1,
        "confirm doit avancer l'epoch d'exactement 1"
    );
}

#[test]
fn remove_abort_keeps_epoch_and_allows_a_fresh_commit() {
    let (mut alice, gid) = group_with_alice_bob();
    let epoch_before = alice.get_epoch(gid).expect("epoch");

    // Stage puis ANNULE (le serveur a rejete) : aucun fork, epoch inchange.
    let _commit = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("stage remove");
    alice.clear_pending_commit_for(gid).expect("abort");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before,
        "abort doit laisser l'epoch inchange (pas de fork)"
    );

    // Apres abort, plus aucun commit en attente ne bloque : on peut re-stager puis confirmer.
    let _commit2 = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("re-stage remove apres abort");
    alice.merge_pending_commit_for(gid).expect("confirm");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before + 1,
        "un commit confirme apres un abort doit avancer l'epoch normalement"
    );
}

#[test]
fn remove_by_device_stage_confirm_advances_epoch() {
    let (mut alice, gid) = group_with_alice_bob();
    let epoch_before = alice.get_epoch(gid).expect("epoch");

    let _commit = alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("stage remove device");
    assert_eq!(
        alice.get_epoch(gid).expect("epoch"),
        epoch_before,
        "stage par appareil ne doit pas avancer l'epoch"
    );

    alice.merge_pending_commit_for(gid).expect("confirm");
    assert_eq!(alice.get_epoch(gid).expect("epoch"), epoch_before + 1);
}
