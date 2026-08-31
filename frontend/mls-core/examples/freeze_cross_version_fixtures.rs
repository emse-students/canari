//! Writes the frozen artefacts that `tests/cross_version_state.rs` reads back.
//!
//! Run from the crate root, and ONLY when deliberately minting a new generation:
//!   cd frontend/mls-core && cargo run --example freeze_cross_version_fixtures
//!
//! IT IS AN EXAMPLE RATHER THAN AN `#[ignore]`d TEST ON PURPOSE. A test that does nothing unless an
//! environment variable is set reads as coverage on every review and executes on none, which is a
//! defect this repository has already paid for. An example is a tool, and nothing counts it as a
//! test.
//!
//! WHAT IT MUST NEVER DO IS OVERWRITE AN EXISTING GENERATION. The fixtures are evidence precisely
//! because the version that wrote them is not the version under test; regenerating them in place
//! turns the whole suite into a round-trip that passes by construction on any format change. So it
//! REFUSES to clobber, and minting a new set means bumping `FIXTURE_VERSION` in `params.rs` first,
//! keeping the old files, and pointing the test at whichever generations must still open.

#[path = "../tests/cross_version/params.rs"]
mod params;

use mls_core::MlsManager;
use mls_core::security::{decrypt_blob, derive_key_from_pin_owned, encrypt_blob, generate_salt};
use std::fs;
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(params::FIXTURE_DIR);
    fs::create_dir_all(&dir).expect("fixture directory");

    // ONE call: the state and the frame are a matched pair from a single group, and calling the
    // builder twice would freeze a state that has never seen the frame beside it.
    let (peer_state, application_frame) = build_peer_state_and_frame();

    let written = [
        (params::PEER_STATE, peer_state),
        (params::APPLICATION_FRAME, application_frame),
        (params::PIN_ENVELOPE, build_pin_envelope()),
        (params::DEVICE_KEY_ENVELOPE, build_device_key_envelope()),
    ];

    for (suffix, bytes) in written {
        let path = dir.join(format!("{}-{suffix}", params::FIXTURE_VERSION));
        assert!(
            !path.exists(),
            "{} already exists. Fixtures are never regenerated in place - bump FIXTURE_VERSION in \
             params.rs and mint a new generation beside this one, or the test stops proving \
             anything.",
            path.display()
        );
        fs::write(&path, &bytes).expect("write fixture");
        println!("wrote {} ({} bytes)", path.display(), bytes.len());
    }
}

/// Builds a two-member group, has the owner send one application frame, and returns the JOINER's
/// state snapshot taken BEFORE that frame is processed, together with the frame itself.
///
/// The ordering is the whole point: a state saved after decryption has already ratcheted past the
/// frame, and the pair would no longer test anything.
fn build_peer_state_and_frame() -> (Vec<u8>, Vec<u8>) {
    let mut owner = MlsManager::load_or_create(params::OWNER_USER, params::OWNER_DEVICE, None)
        .expect("create owner");
    let mut peer = MlsManager::load_or_create(params::PEER_USER, params::PEER_DEVICE, None)
        .expect("create peer");

    owner
        .create_group(params::GROUP_ID.to_string())
        .expect("create group");

    let peer_kp = peer.generate_key_package().expect("peer key package");
    let (_commit, welcome, _added, _skipped) = owner
        .add_members_bulk(params::GROUP_ID, &[&peer_kp])
        .expect("add the peer");
    owner
        .merge_pending_commit_for(params::GROUP_ID)
        .expect("merge the add");

    let tree = owner
        .export_ratchet_tree_for(params::GROUP_ID)
        .expect("ratchet tree");
    peer.process_welcome(welcome.as_deref().expect("a welcome"), Some(&tree))
        .expect("peer joins");

    let epoch = peer.get_epoch(params::GROUP_ID).expect("peer epoch");
    assert_eq!(
        epoch,
        params::EXPECTED_EPOCH,
        "the fixture group no longer lands on the epoch params.rs declares; fix one or the other \
         before minting a generation"
    );

    let frame = owner
        .send_message(params::GROUP_ID, params::MESSAGE)
        .expect("owner sends");

    // Saved BEFORE the peer sees the frame.
    let state = peer.save_state().expect("peer state");
    (state, frame)
}

/// The pre-v0.11.0 at-rest envelope: `[salt (16) || nonce (12) || ciphertext]`, sealed with
/// Argon2id(PIN, salt). Freezing it locks the derivation parameters as well as the AEAD.
fn build_pin_envelope() -> Vec<u8> {
    let salt = generate_salt().expect("legacy salt");
    let key = derive_key_from_pin_owned(params::PIN.to_string(), &salt).expect("derive from pin");
    let sealed = encrypt_blob(&key, params::SEALED_PLAINTEXT).expect("seal");

    let mut blob = Vec::with_capacity(salt.len() + sealed.len());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&sealed);
    blob
}

/// The current envelope: `[nonce (12) || ciphertext]` under a fixed key, so it moves only when the
/// AEAD does.
fn build_device_key_envelope() -> Vec<u8> {
    let sealed = encrypt_blob(&params::DEVICE_KEY, params::SEALED_PLAINTEXT).expect("seal");
    // A generator that writes an artefact nothing can open would be found by the test, one commit
    // later and with no clue why. Fail here instead.
    assert_eq!(
        decrypt_blob(&params::DEVICE_KEY, &sealed).expect("open what was just sealed"),
        params::SEALED_PLAINTEXT
    );
    sealed
}
