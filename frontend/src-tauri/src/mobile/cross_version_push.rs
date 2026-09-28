//! THE SRC-TAURI TWIN OF `mls-core/tests/cross_version_state.rs`, AND THE GATE THAT LETS `aes-gcm`
//! BE UPGRADED WITHOUT A HUMAN.
//!
//! Every other test in this crate seals its input with the same code it then opens it with, so a
//! change to the AEAD or to the key derivation moves both halves together and the suite stays
//! green. That is exactly the hole `dependabot-auto-merge.yml` refuses `aes-gcm` for, and the
//! refusal is not theoretical: a channel push is sealed by ANOTHER member's device and opened here,
//! so a construction that changed would show up as a notification that stopped arriving on one
//! device while every test passed.
//!
//! The fixtures under `tests/fixtures/` are the missing evidence. They are BYTES, frozen once and
//! committed as they were, and nothing in the assertions below produces them -
//! [`freeze_the_current_generation`] does, it refuses to overwrite a generation, and the version
//! that wrote each one is in its filename.
//!
//! WHY TWO FIXTURES AND NOT ONE. A single "a push still opens" assertion cannot say WHICH crate
//! moved, and a report that cannot separate the causes it covers is an afternoon of bisecting. The
//! first is sealed under a FIXED key, so it moves only with the AEAD. The second is sealed under a
//! key DERIVED from a Graine seed, so it moves with the AEAD *or* with the HKDF. Read the two
//! failures together: the fixed-key one failing accuses `aes-gcm`; the derived one failing while
//! the fixed-key one passes accuses `hkdf`/`sha2` or a change to `derive_message_key` itself, and
//! that one locks every member out of a community channel rather than out of one message.
//!
//! THE FIXTURES ARE COMMITTED TO A PUBLIC REPOSITORY, AND THAT IS SAFE ON PURPOSE. The key, the
//! nonce and the seed below are constants chosen to be readable rather than secret; they have never
//! been a device's key, a session's seed or anything a server has seen. Nothing here may ever be
//! regenerated from real traffic.
//!
//! BOTH DIRECTIONS ARE COVERED HERE, AND THAT IS WHY THIS FILE RETIRES A CEILING ROW RATHER THAN
//! NARROWING IT. Opening a frozen artefact proves today's code reads what v0.14.14 wrote. The other
//! direction - whether a device still on v0.14.14 can read what today's code writes - normally needs
//! the old binary, which is why `openmls` stays refused. It does not here, because AES-256-GCM is
//! DETERMINISTIC: sealing the frozen plaintext under the frozen key and nonce must reproduce the
//! frozen bytes, and [`todays_seal_is_byte_identical_to_the_frozen_one`] asserts exactly that. Equal
//! bytes are equal in both directions; a protocol that may ADD fields is not.
//!
//! WHAT IT STILL DOES NOT COVER, so nobody reads more into a green run than it earns: one message,
//! one key, one nonce. It pins the CONSTRUCTION, not every code path that reaches it, and it says
//! nothing about the MLS wire format beside it.

use std::path::PathBuf;

use super::background::decrypt_channel_message;
use super::graine::derive_message_key;
use super::proto_fields::build_text_app_message;

/// The generation these fixtures were frozen at. It is in every filename, so a future generation
/// sits beside this one rather than replacing it.
const FIXTURE_VERSION: &str = "v0.14.14";

/// Fixed 32-byte channel key. Readable rather than random: nothing here is a secret, and a constant
/// that can be retyped from the page is one nobody is tempted to regenerate.
const CHANNEL_KEY: [u8; 32] = [0x2a; 32];

/// Fixed 12-byte nonce. A push carries its nonce beside the ciphertext, and freezing it is what
/// makes the fixture a byte-for-byte record rather than a recipe.
const NONCE: [u8; 12] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
];

/// The Graine session the derived-key fixture belongs to. The seed is a constant for the same
/// reason the channel key is.
const GRAINE_SEED: [u8; 32] = [0x5e; 32];
const GRAINE_SESSION: &str = "cross-version-fixture-session";
const GRAINE_INDEX: u32 = 7;

/// The plaintext both fixtures carry, as the encoded `AppMessage` a real push would hold. The
/// assertions read it back through `extract_full_message_info`, which is the function the native
/// notification handler actually calls - so a proto-parsing change is caught here too.
const MESSAGE_ID: &str = "cross-version-fixture-msg";
const SENT_AT: i64 = 1_700_000_000_000;
const TEXT: &str = "a channel push frozen at v0.14.14";

const CHANNEL_FIXTURE: &str = "channel-push.bin";
const GRAINE_FIXTURE: &str = "graine-push.bin";

/// The committed layout of a frozen push: `[nonce (12) || ciphertext||tag]`, one file per case.
///
/// It mirrors the at-rest envelope in `mls_core::security` deliberately. A push carries the two
/// halves separately on the wire, but a fixture is a single artefact or it is two artefacts that
/// can drift apart in git.
fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(format!("{FIXTURE_VERSION}-{name}"))
}

/// Reads one frozen artefact and splits it into `(nonce, ciphertext)`.
///
/// A missing file is a hard failure rather than a skip: a fixture that silently stops being read is
/// a gate that silently stops existing.
fn frozen(name: &str) -> (Vec<u8>, Vec<u8>) {
    let path = fixture_path(name);
    let blob = std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "missing fixture {}: {e}. It is committed evidence, not a build artefact - restore it \
             from git rather than regenerating, which would turn this test into a round-trip.",
            path.display()
        )
    });
    assert!(
        blob.len() > 12,
        "a frozen push carries its 12-byte nonce first, and {} is {} bytes",
        path.display(),
        blob.len()
    );
    let (nonce, ciphertext) = blob.split_at(12);
    (nonce.to_vec(), ciphertext.to_vec())
}

/// Asserts that `info` is the message the fixtures were frozen around.
///
/// The metadata is checked as well as the text because `decrypt_channel_message` returns whatever
/// `extract_full_message_info` produced, and a parser that lost a field while keeping the body
/// would still hand the user a plausible-looking banner.
fn assert_is_the_frozen_message(info: &serde_json::Value) {
    assert_eq!(info["ok"], true, "the frozen push did not parse");
    assert_eq!(info["type"], "text");
    assert_eq!(info["text"], TEXT);
    assert_eq!(info["messageId"], MESSAGE_ID);
    assert_eq!(info["sentAt"], SENT_AT);
}

#[test]
fn the_channel_aead_still_opens_what_a_previous_version_sealed() {
    // Fixed key, so nothing but AES-256-GCM itself is under test. If this fails, the crate changed
    // its tag placement, its nonce handling or its construction, and every channel push sealed by a
    // device still on the old build stops opening on the new one.
    let (nonce, ciphertext) = frozen(CHANNEL_FIXTURE);

    let info = decrypt_channel_message(&CHANNEL_KEY, &nonce, &ciphertext)
        .expect("a channel push sealed by a previous version no longer opens");

    assert_is_the_frozen_message(&info);
}

#[test]
fn the_graine_derivation_still_opens_what_a_previous_version_sealed() {
    // Same plaintext, but the key is DERIVED from the session seed. Failing here while the test
    // above passes accuses the HKDF rather than the AEAD - a changed salt, info string or hash
    // yields a different key, and the whole community channel goes dark rather than one message.
    let (nonce, ciphertext) = frozen(GRAINE_FIXTURE);

    let key = derive_message_key(&GRAINE_SEED, GRAINE_SESSION, GRAINE_INDEX)
        .expect("the frozen seed no longer derives a key");
    let info = decrypt_channel_message(&key, &nonce, &ciphertext)
        .expect("a Graine push sealed by a previous version no longer opens");

    assert_is_the_frozen_message(&info);
}

/// THE FORWARD DIRECTION, WHICH FOR A DETERMINISTIC AEAD IS PROVABLE RATHER THAN ARGUABLE.
///
/// The two tests above prove today's code opens what v0.14.14 sealed. They say nothing, on their
/// own, about the other direction - whether a device still on v0.14.14 can open what today's code
/// seals - and that is the direction a mixed fleet lives in. For a protocol it needs an old binary,
/// which is why `openmls` stays refused. For a raw AEAD it does not: AES-256-GCM is deterministic,
/// so sealing the frozen plaintext under the frozen key and nonce must reproduce the frozen bytes
/// EXACTLY. If it does, the construction is unchanged and both directions follow; if it does not,
/// an old device would fail to open a push minted today, and this test is what says so.
///
/// This is the assertion that lets `aes-gcm` be upgraded unattended, and it is deliberately written
/// against the committed file rather than against a re-seal of a re-seal.
#[test]
fn todays_seal_is_byte_identical_to_the_frozen_one() {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    let plaintext = build_text_app_message(MESSAGE_ID, SENT_AT, TEXT);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&CHANNEL_KEY));
    let sealed = cipher
        .encrypt(Nonce::from_slice(&NONCE), plaintext.as_slice())
        .expect("seal under the frozen key and nonce");

    let (frozen_nonce, frozen_ciphertext) = frozen(CHANNEL_FIXTURE);

    assert_eq!(
        frozen_nonce, NONCE,
        "the fixture's nonce is not the constant it was frozen with"
    );
    assert_eq!(
        sealed, frozen_ciphertext,
        "sealing the frozen plaintext under the frozen key and nonce no longer reproduces the          frozen bytes. A device on v0.14.14 cannot open a push this build seals."
    );
}

/// A fixture that a wrong key opens would prove nothing, so this states the obvious out loud.
///
/// It is the falsification the two tests above cannot perform on themselves: without it, a
/// `decrypt_channel_message` that returned the plaintext regardless of the key would keep them both
/// green forever.
#[test]
fn a_wrong_key_does_not_open_the_frozen_push() {
    let (nonce, ciphertext) = frozen(CHANNEL_FIXTURE);
    let mut wrong = CHANNEL_KEY;
    wrong[0] ^= 0x01;

    assert!(
        decrypt_channel_message(&wrong, &nonce, &ciphertext).is_none(),
        "a one-bit key change still opened the push, so these fixtures assert nothing"
    );
}

/// Writes the two fixtures, and REFUSES to overwrite a generation that already exists.
///
/// Ignored by default because it is a generator, not an assertion: run it once, deliberately, when
/// a new generation is wanted -
/// `cargo test -p canari --lib -- --ignored freeze_the_current_generation`.
///
/// It bumps no version by itself. To freeze a new generation, change [`FIXTURE_VERSION`] first;
/// the refusal below is what stops a rerun from quietly replacing the evidence with a round-trip
/// against today's code, which is the one way this whole file could become worthless.
#[test]
#[ignore = "generator: writes the committed fixtures, run deliberately"]
fn freeze_the_current_generation() {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    let plaintext = build_text_app_message(MESSAGE_ID, SENT_AT, TEXT);

    let graine_key = derive_message_key(&GRAINE_SEED, GRAINE_SESSION, GRAINE_INDEX)
        .expect("derive the fixture's Graine key");

    for (name, key) in [(CHANNEL_FIXTURE, CHANNEL_KEY), (GRAINE_FIXTURE, graine_key)] {
        let path = fixture_path(name);
        assert!(
            !path.exists(),
            "{} already exists. Bump FIXTURE_VERSION to freeze a new generation - overwriting one \
             turns the cross-version gate into a round-trip against the code under test.",
            path.display()
        );

        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let sealed = cipher
            .encrypt(Nonce::from_slice(&NONCE), plaintext.as_slice())
            .expect("seal the fixture");

        let mut blob = Vec::with_capacity(NONCE.len() + sealed.len());
        blob.extend_from_slice(&NONCE);
        blob.extend_from_slice(&sealed);

        std::fs::create_dir_all(path.parent().expect("fixture directory"))
            .expect("create the fixture directory");
        std::fs::write(&path, &blob).expect("write the fixture");
        println!("froze {} ({} bytes)", path.display(), blob.len());
    }
}

// --- GRAINE V2 (channel-encryption §21): A SECOND GENERATION, BESIDE THE FIRST ------------------
//
// A v2 push adds two things the v1 fixtures cannot see: the header bound in as AES-GCM additional
// data, and the session's Ed25519 signature over `H || nonce || ciphertext`. Both are deterministic
// (AES-GCM under a fixed nonce, Ed25519 by construction), so the same two directions hold as above:
// the frozen push must still OPEN, and today's seal and signature must reproduce it BYTE FOR BYTE.
// Failing the open while the v1 fixtures pass accuses the header encoding, the AAD or the Ed25519
// crate - and the second assertion says which of the two halves moved.
//
// Layout: `[nonce (12) || signature (64) || ciphertext||tag]`, one file, for the reason
// `fixture_path` gives. The session secret is a readable constant like every other value here.

/// The generation the v2 fixture was frozen at - its own, since v2 did not exist at v0.14.14.
const V2_FIXTURE_VERSION: &str = "v0.18.28";
const GRAINE_V2_FIXTURE: &str = "graine-v2-push.bin";
const GRAINE_V2_CHANNEL: &str = "cross-version-fixture-channel";
const GRAINE_V2_MINTER: &str = "cross-version-fixture-minter";
const GRAINE_V2_SESSION_SECRET: [u8; 32] = [0x51; 32];

fn v2_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(format!("{V2_FIXTURE_VERSION}-{GRAINE_V2_FIXTURE}"))
}

fn v2_header(minter: &str) -> super::graine::GraineHeaderV2<'_> {
    super::graine::GraineHeaderV2 {
        channel_id: GRAINE_V2_CHANNEL,
        session_id: GRAINE_SESSION,
        minter_user_id: minter,
        index: GRAINE_INDEX,
    }
}

/// `(nonce, signature, ciphertext)`, read from the committed file; missing is a failure, never a skip.
fn frozen_v2() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let path = v2_fixture_path();
    let blob = std::fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "missing fixture {}: {e}. Restore it from git rather than regenerating.",
            path.display()
        )
    });
    assert!(
        blob.len() > 12 + 64,
        "{} is {} bytes",
        path.display(),
        blob.len()
    );
    let (nonce, rest) = blob.split_at(12);
    let (signature, ciphertext) = rest.split_at(64);
    (nonce.to_vec(), signature.to_vec(), ciphertext.to_vec())
}

/// The public half of [`GRAINE_V2_SESSION_SECRET`], computed with WebCrypto rather than with the
/// crate under test - a stored value, so a changed key derivation in `ed25519-dalek` fails here.
const GRAINE_V2_SESSION_PUBLIC_KEY: &str =
    "c050c5637a44fa8629fff3cccce2300cb362a63d99d95fc54145266f4332445a";

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

/// Seals and signs the frozen plaintext the way today's v2 writer would, under the frozen nonce.
fn todays_v2_seal() -> (Vec<u8>, Vec<u8>) {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    let plaintext = build_text_app_message(MESSAGE_ID, SENT_AT, TEXT);
    let header = super::graine::encode_header_v2(&v2_header(GRAINE_V2_MINTER)).expect("header");
    let key = derive_message_key(&GRAINE_SEED, GRAINE_SESSION, GRAINE_INDEX).expect("derive");
    let ciphertext = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
        .encrypt(
            Nonce::from_slice(&NONCE),
            Payload {
                msg: &plaintext,
                aad: &header,
            },
        )
        .expect("seal");
    let mut signed = header;
    signed.extend_from_slice(&NONCE);
    signed.extend_from_slice(&ciphertext);
    let signature =
        mls_core::graine_signature::sign_with_session_key(&GRAINE_V2_SESSION_SECRET, &signed)
            .expect("sign");
    (signature, ciphertext)
}

#[test]
fn a_graine_v2_push_frozen_at_its_first_release_still_opens() {
    let (nonce, signature, ciphertext) = frozen_v2();
    let plaintext = super::graine::open_graine_message_v2(
        &GRAINE_SEED,
        &v2_header(GRAINE_V2_MINTER),
        &nonce,
        &ciphertext,
        &signature,
        &unhex(GRAINE_V2_SESSION_PUBLIC_KEY),
    )
    .expect("a Graine v2 push sealed by a previous version no longer opens");
    assert_is_the_frozen_message(&super::proto_fields::extract_full_message_info(&plaintext));
}

/// Both halves deterministic, so both directions are provable: see
/// [`todays_seal_is_byte_identical_to_the_frozen_one`] for the argument.
#[test]
fn todays_v2_seal_and_signature_are_byte_identical_to_the_frozen_ones() {
    let (frozen_nonce, frozen_signature, frozen_ciphertext) = frozen_v2();
    let (signature, ciphertext) = todays_v2_seal();
    assert_eq!(frozen_nonce, NONCE);
    assert_eq!(
        ciphertext, frozen_ciphertext,
        "the v2 AEAD or its header moved: a device on the first v2 reader cannot open this seal"
    );
    assert_eq!(
        signature, frozen_signature,
        "the v2 signature moved: a device on the first v2 reader refuses what this build signs"
    );
}

/// The falsification: the frozen push, relabelled with another author, must not open.
#[test]
fn the_frozen_v2_push_refuses_another_author() {
    let (nonce, signature, ciphertext) = frozen_v2();
    assert!(
        super::graine::open_graine_message_v2(
            &GRAINE_SEED,
            &v2_header("someone-else"),
            &nonce,
            &ciphertext,
            &signature,
            &unhex(GRAINE_V2_SESSION_PUBLIC_KEY),
        )
        .is_err(),
        "a relabelled author still opened the v2 push, so this fixture asserts nothing"
    );
}

/// Writes the v2 fixture, refusing to overwrite it - see [`freeze_the_current_generation`].
/// `cargo test -p canari --lib -- --ignored freeze_the_graine_v2_generation`.
#[test]
#[ignore = "generator: writes the committed fixture, run deliberately"]
fn freeze_the_graine_v2_generation() {
    let path = v2_fixture_path();
    assert!(
        !path.exists(),
        "{} already exists. Bump V2_FIXTURE_VERSION to freeze a new generation.",
        path.display()
    );
    let (signature, ciphertext) = todays_v2_seal();
    let mut blob = Vec::with_capacity(12 + 64 + ciphertext.len());
    blob.extend_from_slice(&NONCE);
    blob.extend_from_slice(&signature);
    blob.extend_from_slice(&ciphertext);
    std::fs::write(&path, &blob).expect("write the fixture");
    println!("froze {} ({} bytes)", path.display(), blob.len());
}
