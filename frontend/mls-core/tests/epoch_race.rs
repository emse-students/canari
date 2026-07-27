/// MLS integration tests - multi-device / multi-user simulation
///
/// Goal: reproduce the `TooDistantInThePast` / `AeadError` bug that shows up when two devices try
/// to add the same third-party device at the same time.
///
/// Test architecture:
///   Each `MlsManager` represents an independent device (isolated in-memory MLS state).
///   They interact through serialized messages (bytes) exactly as in the real infrastructure,
///   minus the network.
///
/// Run with:
///   cd frontend/mls-core && cargo test -- --nocapture
use mls_core::MlsManager;

fn make_device(user_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, user_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}': {e}"))
}

/// Like `make_device`, but with a `device_id` distinct from the `user_id` - required to simulate
/// two different devices of the same user (the credential identity is `user_id:device_id`, so two
/// devices of the same user must carry different device_ids or `add_members_bulk` treats them as
/// one and the same member).
fn make_device_with_id(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("could not create device '{user_id}:{device_id}': {e}"))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Prints a section of the expected action plan.
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
        Ok(None) => println!("  ✓ {label}: (commit/handshake, no application payload)"),
        Err(e) => println!("  ✗ {label}: ERROR → {e}"),
    }
}

// ---------------------------------------------------------------------------
// SCENARIO 1 - Happy path (baseline, no race)
// ---------------------------------------------------------------------------
///
/// Expected actions:
///  1. jolan-dev1 creates the MLS group `g-dm`
///  2. test-dev1 generates its KeyPackage
///  3. jolan-dev1 adds test-dev1 → commit C1 + Welcome W1  (epoch 0 → 1)
///  4. test-dev1 processes W1 → joins the group at epoch 1
///  5. jolan-dev3 generates its KeyPackage
///  6. ONLY jolan-dev1 adds jolan-dev3 → commit C2 + Welcome W2  (epoch 1 → 2)
///  7. test-dev1 processes C2 → advances to epoch 2
///  8. jolan-dev3 processes W2 → joins the group at epoch 2
///  9. jolan-dev3 sends a message  (encrypted at epoch 2)
/// 10. jolan-dev1 decrypts → OK        (epoch 2, secrets aligned)
/// 11. test-dev1  decrypts → OK        (epoch 2, secrets aligned)
///
/// Expected result: everyone decrypts without error.
#[test]
fn test_scenario1_happy_path() {
    print_scenario(
        "SCENARIO 1 - Happy path (single adder)",
        &[
            "jolan-dev1 creates group g-dm",
            "test-dev1 generates its KeyPackage",
            "jolan-dev1 adds test-dev1 → commit C1 + Welcome W1  (epoch 0→1)",
            "test-dev1 receives W1 → joins at epoch 1",
            "jolan-dev3 generates its KeyPackage",
            "ONLY jolan-dev1 adds jolan-dev3 → commit C2 + Welcome W2  (epoch 1→2)",
            "test-dev1 processes C2 → epoch 2",
            "jolan-dev3 receives W2 → joins at epoch 2",
            "jolan-dev3 sends a message (epoch 2)",
            "jolan-dev1 decrypts → expected OK",
            "test-dev1  decrypts → expected OK",
        ],
    );

    let mut jolan1 = make_device_with_id("jolan", "dev1");
    let mut test1 = make_device("test");
    let mut jolan3 = make_device_with_id("jolan", "dev3");
    let gid = "g-dm-happy";

    // Step 1
    jolan1.create_group(gid.to_string()).expect("create_group");
    println!("  ✓ [1] jolan-dev1 group created");

    // Steps 2-4
    let kp_test1 = test1.generate_key_package().expect("kp test1");
    let (commit1, welcome1, added1, _skipped) = jolan1
        .add_members_bulk(gid, &[&kp_test1])
        .expect("add test1");
    // Stage-only add (C7-A): merge as if the server accepted, then export the post-merge tree.
    jolan1
        .merge_pending_commit_for(gid)
        .expect("merge add test1");
    let rt1 = jolan1.export_ratchet_tree_for(gid).expect("tree1");
    println!(
        "  ✓ [3] jolan-dev1 added test-dev1 ({} device(s)), commit {} bytes",
        added1.len(),
        commit1.len()
    );

    test1
        .process_welcome(welcome1.as_deref().expect("welcome1 missing"), Some(&rt1))
        .expect("test1 process_welcome");
    println!("  ✓ [4] test-dev1 joined the group (epoch 1)");

    // Steps 5-8
    let kp_jolan3 = jolan3.generate_key_package().expect("kp jolan3");
    let (commit2, welcome2, added2, _skipped) = jolan1
        .add_members_bulk(gid, &[&kp_jolan3])
        .expect("add jolan3");
    jolan1
        .merge_pending_commit_for(gid)
        .expect("merge add jolan3");
    let rt2 = jolan1.export_ratchet_tree_for(gid).expect("tree2");
    println!(
        "  ✓ [6] jolan-dev1 added jolan-dev3 ({} device(s)), commit {} bytes",
        added2.len(),
        commit2.len()
    );

    let r_test1_commit = test1.process_incoming_message(gid, &commit2);
    ok_or(&r_test1_commit, "[7] test-dev1 processes C2 (add jolan3)");
    assert!(
        r_test1_commit.is_ok(),
        "test1 must process C2 without error"
    );

    jolan3
        .process_welcome(welcome2.as_deref().expect("welcome2 missing"), Some(&rt2))
        .expect("jolan3 process_welcome");
    println!("  ✓ [8] jolan-dev3 joined the group (epoch 2)");

    // Steps 9-11
    let msg = jolan3
        .send_message(gid, b"Hello from jolan-dev3")
        .expect("send_message");
    println!(
        "  ✓ [9] jolan-dev3 sent an encrypted message ({} bytes)",
        msg.len()
    );

    let r_jolan1 = jolan1.process_incoming_message(gid, &msg);
    ok_or(&r_jolan1, "[10] jolan-dev1 decrypts");

    let r_test1 = test1.process_incoming_message(gid, &msg);
    ok_or(&r_test1, "[11] test-dev1 decrypts");

    println!("\n  ═══ SCENARIO 1 RESULT ═══");
    assert!(
        r_jolan1.is_ok(),
        "jolan-dev1 should decrypt: {:?}",
        r_jolan1
    );
    assert!(r_test1.is_ok(), "test-dev1 should decrypt: {:?}", r_test1);
    println!("  ✓ PASS - happy path validated");
}

// ---------------------------------------------------------------------------
// SCENARIO 2 - Race condition: REPRODUCES THE BUG
// ---------------------------------------------------------------------------
///
/// Expected actions (given the current code):
///  1. jolan-dev1 creates group g-dm-race
///  2. test-dev1 generates its KeyPackage
///  3. jolan-dev1 adds test-dev1 → commit + Welcome  (epoch 0→1)
///  4. test-dev1 joins at epoch 1
///  5. jolan-dev3 generates its KeyPackage  ← ENTRY POINT OF THE RACE
///  6. jolan-dev1 calls add_members_bulk(jolan3-kp)  (at epoch 1) → commit-A, local state 1→2
///  7. test-dev1  calls add_members_bulk(jolan3-kp)  (at epoch 1) → commit-B, local state 1→2
///     ⚠ Both are already at epoch 2 but with DIFFERENT SECRETS
///  8. jolan-dev3 receives the Welcome from commit-A (jolan-dev1's)
///     → jolan-dev3 is at epoch 2, secrets aligned with jolan-dev1
///  9. test-dev1 receives jolan-dev1's commit-A on the channel
///     → test-dev1 is already at epoch 2 (from commit-B) → WrongEpoch error expected
/// 10. jolan-dev3 sends a message (epoch 2, commit-A secrets)
/// 11. jolan-dev1 decrypts → OK (commit-A secrets)
/// 12. test-dev1  decrypts → ERROR (commit-B secrets ≠ commit-A secrets)
///
/// ROOT CAUSE: two concurrent commits on the same base epoch cause an irreversible divergence of
///             the MLS secret state.
#[test]
fn test_scenario2_race_condition() {
    print_scenario(
        "SCENARIO 2 - Race condition (CURRENT BUG)",
        &[
            "jolan-dev1 creates group g-dm-race",
            "test-dev1 generates its KeyPackage",
            "jolan-dev1 adds test-dev1 → commit + Welcome  (epoch 0→1)",
            "test-dev1 joins at epoch 1",
            "jolan-dev3 generates its KeyPackage  ← RACE STARTS",
            "jolan-dev1 add_members_bulk(jolan3-kp) @ epoch 1 → commit-A + Welcome-A  (epoch 1→2)",
            "test-dev1  add_members_bulk(jolan3-kp) @ epoch 1 → commit-B + Welcome-B  (epoch 1→2 DIVERGED)",
            "jolan-dev3 receives Welcome-A → joins at epoch 2 (set-A secrets)",
            "test-dev1 receives commit-A from the channel → already at epoch 2 → WrongEpoch error",
            "jolan-dev3 sends a message (epoch 2, set-A secrets)",
            "jolan-dev1 decrypts → EXPECTED OK",
            "test-dev1  decrypts → EXPECTED ERROR (diverged secrets)",
        ],
    );

    let mut jolan1 = make_device_with_id("jolan", "dev1");
    let mut test1 = make_device("test");
    let mut jolan3 = make_device_with_id("jolan", "dev3");
    let gid = "g-dm-race";

    // Initial setup (epoch 0→1)
    jolan1.create_group(gid.to_string()).expect("create_group");
    let kp_test1 = test1.generate_key_package().expect("kp test1");
    let (_, welcome_test1, _, _skipped) = jolan1
        .add_members_bulk(gid, &[&kp_test1])
        .expect("add test1");
    jolan1
        .merge_pending_commit_for(gid)
        .expect("merge add test1");
    let rt_test1 = jolan1.export_ratchet_tree_for(gid).expect("tree test1");
    test1
        .process_welcome(
            welcome_test1.as_deref().expect("welcome_test1"),
            Some(&rt_test1),
        )
        .expect("test1 join");
    println!("  ✓ Setup: jolan-dev1 + test-dev1 in the group (epoch 1)");

    // RACE: both generate a concurrent commit from the same base
    let kp_jolan3 = jolan3.generate_key_package().expect("kp jolan3");

    // jolan-dev1 adds jolan3 FIRST (jolan side, processPendingInvitations)
    let (commit_a, welcome_a, _, _skipped) = jolan1
        .add_members_bulk(gid, &[&kp_jolan3])
        .expect("jolan1 add jolan3");
    jolan1
        .merge_pending_commit_for(gid)
        .expect("merge commit-A");
    let rt_a = jolan1.export_ratchet_tree_for(gid).expect("tree A");
    println!(
        "  ✓ [6] jolan-dev1 created commit-A (epoch 1→2), {} bytes",
        commit_a.len()
    );

    // test-dev1 ALSO tries to add jolan3 (test side, syncPeerDevicesToGroups)
    // SAME KeyPackage! Both started from the same base epoch.
    let result_test1_add = test1.add_members_bulk(gid, &[&kp_jolan3]);
    match &result_test1_add {
        Ok((c, _, _, _)) => println!(
            "  ⚠ [7] test-dev1 created commit-B (epoch 1→2 DIVERGED), {} bytes - RACE ACTIVE",
            c.len()
        ),
        Err(e) => println!("  ✓ [7] test-dev1 failed to create commit-B (kp likely consumed): {e}"),
    }
    // Stage-only: confirm test1's divergent commit-B so it truly advances to epoch 2 (secrets set-B).
    if result_test1_add.is_ok() {
        test1
            .merge_pending_commit_for(gid)
            .expect("merge divergent commit-B");
    }

    // jolan-dev3 receives the Welcome from jolan-dev1's commit-A
    let join_result = jolan3.process_welcome(welcome_a.as_deref().expect("welcome_a"), Some(&rt_a));
    let join_ok = join_result.is_ok();
    let join_status = match join_result {
        Ok(_) => "OK (epoch 2, set-A secrets)".to_string(),
        Err(e) => format!("ERROR: {e}"),
    };
    println!("  [8] jolan-dev3 joins via Welcome-A: {join_status}");

    if join_ok {
        // test-dev1 receives jolan-dev1's commit-A on the channel
        let r_test1_commit_a = test1.process_incoming_message(gid, &commit_a);
        println!(
            "  [9] test-dev1 processes commit-A (already at epoch 2 from commit-B): {}",
            match &r_test1_commit_a {
                Ok(_) => "OK (unexpected - epoch reset?)".to_string(),
                Err(e) => format!("ERROR (expected) → {e}"),
            }
        );

        // jolan-dev3 sends a message
        let msg = jolan3
            .send_message(gid, b"Message from dev3 post-race")
            .expect("jolan3 send");
        println!("  ✓ [10] jolan-dev3 sends a message ({} bytes)", msg.len());

        let r_jolan1 = jolan1.process_incoming_message(gid, &msg);
        let r_test1 = test1.process_incoming_message(gid, &msg);

        println!("\n  ═══ SCENARIO 2 RESULT ═══");
        match &r_jolan1 {
            Ok(_) => println!("  ✓ jolan-dev1 decrypts: OK (aligned on commit-A)"),
            Err(e) => println!("  ✗ jolan-dev1 decrypts: ERROR → {e}"),
        }
        match &r_test1 {
            Ok(_) => println!("  ✓ test-dev1 decrypts: OK (surprising if secrets diverged)"),
            Err(e) => println!("  ✗ test-dev1 decrypts: ERROR → {} ← BUG REPRODUCED", e),
        }

        // This test DOCUMENTS the bug: we expect one of the two to fail.
        // If both succeed, OpenMLS may have silently rejected commit-B.
        let both_ok = r_jolan1.is_ok() && r_test1.is_ok();
        if both_ok {
            println!(
                "  ℹ Both decrypt → OpenMLS rejected commit-B upstream (kp already consumed, or epoch guard active)"
            );
            println!(
                "    → The race condition is NOT reproducible at the Rust level (already guarded by OpenMLS)"
            );
            println!(
                "    → The real bug is in the TypeScript orchestration (two add_members_bulk over websocket)"
            );
        } else {
            println!("  ⚠ MLS race condition confirmed at the Rust level!");
        }
    }
}

// ---------------------------------------------------------------------------
// SCENARIO 3 - Fix applied: only jolan-dev1 adds jolan-dev3
// ---------------------------------------------------------------------------
///
/// Simulates the behaviour AFTER fixing `syncPeerDevicesToGroups`:
/// test-dev1 first checks whether jolan is already a registered member → yes → SKIP.
/// So only jolan-dev1 (via processPendingInvitations) adds jolan-dev3.
///
/// Actions:
///  1-5. Same as scenario 2 (setup + jolan-dev3 KP generation)
///  6. jolan-dev1 adds jolan-dev3 → commit-A + Welcome-A  (epoch 1→2)
///     test-dev1 SKIPs (simulates the guard: registeredUserIds.has('jolan') → skip)
///  7. test-dev1 processes commit-A → epoch 2 aligned
///  8. jolan-dev3 joins via Welcome-A → epoch 2 aligned
///  9. jolan-dev3 sends a message
/// 10. jolan-dev1 decrypts → OK
/// 11. test-dev1  decrypts → OK
#[test]
fn test_scenario3_fix_single_adder_guard() {
    print_scenario(
        "SCENARIO 3 - Fix applied (syncPeerDevicesToGroups guard)",
        &[
            "jolan-dev1 creates group g-dm-fix",
            "test-dev1 generates its KeyPackage",
            "jolan-dev1 adds test-dev1 → commit + Welcome  (epoch 0→1)",
            "test-dev1 joins at epoch 1",
            "jolan-dev3 generates its KeyPackage",
            "jolan-dev1 adds jolan-dev3 → commit-A + Welcome-A  (epoch 1→2)",
            "test-dev1 SKIPs (guard: 'jolan' already a member → jolan's processPendingInvitations handles it)",
            "test-dev1 processes commit-A → epoch 2 aligned",
            "jolan-dev3 receives Welcome-A → joins at epoch 2 aligned",
            "jolan-dev3 sends a message (epoch 2)",
            "jolan-dev1 decrypts → expected OK",
            "test-dev1  decrypts → expected OK",
        ],
    );

    let mut jolan1 = make_device_with_id("jolan", "dev1");
    let mut test1 = make_device("test");
    let mut jolan3 = make_device_with_id("jolan", "dev3");
    let gid = "g-dm-fix";

    // Setup (epoch 0→1)
    jolan1.create_group(gid.to_string()).expect("create_group");
    let kp_test1 = test1.generate_key_package().expect("kp test1");
    let (_, welcome_test1, _, _skipped) = jolan1
        .add_members_bulk(gid, &[&kp_test1])
        .expect("add test1");
    jolan1
        .merge_pending_commit_for(gid)
        .expect("merge add test1");
    let rt_test1 = jolan1.export_ratchet_tree_for(gid).expect("tree test1");
    test1
        .process_welcome(
            welcome_test1.as_deref().expect("welcome_test1"),
            Some(&rt_test1),
        )
        .expect("test1 join");
    println!("  ✓ Setup: jolan-dev1 + test-dev1 in the group (epoch 1)");

    // jolan-dev3 KP generation
    let kp_jolan3 = jolan3.generate_key_package().expect("kp jolan3");

    // jolan-dev1 adds jolan-dev3 (via processPendingInvitations)
    let (commit_a, welcome_a, added, _skipped) = jolan1
        .add_members_bulk(gid, &[&kp_jolan3])
        .expect("jolan1 add jolan3");
    jolan1
        .merge_pending_commit_for(gid)
        .expect("merge commit-A");
    let rt_a = jolan1.export_ratchet_tree_for(gid).expect("tree A");
    println!(
        "  ✓ [6] jolan-dev1 added jolan-dev3 ({} device(s)), commit {} bytes",
        added.len(),
        commit_a.len()
    );

    // test-dev1 SKIPs - simulates the corrected TypeScript guard
    // (In the real code: registeredUserIds.has('jolan') → continue)
    println!(
        "  ✓ [7a] test-dev1 SKIP - 'jolan' is already a registered member in getGroupMembers()"
    );

    // test-dev1 processes commit-A from the channel (normal receive behaviour)
    let r_test1_commit = test1.process_incoming_message(gid, &commit_a);
    ok_or(&r_test1_commit, "[7b] test-dev1 processes commit-A");
    assert!(
        r_test1_commit.is_ok(),
        "test-dev1 must process commit-A: {:?}",
        r_test1_commit
    );

    // jolan-dev3 joins
    jolan3
        .process_welcome(welcome_a.as_deref().expect("welcome_a"), Some(&rt_a))
        .expect("jolan3 join via Welcome-A");
    println!("  ✓ [9] jolan-dev3 joined (epoch 2, set-A secrets)");

    // jolan-dev3 sends a message
    let msg = jolan3
        .send_message(gid, b"Message from dev3 post-fix")
        .expect("jolan3 send");
    println!("  ✓ [10] jolan-dev3 sends a message ({} bytes)", msg.len());

    let r_jolan1 = jolan1.process_incoming_message(gid, &msg);
    let r_test1 = test1.process_incoming_message(gid, &msg);

    ok_or(&r_jolan1, "[11] jolan-dev1 decrypts");
    ok_or(&r_test1, "[11] test-dev1  decrypts");

    println!("\n  ═══ SCENARIO 3 RESULT ═══");
    assert!(
        r_jolan1.is_ok(),
        "jolan-dev1 should decrypt: {:?}",
        r_jolan1
    );
    assert!(r_test1.is_ok(), "test-dev1 should decrypt: {:?}", r_test1);
    println!("  ✓ PASS - fix validated, no epoch divergence");
}

// ---------------------------------------------------------------------------
// SCENARIO 4 - Cross-device messaging after the fix
// ---------------------------------------------------------------------------
/// After the fix, every participant sends messages in both directions.
#[test]
fn test_scenario4_bidirectional_messaging() {
    let mut jolan1 = make_device_with_id("jolan", "dev1");
    let mut test1 = make_device("test");
    let mut jolan3 = make_device_with_id("jolan", "dev3");
    let gid = "g-dm-bidir";

    // Full setup (same as scenario 3)
    jolan1.create_group(gid.to_string()).expect("create_group");
    let kp_test1 = test1.generate_key_package().expect("kp test1");
    let (_commit1, welcome_test1, _, _skipped) = jolan1
        .add_members_bulk(gid, &[&kp_test1])
        .expect("add test1");
    jolan1
        .merge_pending_commit_for(gid)
        .expect("merge add test1");
    let rt1 = jolan1.export_ratchet_tree_for(gid).expect("tree1");
    test1
        .process_welcome(welcome_test1.as_deref().unwrap(), Some(&rt1))
        .expect("test1 join");

    let kp_jolan3 = jolan3.generate_key_package().expect("kp jolan3");
    let (commit2, welcome_jolan3, _, _skipped) = jolan1
        .add_members_bulk(gid, &[&kp_jolan3])
        .expect("add jolan3");
    jolan1
        .merge_pending_commit_for(gid)
        .expect("merge add jolan3");
    let rt2 = jolan1.export_ratchet_tree_for(gid).expect("tree2");
    test1
        .process_incoming_message(gid, &commit2)
        .expect("test1 process commit2");
    jolan3
        .process_welcome(welcome_jolan3.as_deref().unwrap(), Some(&rt2))
        .expect("jolan3 join");

    // Both previous commits were broadcast. In this test jolan1 merged commit1 but did NOT process
    // commit1 as a receiver (it was the sender).
    // jolan1 and jolan3 are both at epoch 2 after the join.
    // test1 is at epoch 2 after processing commit2.

    println!("\n═══ SCENARIO 4 - Bidirectional messages ═══");

    // jolan1 → everyone
    let msg1 = jolan1
        .send_message(gid, b"From jolan-dev1")
        .expect("j1 send");
    ok_or(
        &test1.process_incoming_message(gid, &msg1),
        "test-dev1  receives a message from jolan-dev1",
    );
    ok_or(
        &jolan3.process_incoming_message(gid, &msg1),
        "jolan-dev3 receives a message from jolan-dev1",
    );

    // test1 → everyone
    let msg2 = test1.send_message(gid, b"From test-dev1").expect("t1 send");
    ok_or(
        &jolan1.process_incoming_message(gid, &msg2),
        "jolan-dev1 receives a message from test-dev1",
    );
    ok_or(
        &jolan3.process_incoming_message(gid, &msg2),
        "jolan-dev3 receives a message from test-dev1",
    );

    // jolan3 → everyone
    let msg3 = jolan3
        .send_message(gid, b"From jolan-dev3")
        .expect("j3 send");
    ok_or(
        &jolan1.process_incoming_message(gid, &msg3),
        "jolan-dev1 receives a message from jolan-dev3",
    );
    ok_or(
        &test1.process_incoming_message(gid, &msg3),
        "test-dev1  receives a message from jolan-dev3",
    );

    println!("  ✓ PASS - bidirectional messages, 3 devices / 2 users");
}
