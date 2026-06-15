//! Shared fixtures for `mls-core` Criterion benchmarks (Phase 3 baseline).

use mls_core::MlsManager;

/// MLS manager prepared for persistence benchmarks.
pub struct PersistenceFixture {
    pub manager: MlsManager,
    /// Size of the last plain CBOR snapshot (bytes), reported alongside results.
    pub plain_bytes_len: usize,
}

/// Alice manager plus ciphertexts from Bob for decrypt benchmarks.
pub struct DecryptFixture {
    pub receiver: MlsManager,
    pub ciphertexts: Vec<Vec<u8>>,
    pub group_id: String,
}

/// Creates a fresh device identity for benchmarks.
pub fn make_manager(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("make_manager({user_id}:{device_id}): {e}"))
}

/// Builds a realistic in-memory state: `group_count` solo groups + `key_package_pool` OTKPs.
pub fn build_persistence_fixture(group_count: usize, key_package_pool: usize) -> PersistenceFixture {
    let mut manager = make_manager("bench-user", "bench-device");

    for i in 0..group_count {
        let gid = format!("bench-group-{i}");
        manager
            .create_group(gid)
            .unwrap_or_else(|e| panic!("create_group({i}): {e}"));
    }

    if key_package_pool > 0 {
        manager
            .generate_key_packages(key_package_pool)
            .unwrap_or_else(|e| panic!("generate_key_packages({key_package_pool}): {e}"));
    }

    let plain = manager
        .save_state()
        .unwrap_or_else(|e| panic!("save_state (fixture sizing): {e}"));

    PersistenceFixture {
        manager,
        plain_bytes_len: plain.len(),
    }
}

/// Two-member group: Bob sends `message_count` app messages; Alice will decrypt them.
pub fn build_decrypt_fixture(message_count: usize) -> DecryptFixture {
    let mut alice = make_manager("bench-alice", "dev-a");
    let mut bob = make_manager("bench-bob", "dev-b");
    let group_id = "bench-dm".to_string();

    alice
        .create_group(group_id.clone())
        .expect("alice create_group");

    let kp = bob.generate_key_package().expect("bob key_package");
    let (_commit, welcome, _added, ratchet_tree) = alice
        .add_members_bulk(&group_id, &[&kp])
        .expect("alice add_members_bulk");

    bob.process_welcome(
        welcome.as_deref().expect("welcome bytes"),
        ratchet_tree.as_deref(),
    )
    .expect("bob process_welcome");

    let mut ciphertexts = Vec::with_capacity(message_count);
    for i in 0..message_count {
        let payload = format!("bench-msg-{i}");
        let ct = bob
            .send_message(&group_id, payload.as_bytes())
            .expect("bob send_message");
        ciphertexts.push(ct);
    }

    DecryptFixture {
        receiver: alice,
        ciphertexts,
        group_id,
    }
}
