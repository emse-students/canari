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
//!
//! # Version 2 - the same header, an AES-256-GCM body sealed by the BROWSER (2026-10-12)
//!
//! Measured on a 7.7 MB state in desktop Chrome, the WASM ChaCha20-Poly1305 seal was 141 ms of a
//! 175 ms checkpoint: `chacha20` has no SIMD backend on `wasm32` and runs at ~55 MB/s, while the
//! browser's own WebCrypto AES-GCM runs on hardware AES at GB/s
//! (`docs/wiki/frontend/performance-audit-2026-10-12.md`, finding 3). Version 2 is that body:
//!
//! `[MAGIC (7) || 2 || fingerprint (8)] [iv (12) || AES-256-GCM ciphertext || tag (16)]`
//!
//! - **The fingerprint is the DEVICE key's**, computed exactly as for version 1, so "sealed under
//!   another key" is answered by the header in both versions and by the same function.
//! - **The AES key is DERIVED, never the device key itself** - HKDF-SHA256 with [`V2_KDF_SALT`] and
//!   [`V2_KDF_INFO`]. The device key already keys ChaCha20-Poly1305 for every legacy blob and the
//!   fingerprint hash; one raw key under two AEADs is a cross-algorithm reuse nobody has to argue
//!   about if it never happens.
//! - **The 16 header bytes are the AAD**, so a flipped version or fingerprint byte fails the tag
//!   instead of steering the reader into a different, plausible-looking path.
//!
//! **ONLY THE WEB WRITES IT, AND EVERY PLATFORM READS IT.** The writer is TypeScript
//! (`frontend/src/lib/mls-client/mlsStateSeal.ts`); nothing in this crate seals version 2, so a
//! native build cannot write it by construction. The reader lives HERE rather than beside the
//! writer because a web blob does reach a phone: a `.canari` backup carries the sealed state as it
//! was stored (`exportMlsStateAsHex` -> `saveMlsState`), and restoring a web export on Android must
//! open it. One parser, one place the shape is decided, on every target - which is what this module
//! existed for. **The one exception is measured, not convenient**: in a BROWSER the WASM build of
//! this reader opens v2 with software AES, ~2.5x slower than it opens ChaCha (610 ms against 240 ms
//! on 7.7 MB), so the web's `loadAndInitWasm` opens v2 with WebCrypto and hands this crate the
//! plain CBOR; every other shape still reaches [`parse`] sealed. Both v2 readers open the same
//! committed fixture (`tests/state_blob_v2.rs`, `mlsStateSeal.test.ts`) and answer the same codes.
//!
//! **A BUILD THAT PREDATES VERSION 2 FAILS LOUDLY, NEVER SILENTLY.** One that knows version 1 refuses
//! the version byte by name ([`parse`] - "written by a newer client, so this is a downgrade");
//! one older than the header reads `CANARIS\x02...` as a nonce and fails the ChaCha tag. Both land
//! on `STATE_UNDECRYPTABLE`, the existing path that destroys nothing and asks for the PIN. Neither
//! can mistake the bytes for a state and load garbage: CBOR is never reached.

use crate::MlsError;
use openmls_traits::OpenMlsProvider;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::types::{AeadType, HashType};

/// Distinguishes a framed blob from a bare `[nonce || ciphertext]`.
///
/// A legacy blob opens with 12 bytes of OS randomness, so the question "is this framed" is decided by
/// whether those bytes happen to equal a constant. Seven magic bytes plus a version byte make that a
/// 2^-64 event - which is why there is no re-parse-as-legacy retry anywhere below. A retry would BE
/// the fallback this module's header comment refuses, and it would also turn a genuinely corrupt
/// framed blob into a confusing legacy one.
pub const MAGIC: [u8; 7] = *b"CANARIS";

/// Framing version 1: a ChaCha20-Poly1305 body under the device key. A blob announcing a version
/// this build does not know is refused by name rather than guessed at: it means a client newer than
/// this one wrote it, and pretending to read it is how a downgrade turns into "your state is corrupt".
pub const VERSION_1: u8 = 1;

/// Framing version 2: an AES-256-GCM body under a key derived from the device key, the header as
/// AAD. Written by the web client only (see the module docs), read everywhere.
pub const VERSION_2: u8 = 2;

/// HKDF-SHA256 salt for the version 2 AES key. Mirrored byte for byte in `mlsStateSeal.ts`, and
/// pinned on both sides by the same known-answer constant, so the two cannot drift silently.
pub const V2_KDF_SALT: &[u8] = b"canari/mls-state-blob/v2/salt";

/// HKDF-SHA256 info for the version 2 AES key - the domain separation from every other use of the
/// device key.
pub const V2_KDF_INFO: &[u8] = b"canari/mls-state-blob/v2/aes-256-gcm";

/// Bytes of the version 2 IV, WebCrypto's and AES-GCM's 96-bit standard.
pub const V2_IV_LEN: usize = 12;

/// Bytes of the AES-GCM tag WebCrypto appends (its default `tagLength` of 128).
pub const V2_TAG_LEN: usize = 16;

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
    /// `[MAGIC || 2 || fingerprint (8) || iv (12) || ciphertext || tag (16)]`.
    V2 {
        /// Fingerprint of the DEVICE key that sealed it - compare against [`key_fingerprint`].
        key_fingerprint: [u8; FINGERPRINT_LEN],
        /// The 16 header bytes, which are the AEAD's associated data.
        header: &'a [u8],
        /// The `[iv || ciphertext || tag]` body, ready for [`open_v2`].
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
        // The smallest body each version can carry: a nonce for v1 (its tag is checked by the
        // cipher), an IV AND a tag for v2, because an AES-GCM body shorter than that is a stub and
        // not a ciphertext. Unknown versions are refused before any length is read.
        let floor = match version {
            VERSION_1 => 12,
            VERSION_2 => V2_IV_LEN + V2_TAG_LEN,
            _ => {
                return Err(MlsError::StateUndecryptable(format!(
                    "state blob announces framing version {version}, which this build does not know \
                     - it was written by a newer client, so this is a downgrade and not corruption"
                )));
            }
        };
        let body = &blob[HEADER_LEN..];
        if body.len() < floor {
            return Err(MlsError::StateUndecryptable(format!(
                "framed state blob (version {version}) carries {} byte(s) after its header, too \
                 short to hold its {floor}-byte minimum",
                body.len()
            )));
        }
        let mut fp = [0u8; FINGERPRINT_LEN];
        fp.copy_from_slice(&blob[MAGIC.len() + 1..HEADER_LEN]);
        return Ok(if version == VERSION_1 {
            Framed::V1 {
                key_fingerprint: fp,
                sealed: body,
            }
        } else {
            Framed::V2 {
                key_fingerprint: fp,
                header: &blob[..HEADER_LEN],
                sealed: body,
            }
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

/// The AES-256-GCM key a version 2 body is sealed under: HKDF-SHA256 of the device key.
///
/// Public so the cross-implementation tests can pin it to the SAME known-answer constant the
/// TypeScript writer's test pins (`mlsStateSeal.test.ts`) - two implementations of one derivation
/// agree only if something checks both against the same bytes.
pub fn v2_aead_key(device_key: &[u8; 32]) -> Result<[u8; 32], MlsError> {
    let provider = openmls_rust_crypto::OpenMlsRustCrypto::default();
    let crypto = provider.crypto();
    let prk = crypto
        .hkdf_extract(HashType::Sha2_256, V2_KDF_SALT, device_key)
        .map_err(|e| MlsError::StateUndecryptable(format!("v2 key derivation (extract): {e:?}")))?;
    let okm = crypto
        .hkdf_expand(HashType::Sha2_256, prk.as_slice(), V2_KDF_INFO, 32)
        .map_err(|e| MlsError::StateUndecryptable(format!("v2 key derivation (expand): {e:?}")))?;
    let mut out = [0u8; 32];
    out.copy_from_slice(okm.as_slice());
    Ok(out)
}

/// Opens a version 2 body (`[iv || ciphertext || tag]`) with the header as AAD.
///
/// Every failure is `StateUndecryptable`: a tag that does not verify here has ALREADY passed the
/// fingerprint check (the caller makes it first), so the key is the right one and the bytes - body
/// or header - were altered. There is no "another key" reading of this error left to make.
pub fn open_v2(device_key: &[u8; 32], header: &[u8], sealed: &[u8]) -> Result<Vec<u8>, MlsError> {
    if sealed.len() < V2_IV_LEN + V2_TAG_LEN {
        return Err(MlsError::StateUndecryptable(format!(
            "v2 body is {} bytes, shorter than an IV and a tag",
            sealed.len()
        )));
    }
    let key = v2_aead_key(device_key)?;
    let (iv, ct_tag) = sealed.split_at(V2_IV_LEN);
    let provider = openmls_rust_crypto::OpenMlsRustCrypto::default();
    provider
        .crypto()
        .aead_decrypt(AeadType::Aes256Gcm, &key, ct_tag, iv, header)
        .map_err(|e| {
            MlsError::StateUndecryptable(format!(
                "v2 AES-GCM tag did not verify under the right key - the blob was altered: {e:?}"
            ))
        })
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
    fn a_version_2_blob_parses_with_its_header_as_aad_and_carries_the_device_key_fingerprint() {
        let mut blob = frame_v1(&KEY_A, &sealed(V2_IV_LEN + V2_TAG_LEN + 8));
        blob[MAGIC.len()] = VERSION_2;
        match parse(&blob).expect("a v2 blob must parse") {
            Framed::V2 {
                key_fingerprint: fp,
                header,
                sealed: body,
            } => {
                assert_eq!(fp, key_fingerprint(&KEY_A));
                assert_eq!(header, &blob[..HEADER_LEN]);
                assert_eq!(body.len(), V2_IV_LEN + V2_TAG_LEN + 8);
            }
            other => panic!("expected V2, got {other:?}"),
        }
    }

    #[test]
    fn a_version_2_body_shorter_than_an_iv_and_a_tag_is_a_stub_and_refused() {
        // 27 bytes would have passed v1's 12-byte nonce floor - the floor is per version.
        let mut blob = frame_v1(&KEY_A, &sealed(V2_IV_LEN + V2_TAG_LEN - 1));
        blob[MAGIC.len()] = VERSION_2;
        let err = parse(&blob).expect_err("a v2 stub must be refused");
        assert!(err.to_string().contains("version 2"), "{err}");
    }

    #[test]
    fn the_v2_key_is_derived_and_is_not_the_device_key() {
        let k = v2_aead_key(&KEY_A).expect("derive");
        assert_ne!(k, KEY_A);
        assert_eq!(k, v2_aead_key(&KEY_A).expect("derive"));
        assert_ne!(k, v2_aead_key(&KEY_B).expect("derive"));
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
