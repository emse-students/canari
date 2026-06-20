/// Tests de robustesse du Sender Ratchet a meme epoch (rafales + livraison dupliquee).
///
/// Contexte : envoyer plusieurs messages d'un coup, combine a une livraison multi-chemin
/// (publish realtime + file d'attente + FCM + requeue natif), delivre regulierement des
/// generations dans le desordre ou en double. Avec la tolerance OpenMLS par defaut (5), une
/// generation arrivee trop tard tombait hors fenetre -> `SecretTreeError(TooDistantInThePast)`,
/// et un doublon -> `SecretReuseError`. Ces deux erreurs sont PERMANENTES : les remettre en
/// file les faisait boucler indefiniment (storm + Argon2 a repetition sur mobile).
///
/// Deux garanties verifiees ici :
///  1. Un doublon a meme epoch est un drop benin (`Ok(None)`), jamais une erreur.
///  2. Une rafale livree dans le desordre se dechiffre grace a la fenetre elargie.
use mls_core::MlsManager;

fn make_device(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("Impossible de creer le device '{user_id}:{device_id}': {e}"))
}

/// Cree un groupe a deux membres (alice cree, bob rejoint via Welcome) tous deux a l'epoch 1.
fn pair_in_group(gid: &str) -> (MlsManager, MlsManager, String) {
    let mut alice = make_device("alice", "dev1");
    let mut bob = make_device("bob", "dev1");
    alice.create_group(gid.to_string()).expect("create_group");
    let kp_bob = bob.generate_key_package().expect("kp bob");
    let (_, welcome, _, rt, _skipped) = alice
        .add_members_bulk(gid, &[&kp_bob])
        .expect("add bob to group");
    bob.process_welcome(welcome.as_deref().unwrap(), rt.as_deref())
        .expect("bob joins");
    (alice, bob, gid.to_string())
}

#[test]
fn duplicate_same_epoch_frame_is_a_benign_drop_not_an_error() {
    let (mut alice, mut bob, gid) = pair_in_group("g-same-epoch-dup");

    let ciphertext = alice.send_message(&gid, b"hello").expect("encrypt");

    let first = bob
        .process_incoming_message(&gid, &ciphertext)
        .expect("first decrypt must succeed");
    assert_eq!(first.as_deref(), Some(b"hello".as_ref()));

    // Re-delivering the exact same ciphertext (realtime + queue duplicate) used to raise
    // SecretReuseError and get queued for an endless retry. It must now be a benign drop.
    let second = bob
        .process_incoming_message(&gid, &ciphertext)
        .expect("duplicate frame must NOT error");
    assert_eq!(
        second, None,
        "duplicate same-epoch frame should be Ok(None)"
    );
}

#[test]
fn out_of_order_burst_decrypts_with_widened_tolerance() {
    let (mut alice, mut bob, gid) = pair_in_group("g-same-epoch-burst");

    // Alice sends a burst at the same epoch: generations 0..=29.
    let mut ciphertexts = Vec::new();
    for i in 0..30u32 {
        ciphertexts.push(
            alice
                .send_message(&gid, format!("m{i}").as_bytes())
                .expect("encrypt burst message"),
        );
    }

    // Deliver the LAST generation first (jump ahead, store skipped keys), then 0..=28 in order.
    // With the default out_of_order_tolerance of 5 the early generations would be dropped as
    // TooDistantInThePast; the widened window must let every one of them decrypt cleanly.
    let last = bob
        .process_incoming_message(&gid, &ciphertexts[29])
        .expect("decrypt last generation");
    assert_eq!(last.as_deref(), Some(b"m29".as_ref()));

    for (i, ciphertext) in ciphertexts.iter().enumerate().take(29) {
        let out = bob
            .process_incoming_message(&gid, ciphertext)
            .unwrap_or_else(|e| panic!("decrypt of out-of-order generation {i} failed: {e}"));
        assert_eq!(
            out.as_deref(),
            Some(format!("m{i}").as_bytes()),
            "out-of-order generation {i} should decrypt within tolerance"
        );
    }
}
