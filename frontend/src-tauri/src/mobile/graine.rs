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
use mls_core::graine_signature::{verify_graine_signature, GraineSignatureError};
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

// ---------------------------------------------------------------------------------------------
// Graine v2 (channel-encryption §21): the header, the endorsement, and the open a push needs.
// The native mirror of `frontend/src/lib/crypto/graineV2.ts`, held to it by the vectors in both
// test suites. The signature half is `mls_core::graine_signature`, the one Ed25519 implementation.
// ---------------------------------------------------------------------------------------------

/// Mirrors `GRAINE_V2_HEADER_LABEL` in `graineConstants.ts`.
pub const GRAINE_V2_HEADER_LABEL: &[u8] = b"canari-graine-v2";
/// Mirrors `GRAINE_V2_ENDORSEMENT_LABEL` in `graineConstants.ts`.
pub const GRAINE_V2_ENDORSEMENT_LABEL: &[u8] = b"canari-graine-v2-endorse";
/// AES-GCM nonce width, which is what lets `H || nonce || ciphertext` delimit itself.
pub const GRAINE_NONCE_BYTES: usize = 12;

/// Where a v2 message belongs. Every field is bound into its additional data and its signature.
#[derive(Debug, Clone, Copy)]
pub struct GraineHeaderV2<'a> {
    pub channel_id: &'a str,
    pub session_id: &'a str,
    /// The session's minter, and therefore the only author a row under it may name.
    pub minter_user_id: &'a str,
    pub index: u32,
}

/// What a v2 session's minter endorses with its device credential key.
#[derive(Debug, Clone, Copy)]
pub struct GraineEndorsementV2<'a> {
    pub channel_id: &'a str,
    pub session_id: &'a str,
    pub minter_user_id: &'a str,
    pub minter_device_id: &'a str,
    pub signing_public_key: &'a [u8],
    pub seed_commitment: &'a [u8; 32],
    /// Milliseconds since the epoch.
    pub created_at: u64,
}

/// Why a v2 message or endorsement was refused - each a different fault, as a type.
#[derive(Debug, PartialEq, Eq)]
pub enum GraineV2Error {
    /// A field that must be bound was empty or mis-sized; nothing was verified.
    Input(&'static str),
    /// The signature did not verify, or was malformed: the row or the endorsement is refused.
    Signature(GraineSignatureError),
    /// The endorsement's seed commitment is not the seed it arrived with.
    SeedNotEndorsed,
    /// The key derivation refused its input.
    Derive(GraineError),
    /// The signature passed and AES-GCM did not open: the seed is wrong for this session.
    Decrypt,
}

/// `H`: `lp(label) || lp(channel) || lp(session) || lp(minter) || be32(index)`, as in `graineV2.ts`.
pub fn encode_header_v2(header: &GraineHeaderV2<'_>) -> Result<Vec<u8>, GraineV2Error> {
    require_text("channel_id", header.channel_id)?;
    require_text("session_id", header.session_id)?;
    require_text("minter_user_id", header.minter_user_id)?;
    let mut out = Vec::new();
    push_field(&mut out, GRAINE_V2_HEADER_LABEL);
    push_field(&mut out, header.channel_id.as_bytes());
    push_field(&mut out, header.session_id.as_bytes());
    push_field(&mut out, header.minter_user_id.as_bytes());
    out.extend_from_slice(&header.index.to_be_bytes());
    Ok(out)
}

/// `D`, the endorsement descriptor, as in `graineV2.ts` - including the seed commitment that lets a
/// relayed seed be checked on arrival.
pub fn encode_endorsement_v2(e: &GraineEndorsementV2<'_>) -> Result<Vec<u8>, GraineV2Error> {
    require_text("channel_id", e.channel_id)?;
    require_text("session_id", e.session_id)?;
    require_text("minter_user_id", e.minter_user_id)?;
    require_text("minter_device_id", e.minter_device_id)?;
    if e.signing_public_key.len() != 32 {
        log::error!(
            "[GRAINE_V2] signing public key is {} bytes",
            e.signing_public_key.len()
        );
        return Err(GraineV2Error::Input("signing_public_key"));
    }
    let mut out = Vec::new();
    push_field(&mut out, GRAINE_V2_ENDORSEMENT_LABEL);
    push_field(&mut out, e.channel_id.as_bytes());
    push_field(&mut out, e.session_id.as_bytes());
    push_field(&mut out, e.minter_user_id.as_bytes());
    push_field(&mut out, e.minter_device_id.as_bytes());
    push_field(&mut out, e.signing_public_key);
    push_field(&mut out, e.seed_commitment);
    out.extend_from_slice(&e.created_at.to_be_bytes());
    Ok(out)
}

/// SHA-256 of a seed: what an endorsement commits to.
pub fn seed_commitment(seed: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    Sha256::digest(seed).into()
}

/// Opens a v2 message the way a push must: signature FIRST against the session's endorsed key (it
/// covers the header, so a relabelled author, salon or index fails here), then AES-GCM with `H` as
/// additional data under v1's derived key.
pub fn open_graine_message_v2(
    seed: &[u8],
    header: &GraineHeaderV2<'_>,
    nonce: &[u8],
    ciphertext: &[u8],
    signature: &[u8],
    signing_public_key: &[u8],
) -> Result<Vec<u8>, GraineV2Error> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Key, Nonce};

    if nonce.len() != GRAINE_NONCE_BYTES {
        log::error!("[GRAINE_V2] nonce is {} bytes", nonce.len());
        return Err(GraineV2Error::Input("nonce"));
    }
    let h = encode_header_v2(header)?;
    let mut signed = Vec::with_capacity(h.len() + nonce.len() + ciphertext.len());
    signed.extend_from_slice(&h);
    signed.extend_from_slice(nonce);
    signed.extend_from_slice(ciphertext);
    verify_graine_signature(signing_public_key, &signed, signature).map_err(|e| {
        log::error!(
            "[GRAINE_V2] message signature refused ({}) index={}",
            e.code(),
            header.index
        );
        GraineV2Error::Signature(e)
    })?;

    let key =
        derive_message_key(seed, header.session_id, header.index).map_err(GraineV2Error::Derive)?;
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key))
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &h,
            },
        )
        .map_err(|_| {
            log::error!(
                "[GRAINE_V2] signature passed and AES-GCM did not open: wrong seed index={}",
                header.index
            );
            GraineV2Error::Decrypt
        })
}

/// Checks an endorsement against the minting device's credential key, and the seed beside it
/// against the commitment it carries. A session that fails either must never be mirrored.
pub fn verify_endorsement_v2(
    endorsement: &GraineEndorsementV2<'_>,
    seed: &[u8],
    signature: &[u8],
    device_public_key: &[u8],
) -> Result<(), GraineV2Error> {
    if seed_commitment(seed) != *endorsement.seed_commitment {
        log::error!("[GRAINE_V2] endorsement refused: the seed is not the one endorsed");
        return Err(GraineV2Error::SeedNotEndorsed);
    }
    let d = encode_endorsement_v2(endorsement)?;
    verify_graine_signature(device_public_key, &d, signature).map_err(|e| {
        log::error!("[GRAINE_V2] endorsement refused ({})", e.code());
        GraineV2Error::Signature(e)
    })
}

fn push_field(out: &mut Vec<u8>, bytes: &[u8]) {
    // A Graine field is an id, a key or a hash - far below 4 GiB, so the cast cannot truncate.
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn require_text(name: &'static str, value: &str) -> Result<(), GraineV2Error> {
    if value.is_empty() {
        log::error!("[GRAINE_V2] {name} is empty; it is bound into v2");
        return Err(GraineV2Error::Input(name));
    }
    Ok(())
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

    // --- Graine v2: the contract with `frontend/src/lib/crypto/graineV2.test.ts` ---------------
    //
    // The values below were computed from the specification with WebCrypto alone and are asserted
    // on the TS side too. Here they are re-derived with aes-gcm, sha2 and ed25519-dalek - a second,
    // independent implementation - which is what makes them a contract rather than a snapshot.

    const V2_HEADER: &str = "0000001063616e6172692d677261696e652d7632000000066368616e2d310000000c746573742d73657373696f6e00000005616c69636500000007";
    const V2_CIPHERTEXT: &str = "CCdfoCGS9kY27uJzr/2OC1Fn92Pi1uNh6VFb5tu6Pg==";
    const V2_NONCE: &str = "AAECAwQFBgcICQoL";
    const V2_SIGNATURE: &str =
        "Hwii/KYtoUamYQjTSfB5lolOFOdM/i4OWkozNdMjdJwDI2cIvrUQG64S3/TS23l5H9ZnsJ4KWM9Tl7+g5PenCg==";
    const V2_SESSION_PK: &str = "03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8";
    const V2_DEVICE_PK: &str = "29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7";
    const V2_COMMITMENT: &str = "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd";
    const V2_ENDORSEMENT: &str = "0000001863616e6172692d677261696e652d76322d656e646f727365000000066368616e2d310000000c746573742d73657373696f6e00000005616c696365000000056465762d610000002003a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b800000020630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd000001a0c4506c00";
    const V2_ENDORSEMENT_SIGNATURE: &str =
        "7OosFoBLfQHHOV+1M8DysUkXqd97GXqite/EfMUyrf0X+bK/mmMaNMFohIfQvqwvr17phCTw0YAtFXmryQ7/Bg==";

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    fn b64(text: &str) -> Vec<u8> {
        STANDARD.decode(text).unwrap()
    }

    fn header() -> GraineHeaderV2<'static> {
        GraineHeaderV2 {
            channel_id: "chan-1",
            session_id: "test-session",
            minter_user_id: "alice",
            index: 7,
        }
    }

    fn open(
        header: &GraineHeaderV2<'_>,
        ciphertext: &[u8],
        pk: &str,
    ) -> Result<Vec<u8>, GraineV2Error> {
        open_graine_message_v2(
            &seed(),
            header,
            &b64(V2_NONCE),
            ciphertext,
            &b64(V2_SIGNATURE),
            &unhex(pk),
        )
    }

    #[test]
    fn v2_matches_the_shared_vectors() {
        assert_eq!(hex(&encode_header_v2(&header()).unwrap()), V2_HEADER);
        assert_eq!(hex(&seed_commitment(&seed())), V2_COMMITMENT);

        let commitment: [u8; 32] = unhex(V2_COMMITMENT).try_into().unwrap();
        let session_pk = unhex(V2_SESSION_PK);
        let endorsement = GraineEndorsementV2 {
            channel_id: "chan-1",
            session_id: "test-session",
            minter_user_id: "alice",
            minter_device_id: "dev-a",
            signing_public_key: &session_pk,
            seed_commitment: &commitment,
            created_at: 1_790_000_000_000,
        };
        assert_eq!(
            hex(&encode_endorsement_v2(&endorsement).unwrap()),
            V2_ENDORSEMENT
        );
        assert_eq!(
            verify_endorsement_v2(
                &endorsement,
                &seed(),
                &b64(V2_ENDORSEMENT_SIGNATURE),
                &unhex(V2_DEVICE_PK)
            ),
            Ok(())
        );

        // The frozen sealed message opens, and the session secret (bytes 0..31) signs it to the
        // same 64 bytes WebCrypto produced.
        let plaintext = open(&header(), &b64(V2_CIPHERTEXT), V2_SESSION_PK).unwrap();
        assert_eq!(plaintext, b"hello graine v2");
        let mut signed = unhex(V2_HEADER);
        signed.extend(b64(V2_NONCE));
        signed.extend(b64(V2_CIPHERTEXT));
        let secret: Vec<u8> = (0u8..32).collect();
        assert_eq!(
            mls_core::graine_signature::sign_with_session_key(&secret, &signed).unwrap(),
            b64(V2_SIGNATURE)
        );
    }

    #[test]
    fn v2_refuses_a_relabelled_row_as_a_signature_fault() {
        let ct = b64(V2_CIPHERTEXT);
        for relabelled in [
            GraineHeaderV2 {
                minter_user_id: "mallory",
                ..header()
            },
            GraineHeaderV2 {
                channel_id: "chan-2",
                ..header()
            },
            GraineHeaderV2 {
                index: 8,
                ..header()
            },
        ] {
            assert_eq!(
                open(&relabelled, &ct, V2_SESSION_PK),
                Err(GraineV2Error::Signature(GraineSignatureError::Invalid))
            );
        }
        let mut tampered = ct.clone();
        tampered[0] ^= 1;
        assert_eq!(
            open(&header(), &tampered, V2_SESSION_PK),
            Err(GraineV2Error::Signature(GraineSignatureError::Invalid))
        );
        // Signed by another key than the session's.
        assert_eq!(
            open(&header(), &ct, V2_DEVICE_PK),
            Err(GraineV2Error::Signature(GraineSignatureError::Invalid))
        );
    }

    #[test]
    fn v2_tells_a_wrong_seed_from_a_forged_row() {
        let wrong_seed = [7u8; 32];
        assert_eq!(
            open_graine_message_v2(
                &wrong_seed,
                &header(),
                &b64(V2_NONCE),
                &b64(V2_CIPHERTEXT),
                &b64(V2_SIGNATURE),
                &unhex(V2_SESSION_PK),
            ),
            Err(GraineV2Error::Decrypt)
        );
    }

    #[test]
    fn v2_refuses_an_endorsement_for_another_seed_or_by_another_device() {
        let commitment: [u8; 32] = unhex(V2_COMMITMENT).try_into().unwrap();
        let session_pk = unhex(V2_SESSION_PK);
        let endorsement = GraineEndorsementV2 {
            channel_id: "chan-1",
            session_id: "test-session",
            minter_user_id: "alice",
            minter_device_id: "dev-a",
            signing_public_key: &session_pk,
            seed_commitment: &commitment,
            created_at: 1_790_000_000_000,
        };
        let sig = b64(V2_ENDORSEMENT_SIGNATURE);
        assert_eq!(
            verify_endorsement_v2(&endorsement, &[9u8; 32], &sig, &unhex(V2_DEVICE_PK)),
            Err(GraineV2Error::SeedNotEndorsed)
        );
        assert_eq!(
            verify_endorsement_v2(&endorsement, &seed(), &sig, &unhex(V2_SESSION_PK)),
            Err(GraineV2Error::Signature(GraineSignatureError::Invalid))
        );
        let later = GraineEndorsementV2 {
            created_at: 1_790_000_000_001,
            ..endorsement
        };
        assert_eq!(
            verify_endorsement_v2(&later, &seed(), &sig, &unhex(V2_DEVICE_PK)),
            Err(GraineV2Error::Signature(GraineSignatureError::Invalid))
        );
    }

    #[test]
    fn v2_refuses_inputs_that_cannot_be_bound() {
        assert_eq!(
            encode_header_v2(&GraineHeaderV2 {
                minter_user_id: "",
                ..header()
            }),
            Err(GraineV2Error::Input("minter_user_id"))
        );
        assert_eq!(
            open_graine_message_v2(
                &seed(),
                &header(),
                &[0u8; 11],
                &b64(V2_CIPHERTEXT),
                &b64(V2_SIGNATURE),
                &unhex(V2_SESSION_PK),
            ),
            Err(GraineV2Error::Input("nonce"))
        );
    }
}
