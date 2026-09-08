//! The framing around an encrypted MLS state blob, and the ONE place either platform decides what
//! shape it is looking at.
//!
//! # Why a header at all
//!
//! A ChaCha20-Poly1305 tag that does not verify has two causes the ciphertext alone cannot separate:
//! the state was sealed under a DIFFERENT device key (a PIN rotated on another device - ordinary,
//! recoverable with the old PIN) or the bytes were ALTERED (corruption - the old PIN is irrelevant).
//! Measured on 2026-09-08 (CORRUPT-1, CORRUPT-2): one flipped byte in an 18.4 MB state told the user
//! their PIN had been changed on another device, sent them after a credential that never existed, and
//! then refused the PIN they actually held. `mls_autosave_ver` cannot settle it - it is a per-write
//! sequence counter that orders concurrent flushes, not a key id - and nothing else is stored beside
//! the blob. So the discriminator has to go INTO the blob's own framing, and this module is it.
//!
//! # Why the reader ships one release before the writer
//!
//! `tests/cross_version_state.rs` proves today's code reads what v0.14.14 wrote. It says nothing
//! about the other direction, and a header is exactly what breaks it: an older build handed
//! `[magic][version][fingerprint][nonce][ciphertext]` reads the first twelve bytes as a nonce, fails
//! the tag, and reports the state unopenable - **this very defect, newly caused by a downgrade**.
//! Downgrades are not hypothetical: an APK is reinstalled by hand all through a campaign session, and
//! a store rollback does the same thing to a real user.
//!
//! So the sequence is READ-FIRST, WRITE-LATER. This module ships complete - [`frame_v1`] included and
//! tested - but nothing calls it on a write path yet, which makes this release behaviourally inert.
//! When [`crate::MlsManager::save_encrypted_with_key`] starts framing (step 2, once `minClientVersion`
//! makes this reader the floor), the classification becomes real and not one release before.
//!
//! # Why the legacy shape is not a fallback
//!
//! *A fallback is a signal, never a path* - but a headerless blob is not a failed attempt at a
//! headered one. It is the format this product wrote for its entire life until now, sitting on every
//! installed device, and reading it is the primary path for those bytes. It stops being one when no
//! supported client can have written it, and not before.

use crate::MlsError;
use openmls_traits::OpenMlsProvider;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::HashType;

/// Distinguishes a framed blob from a bare `[nonce || ciphertext]`.
///
/// A legacy blob opens with 12 bytes of OS randomness, so the question "is this framed" is decided by
/// whether those bytes happen to equal a constant. Seven magic bytes plus a version byte make that a
/// 2^-64 event - which is why there is no re-parse-as-legacy retry anywhere below. A retry would BE
/// the fallback this module's header comment refuses, and it would also turn a genuinely corrupt
/// framed blob into a confusing legacy one.
pub const MAGIC: [u8; 7] = *b"CANARIS";

/// The only framing version that exists. A blob announcing any other is refused by name rather than
/// guessed at: it means a client newer than this one wrote it, and pretending to read it is how a
/// downgrade turns into "your state is corrupt".
pub const VERSION_1: u8 = 1;

/// `MAGIC` (7) + version (1) + key fingerprint (8).
pub const HEADER_LEN: usize = 16;

/// Bytes of the key fingerprint carried in a v1 header.
pub const FINGERPRINT_LEN: usize = 8;

/// Domain separation, so this hash can never collide with any other use of the device key.
const FINGERPRINT_DOMAIN: &[u8] = b"canari/mls-state-blob/key-fingerprint/v1";

/// What a blob turned out to be, with the sealed `[nonce || ciphertext]` body in both cases.
#[derive(Debug)]
pub enum Framed<'a> {
    /// `[nonce (12) || ciphertext]` - every blob written before this format existed.
    Legacy(&'a [u8]),
    /// `[MAGIC || 1 || fingerprint (8) || nonce (12) || ciphertext]`.
    V1 {
        /// Fingerprint of the key that sealed it - compare against [`key_fingerprint`].
        key_fingerprint: [u8; FINGERPRINT_LEN],
        /// The `[nonce || ciphertext]` body, ready for `security::decrypt_blob`.
        sealed: &'a [u8],
    },
}

/// A short, deterministic fingerprint of the at-rest key.
///
/// **IT IDENTIFIES THE KEY WITHOUT BEING ABLE TO RECOVER IT**, which is the whole requirement: eight
/// bytes of SHA-256 over a domain constant and the key. Publishing it beside the ciphertext gives an
/// attacker an offline check against a guessed key - and the AEAD tag already gives them exactly that,
/// so nothing is lost that was not already offered.
///
/// It is NOT derived with the AEAD under a fixed nonce, which was the tempting dependency-free option:
/// the state blobs draw random nonces from the same key, so a fixed one introduces a 2^-96 chance of
/// reusing a nonce whose plaintext is a PUBLIC CONSTANT - and that particular reuse leaks the keystream
/// and therefore the state. A vanishing probability of total disclosure is a worse trade than a hash.
pub fn key_fingerprint(key: &[u8; 32]) -> [u8; FINGERPRINT_LEN] {
    let mut input = Vec::with_capacity(FINGERPRINT_DOMAIN.len() + key.len());
    input.extend_from_slice(FINGERPRINT_DOMAIN);
    input.extend_from_slice(key);
    let provider = openmls_rust_crypto::OpenMlsRustCrypto::default();
    // SHA-256 over a fixed-length input cannot fail in this backend, and a fingerprint is not worth
    // an error path a caller would have to invent a policy for: an all-zero one simply never matches,
    // so the blob reads as sealed under another key - the safe direction.
    let digest = provider
        .crypto()
        .hash(HashType::Sha2_256, &input)
        .unwrap_or_default();
    let mut out = [0u8; FINGERPRINT_LEN];
    let n = out.len().min(digest.len());
    out[..n].copy_from_slice(&digest[..n]);
    out
}

/// Decides what shape `blob` is, without decrypting anything.
///
/// The length floors are the reason this is one function rather than a check at each call site: three
/// readers used to test `len() >= 12` independently, and a framed blob passes that test while carrying
/// only four bytes of body.
pub fn parse(blob: &[u8]) -> Result<Framed<'_>, MlsError> {
    if blob.len() >= HEADER_LEN && blob[..MAGIC.len()] == MAGIC {
        let version = blob[MAGIC.len()];
        if version != VERSION_1 {
            return Err(MlsError::StateUndecryptable(format!(
                "state blob announces framing version {version}, which this build does not know - it \
                 was written by a newer client, so this is a downgrade and not corruption"
            )));
        }
        let body = &blob[HEADER_LEN..];
        if body.len() < 12 {
            return Err(MlsError::StateUndecryptable(format!(
                "framed state blob carries {} byte(s) after its header, too short to hold a nonce",
                body.len()
            )));
        }
        let mut fp = [0u8; FINGERPRINT_LEN];
        fp.copy_from_slice(&blob[MAGIC.len() + 1..HEADER_LEN]);
        return Ok(Framed::V1 {
            key_fingerprint: fp,
            sealed: body,
        });
    }
    // BOTH REMAINING ARMS ARE THE SAME SITUATION FOR THE PERSON HOLDING THE PHONE: the saved state
    // will not open. A blob too short to hold a nonce is a truncated write - an interrupted flush, a
    // full disk, a killed tab - which is the most realistic shape of corruption there is.
    if blob.len() < 12 {
        return Err(MlsError::StateUndecryptable(format!(
            "state blob is {} bytes, too short to carry a nonce",
            blob.len()
        )));
    }
    Ok(Framed::Legacy(blob))
}

/// Wraps an already-sealed `[nonce || ciphertext]` body in a v1 header.
///
/// **NOTHING ON A WRITE PATH CALLS THIS YET, DELIBERATELY** - see this module's header for why the
/// reader has to be the floor first. It exists and is tested now so that step 2 is a one-line change
/// at [`crate::MlsManager::save_encrypted_with_key`] rather than a design revisited months later, and
/// so the round trip is pinned by a test today.
pub fn frame_v1(key: &[u8; 32], sealed: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + sealed.len());
    out.extend_from_slice(&MAGIC);
    out.push(VERSION_1);
    out.extend_from_slice(&key_fingerprint(key));
    out.extend_from_slice(sealed);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: [u8; 32] = [7u8; 32];
    const KEY_B: [u8; 32] = [9u8; 32];

    fn sealed(n: usize) -> Vec<u8> {
        vec![0xABu8; n]
    }

    #[test]
    fn a_headerless_blob_still_reads_as_the_format_every_installed_device_wrote() {
        let blob = sealed(64);
        match parse(&blob).expect("legacy blob must parse") {
            Framed::Legacy(body) => assert_eq!(body, &blob[..]),
            other => panic!("a bare [nonce || ciphertext] must read as legacy, got {other:?}"),
        }
    }

    #[test]
    fn a_framed_blob_round_trips_and_carries_the_fingerprint_of_the_key_that_sealed_it() {
        let body = sealed(64);
        let blob = frame_v1(&KEY_A, &body);
        assert_eq!(blob.len(), HEADER_LEN + body.len());
        match parse(&blob).expect("framed blob must parse") {
            Framed::V1 {
                key_fingerprint: fp,
                sealed,
            } => {
                assert_eq!(sealed, &body[..], "the body must survive framing untouched");
                assert_eq!(fp, key_fingerprint(&KEY_A));
                assert_ne!(
                    fp,
                    key_fingerprint(&KEY_B),
                    "two different keys must not share a fingerprint - the whole point is telling \
                     a rotation apart from corruption"
                );
            }
            other => panic!("a framed blob must read as V1, got {other:?}"),
        }
    }

    #[test]
    fn the_fingerprint_is_deterministic_because_a_reader_recomputes_it_on_another_run() {
        assert_eq!(key_fingerprint(&KEY_A), key_fingerprint(&KEY_A));
        assert_ne!(key_fingerprint(&KEY_A), [0u8; FINGERPRINT_LEN]);
    }

    #[test]
    fn a_future_framing_version_is_named_as_a_downgrade_and_never_read_as_corruption() {
        let mut blob = frame_v1(&KEY_A, &sealed(64));
        blob[MAGIC.len()] = 99;
        let err = parse(&blob).expect_err("an unknown version must be refused");
        let msg = err.to_string();
        assert!(msg.contains("version 99"), "{msg}");
        assert!(
            msg.contains("downgrade"),
            "the message must not let a reader conclude corruption: {msg}"
        );
    }

    #[test]
    fn a_truncated_blob_is_refused_in_both_shapes_rather_than_handed_to_the_cipher() {
        // The realistic corruption: an interrupted flush leaves a stub.
        let short = sealed(4);
        assert!(matches!(
            parse(&short),
            Err(MlsError::StateUndecryptable(_))
        ));

        // A header that survived the truncation is not evidence the body did.
        let mut framed = frame_v1(&KEY_A, &sealed(64));
        framed.truncate(HEADER_LEN + 4);
        let err = parse(&framed).expect_err("a framed stub must be refused");
        assert!(
            err.to_string().contains("after its header"),
            "the two truncations must be distinguishable in the log: {err}"
        );
    }

    /// A legacy body is random, so the magic can only appear by chance - but a body that DOES begin
    /// with it must not be silently reinterpreted, because that is the one way this change could
    /// corrupt a state that was fine. The test pins the deliberate choice: framing wins, and the
    /// odds of reaching it (2^-64) are why no re-parse-as-legacy retry exists.
    #[test]
    fn the_magic_decides_and_there_is_no_second_guess() {
        let mut blob = Vec::new();
        blob.extend_from_slice(&MAGIC);
        blob.push(VERSION_1);
        blob.extend_from_slice(&[0u8; FINGERPRINT_LEN]);
        blob.extend_from_slice(&sealed(32));
        assert!(matches!(parse(&blob), Ok(Framed::V1 { .. })));
    }
}
