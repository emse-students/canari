//! `parse_message_group_id` reads the group a framed message names, in clear, without a key.
//!
//! A shut phone joins a key group from a salon push only when the seed frame the push carries is a
//! frame OF the group the push names (channel-encryption section 26) - so the reader must answer
//! for both framings a group carries (an application PrivateMessage, a commit PublicMessage) and
//! refuse what is not a framed protocol message at all.
use mls_core::MlsManager;

fn make_device(user_id: &str) -> MlsManager {
    MlsManager::load_or_create(user_id, "dev1", None)
        .unwrap_or_else(|e| panic!("device '{user_id}': {e}"))
}

#[test]
fn names_the_group_of_an_application_frame_and_of_a_commit_and_nothing_else() {
    let mut alice = make_device("alice-gid");
    let bob = make_device("bob-gid");
    let gid = "kg-message-group-id";
    alice.create_group(gid.to_string()).expect("create_group");
    let kp = bob.generate_key_package().expect("kp");
    let (commit, welcome, _added, _skipped) = alice.add_members_bulk(gid, &[&kp]).expect("add");
    alice.merge_pending_commit_for(gid).expect("merge");

    let frame = alice.send_message(gid, b"seed").expect("send");
    assert_eq!(
        MlsManager::parse_message_group_id(&frame).as_deref(),
        Some(gid)
    );
    assert_eq!(
        MlsManager::parse_message_group_id(&commit).as_deref(),
        Some(gid)
    );

    let welcome = welcome.expect("welcome");
    assert_eq!(
        MlsManager::parse_message_group_id(&welcome),
        None,
        "a Welcome names no group in clear"
    );
    assert_eq!(MlsManager::parse_message_group_id(b"not mls"), None);
}
