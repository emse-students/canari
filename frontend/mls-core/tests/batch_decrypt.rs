//! Batch decrypt tests (Phase 3 S5).

use mls_core::MlsManager;

fn make_manager(user_id: &str, device_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, device_id, None)
        .unwrap_or_else(|e| panic!("make_manager({user_id}:{device_id}): {e}"))
}

#[test]
fn process_incoming_messages_matches_sequential_decrypt() {
    let mut alice = make_manager("batch-alice", "dev-a");
    let mut bob = make_manager("batch-bob", "dev-b");
    let group_id = "batch-dm";

    alice
        .create_group(group_id.to_string())
        .expect("alice create_group");
    let kp = bob.generate_key_package().expect("bob key_package");
    let (_commit, welcome, _, ratchet_tree) = alice
        .add_members_bulk(group_id, &[&kp])
        .expect("add_members_bulk");
    bob.process_welcome(
        welcome.as_deref().expect("welcome"),
        ratchet_tree.as_deref(),
    )
    .expect("bob process_welcome");

    let mut ciphertexts = Vec::new();
    for i in 0..5 {
        let payload = format!("batch-msg-{i}");
        ciphertexts.push(
            bob.send_message(group_id, payload.as_bytes())
                .expect("send_message"),
        );
    }

    let message_refs: Vec<&[u8]> = ciphertexts.iter().map(|c| c.as_slice()).collect();
    let batch = alice.process_incoming_messages(group_id, &message_refs);

    assert_eq!(batch.len(), 5);
    for (i, outcome) in batch.iter().enumerate() {
        let plain = outcome.as_ref().expect("batch outcome ok").as_ref().expect("app msg");
        assert_eq!(plain, format!("batch-msg-{i}").as_bytes());
    }
}

#[test]
fn process_incoming_messages_captures_per_message_errors() {
    let mut alice = make_manager("batch-err-alice", "dev-a");
    let mut bob = make_manager("batch-err-bob", "dev-b");
    let group_id = "batch-err-dm";

    alice.create_group(group_id.to_string()).expect("create");
    let kp = bob.generate_key_package().expect("kp");
    let (_c, welcome, _, rt) = alice.add_members_bulk(group_id, &[&kp]).expect("add");
    bob.process_welcome(welcome.as_deref().expect("w"), rt.as_deref())
        .expect("welcome");

    let good = bob.send_message(group_id, b"ok").expect("send");
    let garbage = vec![0u8; 8];
    let refs = [good.as_slice(), garbage.as_slice()];
    let batch = alice.process_incoming_messages(group_id, &refs);

    assert!(batch[0].is_ok());
    assert!(batch[1].is_err());
}
