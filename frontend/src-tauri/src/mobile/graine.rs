//! Graine message-key derivation, native half.
//!
//! A community-channel push is decrypted before any WebView runs, so the derivation cannot be
//! called into the browser - it has to exist twice. This is the ONLY duplicate of
//! `frontend/src/lib/crypto/graine.ts`, it is deliberate, and the two are held together by the
//! same four test vectors: they are asserted in `graine.test.ts` on the TS side and in the tests at
//! the bottom of this file, both produced independently from the specification below.
//!
//! `key(index) = HKDF-SHA256(ikm = seed, salt = utf8(session_id), info = LABEL || be32(index))`
//!
//! Changing LABEL, the salt, or the width of the index is a protocol change and must land on both
//! sides in one commit, or a phone stops being able to read its own notifications.
//!
//! Protocol: `docs/wiki/protocols/channel-encryption.md`.

use hkdf::Hkdf;
use sha2::Sha256;

/// HKDF `info` prefix and the wire version. Mirrors `GRAINE_HKDF_INFO` in `graineConstants.ts`.
pub const GRAINE_HKDF_INFO: &[u8] = b"canari-graine-v1";

/// Seed length, and therefore the length of every key derived from it (AES-256).
pub const GRAINE_SEED_BYTES: usize = 32;

/// Why a derivation could not happen, as a type rather than a sentence.
#[derive(Debug, PartialEq, Eq)]
pub enum GraineError {
    /// The seed was not exactly [`GRAINE_SEED_BYTES`] long.
    SeedLength(usize),
    /// The session id was empty - it is bound into the derivation and cannot be defaulted.
    MissingSessionId,
}

/// The AES-256-GCM key for message `index` of `session_id`.
///
/// Derived from the seed rather than ratcheted forward, matching the TS side and for the same
/// reason: channel history is served newest-first over REST, so an arbitrary index has to be cheap
/// to reach - the one case a forward ratchet is worst at. Each index is an independent HKDF output,
/// so one message key opens exactly one message and only the seed opens the session.
pub fn derive_message_key(
    seed: &[u8],
    session_id: &str,
    index: u32,
) -> Result<[u8; 32], GraineError> {
    if seed.len() != GRAINE_SEED_BYTES {
        return Err(GraineError::SeedLength(seed.len()));
    }
    if session_id.is_empty() {
        return Err(GraineError::MissingSessionId);
    }

    let mut info = Vec::with_capacity(GRAINE_HKDF_INFO.len() + 4);
    info.extend_from_slice(GRAINE_HKDF_INFO);
    info.extend_from_slice(&index.to_be_bytes());

    let hk = Hkdf::<Sha256>::new(Some(session_id.as_bytes()), seed);
    let mut out = [0u8; 32];
    // Only fails for an output longer than 255 * HashLen, which 32 bytes cannot be.
    hk.expand(&info, &mut out)
        .expect("32 bytes is always a valid HKDF output length");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    /// Bytes 0..31, the same seed the TS vectors use.
    fn seed() -> [u8; 32] {
        let mut s = [0u8; 32];
        for (i, b) in s.iter_mut().enumerate() {
            *b = i as u8;
        }
        s
    }

    /// The contract between this file and `frontend/src/lib/crypto/graine.test.ts`.
    ///
    /// Both suites assert the SAME four values, produced independently of either implementation.
    /// A reworded label, a flipped endianness or a dropped session id passes a round-trip test on
    /// each side separately and breaks the pair - which is the failure these vectors exist to catch.
    #[test]
    fn matches_the_shared_test_vectors() {
        let cases: [(&str, u32, &str); 4] = [
            (
                "test-session",
                0,
                "go/kAahuKrCvwB4CquM4zrgRTQyH2+WlHLNQjSB2VKA=",
            ),
            (
                "test-session",
                7,
                "Pnqk2gdQBRQe4p2hXM+vPGNQwHh0Ukc8tcRTnq1fcNw=",
            ),
            (
                "other-session",
                0,
                "n5USTdC3HUsFjhOOwUcw23nwoWgJbl7A6f/EJOToaFQ=",
            ),
            (
                "test-session",
                u32::MAX,
                "f/0pgQZqn8yiwLK3UiG2D6O1RrIqFp+BMeonMygzsIs=",
            ),
        ];
        for (session_id, index, expected) in cases {
            let key = derive_message_key(&seed(), session_id, index).expect("derives");
            assert_eq!(STANDARD.encode(key), expected, "{session_id} @ {index}");
        }
    }

    #[test]
    fn every_index_gets_its_own_key() {
        let a = derive_message_key(&seed(), "s", 0).unwrap();
        let b = derive_message_key(&seed(), "s", 1).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn refuses_input_that_cannot_produce_a_key() {
        assert_eq!(
            derive_message_key(&[0u8; 16], "s", 0),
            Err(GraineError::SeedLength(16))
        );
        assert_eq!(
            derive_message_key(&seed(), "", 0),
            Err(GraineError::MissingSessionId)
        );
    }
}
