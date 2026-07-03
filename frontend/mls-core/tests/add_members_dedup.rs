/// Tests pour le garde-fou anti-doublon de `add_members_bulk`.
///
/// Contexte : si un appareil ajoute un device en bulk, fusionne le commit localement,
/// puis échoue à livrer le Welcome/commit sur le réseau, ce device reste un "membre
/// fantôme" dans l'arbre MLS local sans être réellement notifié. Une nouvelle tentative
/// d'invitation de ce même device faisait alors échouer tout le commit avec
/// `ProposalValidationError(DuplicateSignatureKey)` côté OpenMLS, bloquant aussi les
/// autres invités du même lot. `add_members_bulk` doit désormais filtrer ces doublons en
/// amont et signaler le cas "tout le lot est déjà membre" via `MlsError::AlreadyMember`.
use mls_core::{MlsError, MlsManager};

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("Impossible de créer le device '{user_id}:{device_id}': {e}"))
}

#[test]
fn add_members_bulk_rejects_keypackage_of_an_existing_member() {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let gid = "g-dedup-1";

    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");

    // Premier ajout : doit réussir et inclure bob à l'index 0.
    let (_, welcome, added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob])
        .expect("first add should succeed");
    assert_eq!(added, vec![0]);
    // Stage-only add (C7-A): merge as if the server accepted, then export the post-merge tree.
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");

    // bob est désormais un membre réel de l'arbre local d'alice. Si une tentative
    // précédente avait merge un commit similaire sans jamais livrer le Welcome, alice
    // se retrouverait dans le même état : bob présent dans l'arbre, ré-invitation requise.
    let kp_bob_again = bob.generate_key_package().expect("kp bob again");
    let err = alice
        .add_members_bulk(gid, &[&kp_bob_again])
        .expect_err("re-adding an existing member must fail distinctly");
    assert!(
        matches!(err, MlsError::AlreadyMember(_)),
        "expected AlreadyMember, got {err:?}"
    );
}

#[test]
fn add_members_bulk_skips_existing_member_but_adds_the_rest_of_the_batch() {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let mut carol = make_device("carol", "dev1");
    let gid = "g-dedup-2";

    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_, welcome, _added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob])
        .expect("bob joins first");
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins");

    // Lot mixte : bob (déjà membre - doit être ignoré) + carol (nouvelle - doit être ajoutée).
    let kp_bob_stale = bob.generate_key_package().expect("kp bob stale");
    let kp_carol = carol.generate_key_package().expect("kp carol");
    let (_, welcome2, added, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob_stale, &kp_carol])
        .expect("mixed batch should still add carol");

    // Seul l'index 1 (carol) doit être marqué comme ajouté.
    assert_eq!(added, vec![1]);
    alice
        .merge_pending_commit_for(gid)
        .expect("merge add carol");
    let rt2 = alice.export_ratchet_tree_for(gid).expect("tree");
    carol
        .process_welcome(welcome2.as_deref().unwrap(), Some(&rt2))
        .expect("carol joins");
}

/// [[C5]] Un KeyPackage invalide/illisible ne doit pas disparaitre silencieusement : son index
/// doit etre remonte dans `skipped_indices` (et NON dans `added_indices`), tandis que les
/// KeyPackages valides du meme lot sont ajoutes normalement.
#[test]
fn add_members_bulk_reports_invalid_keypackage_in_skipped_indices() {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    let gid = "g-skip-1";

    alice.create_group(gid.to_string()).expect("create_group");

    // Index 0 : bytes corrompus (echec de deserialisation) -> doit etre marque skipped.
    let garbage: Vec<u8> = vec![0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03];
    // Index 1 : KeyPackage valide de bob -> doit etre ajoute.
    let kp_bob = bob.generate_key_package().expect("kp bob");

    let (_, welcome, added, skipped) = alice
        .add_members_bulk(gid, &[&garbage, &kp_bob])
        .expect("batch with one invalid KP still adds the valid one");

    assert_eq!(added, vec![1], "seul bob (index 1) doit etre ajoute");
    assert_eq!(
        skipped,
        vec![0],
        "le KeyPackage corrompu (index 0) doit etre remonte dans skipped_indices"
    );

    // Le membre valide rejoint bien malgre le KP invalide du lot.
    alice.merge_pending_commit_for(gid).expect("merge add bob");
    let rt = alice.export_ratchet_tree_for(gid).expect("tree");
    bob.process_welcome(welcome.as_deref().unwrap(), Some(&rt))
        .expect("bob joins despite the skipped invalid KP");
}
