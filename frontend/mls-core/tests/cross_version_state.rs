//! THE GATE THAT LETS A PROTOCOL OR CRYPTO DEPENDENCY BE UPGRADED WITHOUT A HUMAN.
//!
//! Every other test in this crate builds its input with the SAME code it then exercises, so a
//! change to a wire format, an encoding or a key derivation moves both halves together and the
//! suite stays green. That is the exact hole `dependabot-auto-merge.yml` refuses `openmls`,
//! `tls_codec`, `hpke-rs`, `libcrux`, `chacha20poly1305`, `aes-gcm`, `argon2` and `ciborium` for:
//! any of them can change behaviour while compiling perfectly, and the first thing to notice would
//! be a member whose conversation stopped decrypting.
//!
//! The fixtures under `tests/fixtures/` are the missing evidence. They are BYTES, written once by
//! a version that is no longer the one under test and committed as they were. Nothing here
//! produces them - `examples/freeze_cross_version_fixtures.rs` does, it refuses to overwrite a
//! generation, and the version that wrote each one is in its filename.
//!
//! WHY FOUR FIXTURES AND NOT ONE. A single "does everything still work" assertion cannot say WHICH
//! crate moved, and a report that cannot separate the causes it covers is a day of bisecting. So
//! the at-rest envelope is frozen twice - once under a FIXED key, which moves only with the AEAD,
//! and once behind the PIN, which additionally moves with the derivation - and the MLS state and an
//! application frame are frozen separately, because a state that loads and a frame that decrypts
//! fail for different reasons. Read the failures together: the AEAD one failing alone accuses
//! `chacha20poly1305`; the PIN one failing while the AEAD one passes accuses `argon2`; the state
//! failing accuses `openmls`'s storage encoding or `ciborium`; the frame failing while the state
//! loads accuses the message wire format.
//!
//! THE FIXTURES ARE COMMITTED TO A PUBLIC REPOSITORY, AND THAT IS SAFE ON PURPOSE. The state blob
//! carries a signature keypair, but it is one the generator minted for the throwaway identity
//! `bob:dev1` in a group that exists nowhere else - no device, no server and no user has ever held
//! it. The PIN and the device key are likewise constants in `params.rs`, chosen to be readable
//! rather than secret. Nothing here may ever be regenerated from a real device's state.
//!
//! WHAT IT DOES NOT COVER, so nobody mistakes its scope: one generation of fixtures proves that
//! TODAY'S code reads what v0.14.14 wrote. It says nothing about whether today's code writes
//! something v0.14.14 could read, which is the other direction and matters when a fleet is mixed;
//! that needs the old binary, not an old fixture. And it pins one group at one epoch, not the whole
//! protocol.

#[path = "cross_version/params.rs"]
mod params;

use mls_core::MlsManager;
use mls_core::security::{decrypt_blob, derive_key_from_pin_owned};

/// Reads one frozen artefact. A missing file is a hard failure rather than a skip: a fixture that
/// silently stops being read is a gate that silently stops existing.
fn fixture(suffix: &str) -> Vec<u8> {
    let path = std::path::Path::new(params::FIXTURE_DIR)
        .join(format!("{}-{suffix}", params::FIXTURE_VERSION));
    std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "missing fixture {}: {e}. It is committed evidence, not a build artefact - restore it \
             from git rather than regenerating, which would make this test a round-trip.",
            path.display()
        )
    })
}

#[test]
fn the_aead_still_opens_what_a_previous_version_sealed() {
    // Fixed key, so nothing but the AEAD itself is under test. If this fails alone,
    // `chacha20poly1305` changed its nonce layout, tag placement or construction.
    let sealed = fixture(params::DEVICE_KEY_ENVELOPE);

    let opened = decrypt_blob(&params::DEVICE_KEY, &sealed)
        .expect("the at-rest envelope written by a previous version no longer opens");

    assert_eq!(opened, params::SEALED_PLAINTEXT);
}

#[test]
fn the_pin_derivation_still_opens_what_a_previous_version_sealed() {
    // Same plaintext, but the key is DERIVED. Failing here while the test above passes accuses
    // `argon2`: a changed memory cost, time cost, parallelism or variant yields a different key
    // and locks every pre-v0.11.0 install out of its own history.
    let blob = fixture(params::PIN_ENVELOPE);
    assert!(
        blob.len() > 16,
        "the legacy envelope carries its salt first"
    );

    let (salt, sealed) = blob.split_at(16);
    let key = derive_key_from_pin_owned(params::PIN.to_string(), salt)
        .expect("re-derive from the embedded salt");

    let opened = decrypt_blob(&key, sealed)
        .expect("the legacy PIN envelope written by a previous version no longer opens");

    assert_eq!(opened, params::SEALED_PLAINTEXT);
}

#[test]
fn a_group_state_written_by_a_previous_version_still_loads() {
    // `PersistedState.storage_values` is openmls's own storage, key and value, as it encoded them.
    // Loading it exercises that encoding, the CBOR container around it, and the TLS
    // serialisation of the identity - so a failure here accuses `openmls`, `tls_codec` or
    // `ciborium` rather than anything this crate owns.
    let state = fixture(params::PEER_STATE);

    let restored = MlsManager::load_or_create(params::PEER_USER, params::PEER_DEVICE, Some(state))
        .expect("a state written by a previous version no longer loads");

    let epoch = restored
        .get_epoch(params::GROUP_ID)
        .expect("the restored state no longer knows its group");

    assert_eq!(
        epoch,
        params::EXPECTED_EPOCH,
        "the group loaded but at a different epoch, which means the state was read wrong rather \
         than not at all"
    );
}

#[test]
fn a_frame_written_by_a_previous_version_still_decrypts() {
    // The one that matters most, and the only one that exercises the MESSAGE path: a restored
    // member opening traffic minted before the upgrade. Its state was saved BEFORE this frame was
    // processed, so the ratchet really has to advance here.
    let state = fixture(params::PEER_STATE);
    let frame = fixture(params::APPLICATION_FRAME);

    let mut restored =
        MlsManager::load_or_create(params::PEER_USER, params::PEER_DEVICE, Some(state))
            .expect("restore the frozen member");

    let plaintext = restored
        .process_incoming_message(params::GROUP_ID, &frame)
        .expect("a frame written by a previous version no longer decrypts")
        .expect("the frame carried an application payload and must not read as empty");

    assert_eq!(plaintext, params::MESSAGE);
}
