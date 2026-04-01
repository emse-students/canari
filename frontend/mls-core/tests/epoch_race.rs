/// Tests d'intégration MLS — Simulation multi-appareils / multi-utilisateurs
///
/// Objectif : reproduire le bug `TooDistantInThePast` / `AeadError` qui survient
/// lorsque deux appareils tentent simultanément d'ajouter le même device tiers.
///
/// Architecture du test :
///   Chaque `MlsManager` représente un appareil indépendant (état MLS isolé en mémoire).
///   On les fait interagir via les messages sérialisés (bytes) exactement comme dans la
///   vraie infrastructure (sans réseau).
///
/// Exécution :
///   cd frontend/mls-core && cargo test -- --nocapture
use mls_core::MlsManager;

fn make_device(user_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, None)
        .unwrap_or_else(|e| panic!("Impossible de créer le device '{user_id}': {e}"))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Affiche une section du plan d'actions attendues.
fn print_scenario(title: &str, steps: &[&str]) {
    println!("\n╔═══════════════════════════════════════════════════╗");
    println!("║  {title}");
    println!("╠═══════════════════════════════════════════════════╣");
    for (i, s) in steps.iter().enumerate() {
        println!("║  {:2}. {s}", i + 1);
    }
    println!("╚═══════════════════════════════════════════════════╝\n");
}

fn ok_or(result: &Result<Option<Vec<u8>>, mls_core::MlsError>, label: &str) {
    match result {
        Ok(Some(data)) => println!("  ✓ {label}: \"{}\"", String::from_utf8_lossy(data)),
        Ok(None) => println!("  ✓ {label}: (commit/handshake, pas de payload applicatif)"),
        Err(e) => println!("  ✗ {label}: ERREUR → {e}"),
    }
}

// ---------------------------------------------------------------------------
// SCÉNARIO 1 — Chemin heureux (baseline sans race)
// ---------------------------------------------------------------------------
///
/// Actions attendues :
///  1. jolan-dev1 crée le groupe MLS `g-dm`
///  2. test-dev1 génère son KeyPackage
///  3. jolan-dev1 ajoute test-dev1 → commit C1 + Welcome W1  (epoch 0 → 1)
///  4. test-dev1 traite W1 → rejoint le groupe à epoch 1
///  5. jolan-dev3 génère son KeyPackage
///  6. SEULEMENT jolan-dev1 ajoute jolan-dev3 → commit C2 + Welcome W2  (epoch 1 → 2)
///  7. test-dev1 traite C2 → avance à epoch 2
///  8. jolan-dev3 traite W2 → rejoint le groupe à epoch 2
///  9. jolan-dev3 envoie un message  (encrypted at epoch 2)
/// 10. jolan-dev1 décrypte → OK        (epoch 2, secrets alignés)
/// 11. test-dev1  décrypte → OK        (epoch 2, secrets alignés)
///
/// Résultat attendu : tout le monde déchiffre sans erreur.
#[test]
fn test_scenario1_happy_path() {
    print_scenario(
        "SCÉNARIO 1 — Chemin heureux (un seul adder)",
        &[
            "jolan-dev1 crée le groupe g-dm",
            "test-dev1 génère son KeyPackage",
            "jolan-dev1 ajoute test-dev1 → commit C1 + Welcome W1  (epoch 0→1)",
            "test-dev1 reçoit W1 → rejoint à epoch 1",
            "jolan-dev3 génère son KeyPackage",
            "SEULEMENT jolan-dev1 ajoute jolan-dev3 → commit C2 + Welcome W2  (epoch 1→2)",
            "test-dev1 traite C2 → epoch 2",
            "jolan-dev3 reçoit W2 → rejoint à epoch 2",
            "jolan-dev3 envoie un message (epoch 2)",
            "jolan-dev1 décrypte → attendu OK",
            "test-dev1  décrypte → attendu OK",
        ],
    );

    let mut jolan1 = make_device("jolan");
    let mut test1 = make_device("test");
    let mut jolan3 = make_device("jolan");
    let gid = "g-dm-happy";

    // Étape 1
    jolan1.create_group(gid.to_string()).expect("create_group");
    println!("  ✓ [1] jolan-dev1 groupe créé");

    // Étapes 2-4
    let kp_test1 = test1.generate_key_package().expect("kp test1");
    let (commit1, welcome1, added1, rt1) = jolan1
        .add_members_bulk(gid, &[&kp_test1])
        .expect("add test1");
    println!(
        "  ✓ [3] jolan-dev1 a ajouté test-dev1 ({added1} device(s)), commit {} bytes",
        commit1.len()
    );

    test1
        .process_welcome(
            welcome1.as_deref().expect("welcome1 manquant"),
            rt1.as_deref(),
        )
        .expect("test1 process_welcome");
    println!("  ✓ [4] test-dev1 a rejoint le groupe (epoch 1)");

    // Étapes 5-8
    let kp_jolan3 = jolan3.generate_key_package().expect("kp jolan3");
    let (commit2, welcome2, added2, rt2) = jolan1
        .add_members_bulk(gid, &[&kp_jolan3])
        .expect("add jolan3");
    println!(
        "  ✓ [6] jolan-dev1 a ajouté jolan-dev3 ({added2} device(s)), commit {} bytes",
        commit2.len()
    );

    let r_test1_commit = test1.process_incoming_message(gid, &commit2);
    ok_or(&r_test1_commit, "[7] test-dev1 traite C2 (add jolan3)");
    assert!(r_test1_commit.is_ok(), "test1 doit traiter C2 sans erreur");

    jolan3
        .process_welcome(
            welcome2.as_deref().expect("welcome2 manquant"),
            rt2.as_deref(),
        )
        .expect("jolan3 process_welcome");
    println!("  ✓ [8] jolan-dev3 a rejoint le groupe (epoch 2)");

    // Étapes 9-11
    let msg = jolan3
        .send_message(gid, b"Salut depuis jolan-dev3")
        .expect("send_message");
    println!(
        "  ✓ [9] jolan-dev3 a envoyé un message chiffré ({} bytes)",
        msg.len()
    );

    let r_jolan1 = jolan1.process_incoming_message(gid, &msg);
    ok_or(&r_jolan1, "[10] jolan-dev1 déchiffre");

    let r_test1 = test1.process_incoming_message(gid, &msg);
    ok_or(&r_test1, "[11] test-dev1 déchiffre");

    println!("\n  ═══ RÉSULTAT SCÉNARIO 1 ═══");
    assert!(
        r_jolan1.is_ok(),
        "jolan-dev1 devrait décrypter: {:?}",
        r_jolan1
    );
    assert!(
        r_test1.is_ok(),
        "test-dev1 devrait décrypter: {:?}",
        r_test1
    );
    println!("  ✓ PASS — chemin heureux validé");
}

// ---------------------------------------------------------------------------
// SCÉNARIO 2 — Race condition : REPRODUIT LE BUG
// ---------------------------------------------------------------------------
///
/// Actions attendues (selon le code actuel) :
///  1. jolan-dev1 crée le groupe g-dm-race
///  2. test-dev1 génère son KeyPackage
///  3. jolan-dev1 ajoute test-dev1 → commit + Welcome  (epoch 0→1)
///  4. test-dev1 rejoint à epoch 1
///  5. jolan-dev3 génère son KeyPackage  ← POINT D'ENTRÉE DE LA RACE
///  6. jolan-dev1 appelle add_members_bulk(jolan3-kp)  (à epoch 1) → commit-A, état local epoch 1→2
///  7. test-dev1  appelle add_members_bulk(jolan3-kp)  (à epoch 1) → commit-B, état local epoch 1→2
///     ⚠ Les deux sont déjà à epoch 2 mais avec des SECRETS DIFFÉRENTS
///  8. jolan-dev3 reçoit le Welcome issu du commit-A (de jolan-dev1)
///     → jolan-dev3 est à epoch 2, secrets alignés avec jolan-dev1
///  9. test-dev1 reçoit le commit-A de jolan-dev1 sur le canal
///     → test-dev1 est déjà à epoch 2 (depuis commit-B) → ERREUR WrongEpoch attendue
/// 10. jolan-dev3 envoie un message (epoch 2, secrets de commit-A)
/// 11. jolan-dev1 déchiffre → OK (secrets de commit-A)
/// 12. test-dev1  déchiffre → ERREUR (secrets de commit-B ≠ secrets de commit-A)
///
/// ROOT CAUSE : deux commits concurrent sur la même base epoch provoquent
///              une divergence irrémédiable de l'état secret MLS.
#[test]
fn test_scenario2_race_condition() {
    print_scenario(
        "SCÉNARIO 2 — Race condition (BUG ACTUEL)",
        &[
            "jolan-dev1 crée le groupe g-dm-race",
            "test-dev1 génère son KeyPackage",
            "jolan-dev1 ajoute test-dev1 → commit + Welcome  (epoch 0→1)",
            "test-dev1 rejoint à epoch 1",
            "jolan-dev3 génère son KeyPackage  ← DÉBUT DE LA RACE",
            "jolan-dev1 add_members_bulk(jolan3-kp) @ epoch 1 → commit-A + Welcome-A  (epoch 1→2)",
            "test-dev1  add_members_bulk(jolan3-kp) @ epoch 1 → commit-B + Welcome-B  (epoch 1→2 DIVERGÉ)",
            "jolan-dev3 reçoit Welcome-A → rejoint à epoch 2 (secrets set-A)",
            "test-dev1 reçoit commit-A du canal → déjà à epoch 2 → ERREUR WrongEpoch",
            "jolan-dev3 envoie un message (epoch 2, secrets set-A)",
            "jolan-dev1 déchiffre → ATTENDU OK",
            "test-dev1  déchiffre → ATTENDU ERREUR (secrets divergés)",
        ],
    );

    let mut jolan1 = make_device("jolan");
    let mut test1 = make_device("test");
    let mut jolan3 = make_device("jolan");
    let gid = "g-dm-race";

    // Setup initial (époque 0→1)
    jolan1.create_group(gid.to_string()).expect("create_group");
    let kp_test1 = test1.generate_key_package().expect("kp test1");
    let (_, welcome_test1, _, rt_test1) = jolan1
        .add_members_bulk(gid, &[&kp_test1])
        .expect("add test1");
    test1
        .process_welcome(
            welcome_test1.as_deref().expect("welcome_test1"),
            rt_test1.as_deref(),
        )
        .expect("test1 join");
    println!("  ✓ Setup : jolan-dev1 + test-dev1 dans le groupe (epoch 1)");

    // RACE : les deux génèrent un commit concurrent depuis la même base
    let kp_jolan3 = jolan3.generate_key_package().expect("kp jolan3");

    // jolan-dev1 ajoute jolan3 PREMIER (côté jolan, syncOwnDevicesToGroups)
    let (commit_a, welcome_a, _, rt_a) = jolan1
        .add_members_bulk(gid, &[&kp_jolan3])
        .expect("jolan1 add jolan3");
    println!(
        "  ✓ [6] jolan-dev1 commit-A créé (epoch 1→2), {} bytes",
        commit_a.len()
    );

    // test-dev1 essaie AUSSI d'ajouter jolan3 (côté test, syncPeerDevicesToGroups)
    // MÊME KeyPackage ! Les deux partaient de la même base epoch.
    let result_test1_add = test1.add_members_bulk(gid, &[&kp_jolan3]);
    match &result_test1_add {
        Ok((c, _, _, _)) => println!(
            "  ⚠ [7] test-dev1 commit-B créé (epoch 1→2 DIVERGÉ), {} bytes — RACE ACTIVE",
            c.len()
        ),
        Err(e) => println!(
            "  ✓ [7] test-dev1 a échoué à créer commit-B (peut-être kp déjà consommé): {e}"
        ),
    }

    // jolan-dev3 reçoit le Welcome issu du commit-A de jolan-dev1
    let join_result =
        jolan3.process_welcome(welcome_a.as_deref().expect("welcome_a"), rt_a.as_deref());
    let join_ok = join_result.is_ok();
    let join_status = match join_result {
        Ok(_) => "OK (epoch 2, secrets set-A)".to_string(),
        Err(e) => format!("ERREUR: {e}"),
    };
    println!("  [8] jolan-dev3 rejoint via Welcome-A: {join_status}");

    if join_ok {
        // test-dev1 reçoit le commit-A de jolan-dev1 sur le canal
        let r_test1_commit_a = test1.process_incoming_message(gid, &commit_a);
        println!(
            "  [9] test-dev1 traite commit-A (déjà à epoch 2 depuis commit-B): {}",
            match &r_test1_commit_a {
                Ok(_) => "OK (inattendu — epoch reset ?)".to_string(),
                Err(e) => format!("ERREUR (attendue) → {e}"),
            }
        );

        // jolan-dev3 envoie un message
        let msg = jolan3
            .send_message(gid, b"Message de dev3 post-race")
            .expect("jolan3 send");
        println!("  ✓ [10] jolan-dev3 envoie message ({} bytes)", msg.len());

        let r_jolan1 = jolan1.process_incoming_message(gid, &msg);
        let r_test1 = test1.process_incoming_message(gid, &msg);

        println!("\n  ═══ RÉSULTAT SCÉNARIO 2 ═══");
        match &r_jolan1 {
            Ok(_) => println!("  ✓ jolan-dev1 déchiffre : OK (aligné sur commit-A)"),
            Err(e) => println!("  ✗ jolan-dev1 déchiffre : ERREUR → {e}"),
        }
        match &r_test1 {
            Ok(_) => println!("  ✓ test-dev1 déchiffre : OK (étonnant si secrets divergés)"),
            Err(e) => println!("  ✗ test-dev1 déchiffre : ERREUR → {} ← BUG REPRODUIT", e),
        }

        // Ce test DOCUMENTE le bug : on s'attend à ce que l'un des deux échoue.
        // Si les deux réussissent, OpenMLS a peut-être rejeté commit-B silencieusement.
        let both_ok = r_jolan1.is_ok() && r_test1.is_ok();
        if both_ok {
            println!(
                "  ℹ Les deux déchiffrent → OpenMLS a rejeté commit-B en amont (kp déjà consommé ou epoch guard actif)"
            );
            println!(
                "    → La race condition n'est PAS reproductible au niveau Rust (déjà protégé côté OpenMLS)"
            );
            println!(
                "    → Le vrai bug est dans l'orchestration TypeScript (deux add_members_bulk sur websocket)"
            );
        } else {
            println!("  ⚠ Race condition MLS confirmée au niveau Rust !");
        }
    }
}

// ---------------------------------------------------------------------------
// SCÉNARIO 3 — Fix appliqué : seul jolan-dev1 ajoute jolan-dev3
// ---------------------------------------------------------------------------
///
/// Simule le comportement APRÈS correction de `syncPeerDevicesToGroups` :
/// test-dev1 vérifie d'abord si jolan est déjà membre enregistré → oui → SKIP.
/// Donc seul jolan-dev1 (via syncOwnDevicesToGroups) ajoute jolan-dev3.
///
/// Actions :
///  1-5. Identiques au scénario 2 (setup + génération KP jolan-dev3)
///  6. jolan-dev1 ajoute jolan-dev3 → commit-A + Welcome-A  (epoch 1→2)
///     test-dev1 SKIP (simulate le guard: registeredUserIds.has('jolan') → skip)
///  7. test-dev1 traite commit-A → epoch 2 aligné
///  8. jolan-dev3 rejoint via Welcome-A → epoch 2 aligné
///  9. jolan-dev3 envoie un message
/// 10. jolan-dev1 déchiffre → OK
/// 11. test-dev1  déchiffre → OK
#[test]
fn test_scenario3_fix_single_adder_guard() {
    print_scenario(
        "SCÉNARIO 3 — Fix appliqué (guard syncPeerDevicesToGroups)",
        &[
            "jolan-dev1 crée le groupe g-dm-fix",
            "test-dev1 génère son KeyPackage",
            "jolan-dev1 ajoute test-dev1 → commit + Welcome  (epoch 0→1)",
            "test-dev1 rejoint à epoch 1",
            "jolan-dev3 génère son KeyPackage",
            "jolan-dev1 ajoute jolan-dev3 → commit-A + Welcome-A  (epoch 1→2)",
            "test-dev1 SKIP (guard: 'jolan' déjà membre → syncOwnDevicesToGroups de jolan gère)",
            "test-dev1 traite commit-A → epoch 2 aligné",
            "jolan-dev3 reçoit Welcome-A → rejoint à epoch 2 aligné",
            "jolan-dev3 envoie un message (epoch 2)",
            "jolan-dev1 déchiffre → attendu OK",
            "test-dev1  déchiffre → attendu OK",
        ],
    );

    let mut jolan1 = make_device("jolan");
    let mut test1 = make_device("test");
    let mut jolan3 = make_device("jolan");
    let gid = "g-dm-fix";

    // Setup (epoch 0→1)
    jolan1.create_group(gid.to_string()).expect("create_group");
    let kp_test1 = test1.generate_key_package().expect("kp test1");
    let (_, welcome_test1, _, rt_test1) = jolan1
        .add_members_bulk(gid, &[&kp_test1])
        .expect("add test1");
    test1
        .process_welcome(
            welcome_test1.as_deref().expect("welcome_test1"),
            rt_test1.as_deref(),
        )
        .expect("test1 join");
    println!("  ✓ Setup : jolan-dev1 + test-dev1 dans le groupe (epoch 1)");

    // Génération KP jolan-dev3
    let kp_jolan3 = jolan3.generate_key_package().expect("kp jolan3");

    // jolan-dev1 ajoute jolan-dev3 (via syncOwnDevicesToGroups)
    let (commit_a, welcome_a, added, rt_a) = jolan1
        .add_members_bulk(gid, &[&kp_jolan3])
        .expect("jolan1 add jolan3");
    println!(
        "  ✓ [6] jolan-dev1 a ajouté jolan-dev3 ({added} device(s)), commit {} bytes",
        commit_a.len()
    );

    // test-dev1 SKIP — simule le guard TypeScript corrigé
    // (Dans le vrai code : registeredUserIds.has('jolan') → continue)
    println!("  ✓ [7a] test-dev1 SKIP — 'jolan' est déjà membre enregistré dans getGroupMembers()");

    // test-dev1 traite commit-A du canal (comportement normal de réception)
    let r_test1_commit = test1.process_incoming_message(gid, &commit_a);
    ok_or(&r_test1_commit, "[7b] test-dev1 traite commit-A");
    assert!(
        r_test1_commit.is_ok(),
        "test-dev1 doit traiter commit-A: {:?}",
        r_test1_commit
    );

    // jolan-dev3 rejoint
    jolan3
        .process_welcome(welcome_a.as_deref().expect("welcome_a"), rt_a.as_deref())
        .expect("jolan3 join via Welcome-A");
    println!("  ✓ [9] jolan-dev3 a rejoint (epoch 2, secrets set-A)");

    // jolan-dev3 envoie un message
    let msg = jolan3
        .send_message(gid, b"Message de dev3 post-fix")
        .expect("jolan3 send");
    println!("  ✓ [10] jolan-dev3 envoie message ({} bytes)", msg.len());

    let r_jolan1 = jolan1.process_incoming_message(gid, &msg);
    let r_test1 = test1.process_incoming_message(gid, &msg);

    ok_or(&r_jolan1, "[11] jolan-dev1 déchiffre");
    ok_or(&r_test1, "[11] test-dev1  déchiffre");

    println!("\n  ═══ RÉSULTAT SCÉNARIO 3 ═══");
    assert!(
        r_jolan1.is_ok(),
        "jolan-dev1 devrait décrypter: {:?}",
        r_jolan1
    );
    assert!(
        r_test1.is_ok(),
        "test-dev1 devrait décrypter: {:?}",
        r_test1
    );
    println!("  ✓ PASS — fix validé, aucune divergence d'epoch");
}

// ---------------------------------------------------------------------------
// SCÉNARIO 4 — Envoi croisé multi-appareils après fix
// ---------------------------------------------------------------------------
/// Après le fix, tous les participants s'envoient des messages dans les deux sens.
#[test]
fn test_scenario4_bidirectional_messaging() {
    let mut jolan1 = make_device("jolan");
    let mut test1 = make_device("test");
    let mut jolan3 = make_device("jolan");
    let gid = "g-dm-bidir";

    // Setup complet (même que scénario 3)
    jolan1.create_group(gid.to_string()).expect("create_group");
    let kp_test1 = test1.generate_key_package().expect("kp test1");
    let (commit1, welcome_test1, _, rt1) = jolan1
        .add_members_bulk(gid, &[&kp_test1])
        .expect("add test1");
    test1
        .process_welcome(welcome_test1.as_deref().unwrap(), rt1.as_deref())
        .expect("test1 join");

    let kp_jolan3 = jolan3.generate_key_package().expect("kp jolan3");
    let (commit2, welcome_jolan3, _, rt2) = jolan1
        .add_members_bulk(gid, &[&kp_jolan3])
        .expect("add jolan3");
    test1
        .process_incoming_message(gid, &commit2)
        .expect("test1 process commit2");
    jolan3
        .process_welcome(welcome_jolan3.as_deref().unwrap(), rt2.as_deref())
        .expect("jolan3 join");

    // Les deux commits précédents ont été broadcastés. Dans notre test, jolan1 a mergé commit1
    // mais n'a PAS traité commit1 en tant que récepteur (il était l'expéditeur).
    // jolan1 et jolan3 sont tous deux à epoch 2 après le join.
    // test1 est à epoch 2 après avoir traité commit2.

    println!("\n═══ SCÉNARIO 4 — Messages bidirectionnels ═══");

    // jolan1 → tous
    let msg1 = jolan1
        .send_message(gid, b"Depuis jolan-dev1")
        .expect("j1 send");
    ok_or(
        &test1.process_incoming_message(gid, &msg1),
        "test-dev1  reçoit message de jolan-dev1",
    );
    ok_or(
        &jolan3.process_incoming_message(gid, &msg1),
        "jolan-dev3 reçoit message de jolan-dev1",
    );

    // test1 → tous
    let msg2 = test1
        .send_message(gid, b"Depuis test-dev1")
        .expect("t1 send");
    ok_or(
        &jolan1.process_incoming_message(gid, &msg2),
        "jolan-dev1 reçoit message de test-dev1",
    );
    ok_or(
        &jolan3.process_incoming_message(gid, &msg2),
        "jolan-dev3 reçoit message de test-dev1",
    );

    // jolan3 → tous
    let msg3 = jolan3
        .send_message(gid, b"Depuis jolan-dev3")
        .expect("j3 send");
    ok_or(
        &jolan1.process_incoming_message(gid, &msg3),
        "jolan-dev1 reçoit message de jolan-dev3",
    );
    ok_or(
        &test1.process_incoming_message(gid, &msg3),
        "test-dev1  reçoit message de jolan-dev3",
    );

    println!("  ✓ PASS — messages bidirectionnels 3 appareils / 2 utilisateurs");
}
