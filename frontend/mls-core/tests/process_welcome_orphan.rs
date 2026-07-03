/// Verifie que `process_welcome` ne laisse PAS d'etat orphelin dans le storage quand un guard
/// rejette le Welcome (epoch stale < min_epoch impose par un `forget_group` anterieur).
///
/// Contexte : `into_group` persiste le groupe dans le storage provider. Avant le correctif C4,
/// il etait appele AVANT l'evaluation des guards : un Welcome rejete ecrivait quand meme le
/// groupe dans le storage sans l'enregistrer dans `self.groups`. Cet orphelin fuyait et bloquait
/// tout futur re-Welcome legitime avec `GroupAlreadyExists` (leve par `new_from_welcome` quand le
/// group_id est deja present dans le storage). Les guards doivent donc s'evaluer sur le
/// `StagedWelcome` (en memoire) AVANT `into_group`.
use mls_core::{MlsError, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("Impossible de creer le device '{user_id}:{device_id}': {e}"))
}

#[test]
fn rejected_stale_welcome_leaves_no_orphan_blocking_a_fresh_welcome() {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let gid = "g-orphan-1";

    alice.create_group(gid.to_string()).expect("create_group");

    // Deux KeyPackages distincts (non consommes) pour pouvoir produire deux Welcomes a des
    // epochs differentes pour le MEME groupe, sans que bob n'en ait jamais rejoint un.
    let kp_bob1 = bob.generate_key_package().expect("kp bob 1");
    let kp_bob2 = bob.generate_key_package().expect("kp bob 2");

    // Welcome v1 : ajout de bob -> epoch 1.
    let (_, welcome_v1, _, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob1])
        .expect("add bob v1");
    // Stage-only add (C7-A): confirm to reach epoch 1, then export the post-merge tree.
    alice
        .merge_pending_commit_for(gid)
        .expect("confirm add bob v1");
    let welcome_v1 = welcome_v1.expect("welcome v1");
    let rt_v1 = alice.export_ratchet_tree_for(gid).expect("ratchet tree v1");

    // Retrait de bob (epoch 2) puis re-ajout via kp_bob2 (epoch 3) -> Welcome v2 a l'epoch 3.
    // Le retrait STAGE le commit (C7 Option A) : on le confirme pour que bob quitte reellement
    // l'arbre avant le re-ajout (sinon kp_bob2 serait rejete en AlreadyMember).
    alice
        .remove_members_for_devices(gid, &["bob:dev1"])
        .expect("remove bob");
    alice
        .merge_pending_commit_for(gid)
        .expect("confirm remove bob");
    let (_, welcome_v2, _, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob2])
        .expect("add bob v2");
    // Stage-only add (C7-A): confirm to reach epoch 3, then export the post-merge tree.
    alice
        .merge_pending_commit_for(gid)
        .expect("confirm add bob v2");
    let welcome_v2 = welcome_v2.expect("welcome v2");
    let rt_v2 = alice.export_ratchet_tree_for(gid).expect("ratchet tree v2");

    // bob oublie le groupe en imposant min_epoch=3 (il attend un re-Welcome a jour).
    bob.forget_group(gid, 3);

    // Le Welcome v1 (epoch 1) est stale : il doit etre rejete.
    let stale = bob.process_welcome(&welcome_v1, Some(&rt_v1));
    assert!(
        matches!(&stale, Err(MlsError::OpenMls(m)) if m.contains("stale")),
        "le Welcome stale doit etre rejete, obtenu: {stale:?}"
    );

    // Coeur du test : le Welcome v2 (epoch 3 >= min 3) doit reussir. Si le rejet precedent avait
    // laisse un orphelin dans le storage, new_from_welcome echouerait ici en GroupAlreadyExists.
    let joined = bob
        .process_welcome(&welcome_v2, Some(&rt_v2))
        .expect("le Welcome a jour doit reussir (aucun orphelin storage)");
    assert_eq!(joined, gid);
    assert!(bob.get_known_groups().contains(&gid.to_string()));
}
