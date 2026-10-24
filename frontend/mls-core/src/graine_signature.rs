//! Graine v2 signatures: Ed25519 over bytes the CALLER has already domain-separated.
//!
//! Two keys sign in Graine v2, and both go through this module:
//!
//! - a SESSION pair, minted with each v2 session. Its secret stays on the minting device and signs
//!   every message of the session (`H || nonce || ciphertext`), so a member holding the symmetric
//!   seed can read a session but not write into it under the minter's name;
//! - the DEVICE's MLS credential key, which signs the session's ENDORSEMENT once, binding the
//!   session's public key to the device that minted it. Whoever relays the seed later cannot swap
//!   the key without breaking that signature.
//!
//! Nothing here encodes a Graine structure: the header and the endorsement descriptor are built by
//! `graine.ts` and the native `mobile/graine.rs`, held together by shared vectors, and arrive here
//! as bytes. Every one of them begins with its own length-prefixed label, which is what keeps a
//! message signature from ever verifying as an endorsement and the reverse.
//!
//! **Why the device key may sign something that is not MLS.** OpenMLS signs `SignContent`, whose
//! first byte is the variable-length size of a label that is always `"MLS 1.0 " + label` - never
//! empty. Every Graine structure begins with a 4-byte big-endian length whose first byte is `0x00`,
//! which as an MLS varint is a label of length ZERO. No Graine bytes can therefore be an MLS
//! `SignContent`, and a signature here can never be replayed into the MLS protocol.
//!
//! All of it runs in Rust, on every platform, rather than in WebCrypto: Ed25519 reached the browsers
//! late and unevenly (Chrome 137, iOS 17), and the WebViews a phone ships are older than that.
//!
//! Protocol: `docs/wiki/protocols/channel-encryption.md` §21.

use openmls::prelude::SignatureScheme;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::signatures::Signer;
use zeroize::Zeroizing;

use crate::MlsError;
use crate::state::MlsManager;

/// An Ed25519 public key.
pub const GRAINE_PUBLIC_KEY_BYTES: usize = 32;
/// An Ed25519 secret key (the 32-byte seed form `ed25519-dalek` stores).
pub const GRAINE_SECRET_KEY_BYTES: usize = 32;
/// An Ed25519 signature.
pub const GRAINE_SIGNATURE_BYTES: usize = 64;

/// Why a signature could not be made or did not verify - a TYPE, so a caller never reads a sentence
/// to tell a forged message from a truncated field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum GraineSignatureError {
    /// The public key was not [`GRAINE_PUBLIC_KEY_BYTES`] long, or not a curve point.
    #[error("malformed Graine public key ({0} bytes)")]
    MalformedPublicKey(usize),
    /// The secret key was not [`GRAINE_SECRET_KEY_BYTES`] long.
    #[error("malformed Graine secret key ({0} bytes)")]
    MalformedSecretKey(usize),
    /// The signature was not [`GRAINE_SIGNATURE_BYTES`] long.
    #[error("malformed Graine signature ({0} bytes)")]
    MalformedSignature(usize),
    /// Well-formed, and it does not verify: another key signed it, or the bytes changed since.
    #[error("Graine signature does not verify")]
    Invalid,
    /// The platform could not produce randomness for a new pair.
    #[error("no randomness for a Graine session key")]
    Randomness,
}

impl GraineSignatureError {
    /// A stable code for the JS side, which classifies on it rather than on the message above.
    pub fn code(&self) -> &'static str {
        match self {
            Self::MalformedPublicKey(_) => "malformed-public-key",
            Self::MalformedSecretKey(_) => "malformed-secret-key",
            Self::MalformedSignature(_) => "malformed-signature",
            Self::Invalid => "invalid",
            Self::Randomness => "randomness",
        }
    }
}

/// A freshly minted session pair. The secret zeroizes on drop; its caller seals it before storing.
pub struct GraineSessionKeyPair {
    pub secret: Zeroizing<Vec<u8>>,
    pub public: Vec<u8>,
}

/// Mints the Ed25519 pair of a new v2 session.
pub fn new_session_keypair() -> Result<GraineSessionKeyPair, GraineSignatureError> {
    let (secret, public) = RustCrypto::default()
        .signature_key_gen(SignatureScheme::ED25519)
        .map_err(|e| {
            log::error!("[GRAINE_SIG] session key generation failed: {e:?}");
            GraineSignatureError::Randomness
        })?;
    log::debug!("[GRAINE_SIG] minted a session pair");
    Ok(GraineSessionKeyPair {
        secret: Zeroizing::new(secret),
        public,
    })
}

/// Signs `message` with a session secret. Deterministic (Ed25519), which is what lets the shared
/// vectors pin a signature and not only a verdict.
pub fn sign_with_session_key(
    secret: &[u8],
    message: &[u8],
) -> Result<Vec<u8>, GraineSignatureError> {
    if secret.len() != GRAINE_SECRET_KEY_BYTES {
        log::error!(
            "[GRAINE_SIG] refusing to sign: secret key is {} bytes",
            secret.len()
        );
        return Err(GraineSignatureError::MalformedSecretKey(secret.len()));
    }
    RustCrypto::default()
        .sign(SignatureScheme::ED25519, message, secret)
        .map_err(|e| {
            log::error!("[GRAINE_SIG] signing failed: {e:?}");
            GraineSignatureError::MalformedSecretKey(secret.len())
        })
}

/// Verifies an Ed25519 signature - a session's over a message, or a device's over an endorsement.
///
/// ONE verifier for both keys, because they differ only in where the public key came from, and that
/// is the caller's question. Strict verification (`verify_strict`), so a malleated signature over
/// the same bytes is refused rather than counted as a second valid one.
pub fn verify_graine_signature(
    public: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<(), GraineSignatureError> {
    if public.len() != GRAINE_PUBLIC_KEY_BYTES {
        log::warn!(
            "[GRAINE_SIG] public key is {} bytes (want {GRAINE_PUBLIC_KEY_BYTES})",
            public.len()
        );
        return Err(GraineSignatureError::MalformedPublicKey(public.len()));
    }
    if signature.len() != GRAINE_SIGNATURE_BYTES {
        log::warn!(
            "[GRAINE_SIG] signature is {} bytes (want {GRAINE_SIGNATURE_BYTES})",
            signature.len()
        );
        return Err(GraineSignatureError::MalformedSignature(signature.len()));
    }
    match RustCrypto::default().verify_signature(
        SignatureScheme::ED25519,
        message,
        public,
        signature,
    ) {
        Ok(()) => Ok(()),
        // 32 bytes that are not a curve point: the length was right, the key is not one.
        Err(openmls_traits::types::CryptoError::CryptoLibraryError) => {
            log::warn!("[GRAINE_SIG] public key is not an Ed25519 point");
            Err(GraineSignatureError::MalformedPublicKey(public.len()))
        }
        Err(_) => {
            log::warn!("[GRAINE_SIG] signature does not verify");
            Err(GraineSignatureError::Invalid)
        }
    }
}

/// The answer one check gives the JS side: `valid`, or the refusal's [`GraineSignatureError::code`].
/// One spelling for the single verifier and the batch, so the two cannot name a verdict differently.
pub fn graine_verdict_code(verdict: &Result<(), GraineSignatureError>) -> &'static str {
    match verdict {
        Ok(()) => "valid",
        Err(e) => e.code(),
    }
}

/// One signature to check inside a page batch: borrowed from the packed buffer, never copied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GraineSignatureCheck<'a> {
    pub public: &'a [u8],
    pub message: &'a [u8],
    pub signature: &'a [u8],
}

/// A packed batch that does not parse. A CONTRACT break between the WebView and this engine (the
/// packer is `packGraineSignatureChecks` in `graineV2.ts`), never a verdict about any signature, so
/// it fails the whole call instead of being spread over the rows as a refusal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum GraineBatchError {
    /// The buffer ended inside the field starting at this offset.
    #[error("packed Graine signature batch truncated at byte {0}")]
    Truncated(usize),
    /// Bytes were left after the announced number of checks.
    #[error("packed Graine signature batch has {0} trailing byte(s)")]
    Trailing(usize),
}

/// Reads a packed batch: `be32(count)`, then per check `lp(public) || lp(message) || lp(signature)`,
/// every `lp` a 4-byte big-endian length. Length-prefixed, so a field can never bleed into the next.
pub fn unpack_graine_signature_checks(
    packed: &[u8],
) -> Result<Vec<GraineSignatureCheck<'_>>, GraineBatchError> {
    let mut at = 0usize;
    let count = read_be32(packed, &mut at)? as usize;
    // Every check is at least three 4-byte prefixes, so a count the buffer cannot hold is refused
    // before anything is allocated for it.
    if count > packed.len().saturating_sub(4) / 12 {
        return Err(GraineBatchError::Truncated(at));
    }
    let mut checks = Vec::with_capacity(count);
    for _ in 0..count {
        let public = read_field(packed, &mut at)?;
        let message = read_field(packed, &mut at)?;
        let signature = read_field(packed, &mut at)?;
        checks.push(GraineSignatureCheck {
            public,
            message,
            signature,
        });
    }
    if at != packed.len() {
        return Err(GraineBatchError::Trailing(packed.len() - at));
    }
    Ok(checks)
}

fn read_be32(packed: &[u8], at: &mut usize) -> Result<u32, GraineBatchError> {
    let end = at.checked_add(4).ok_or(GraineBatchError::Truncated(*at))?;
    let bytes = packed
        .get(*at..end)
        .ok_or(GraineBatchError::Truncated(*at))?;
    *at = end;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn read_field<'a>(packed: &'a [u8], at: &mut usize) -> Result<&'a [u8], GraineBatchError> {
    let start = *at;
    let len = read_be32(packed, at)? as usize;
    let end = at
        .checked_add(len)
        .ok_or(GraineBatchError::Truncated(start))?;
    let field = packed
        .get(*at..end)
        .ok_or(GraineBatchError::Truncated(start))?;
    *at = end;
    Ok(field)
}

/// Verifies a page's signatures in ONE call, each one exactly as [`verify_graine_signature`] does -
/// same strict check, same refusals, same per-check log line - and answers one verdict per check, in
/// order. **Not an Ed25519 batch verification**: that answers one bit for the whole set and is not
/// strict, so one forged row would refuse its honest neighbours. What the batch saves is the bridge
/// (one crossing instead of one per row), never a check.
pub fn verify_graine_signatures(
    checks: &[GraineSignatureCheck<'_>],
) -> Vec<Result<(), GraineSignatureError>> {
    let verdicts: Vec<_> = checks
        .iter()
        .map(|c| verify_graine_signature(c.public, c.message, c.signature))
        .collect();
    let refused = verdicts.iter().filter(|v| v.is_err()).count();
    log::debug!(
        "[GRAINE_SIG] batch of {} signature(s) verified, {refused} refused",
        checks.len()
    );
    verdicts
}

/// [`unpack_graine_signature_checks`] then [`verify_graine_signatures`], answered as the verdict
/// codes the JS side classifies on (`valid` or [`GraineSignatureError::code`]). The one entry both
/// the Tauri command and the WASM export call, so the two platforms share the decoder too.
pub fn verify_packed_graine_signatures(
    packed: &[u8],
) -> Result<Vec<&'static str>, GraineBatchError> {
    let checks = unpack_graine_signature_checks(packed).inspect_err(|e| {
        log::error!("[GRAINE_SIG] signature batch refused, nothing verified: {e}");
    })?;
    Ok(verify_graine_signatures(&checks)
        .iter()
        .map(graine_verdict_code)
        .collect())
}

impl MlsManager {
    /// Signs `message` with this device's MLS credential key - the key every group this device is in
    /// already knows it by, which is what makes an endorsement checkable from a distribution group's
    /// tree without any new key to distribute.
    ///
    /// `message` must be a Graine structure (see the module docs for why that can never collide with
    /// an MLS `SignContent`); this is not a general-purpose signing oracle. Its callers are a v2 seed's
    /// endorsement and an admission voucher (channel-encryption section 25), both label-prefixed.
    pub fn sign_with_device_credential(&self, message: &[u8]) -> Result<Vec<u8>, MlsError> {
        log::debug!("[GRAINE_SIG] endorsing with the device credential");
        self.keypair.sign(message).map_err(|e| {
            log::error!("[GRAINE_SIG] device credential signing failed: {e:?}");
            MlsError::OpenMls(format!("sign_with_device_credential: {e:?}"))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bytes 0..31: the session secret the shared vectors use, on the TS side and in `graine.rs`.
    fn vector_secret() -> Vec<u8> {
        (0u8..32).collect()
    }

    #[test]
    fn a_session_signature_verifies_under_its_own_key_only() {
        let a = new_session_keypair().unwrap();
        let b = new_session_keypair().unwrap();
        let sig = sign_with_session_key(&a.secret, b"message").unwrap();
        assert_eq!(sig.len(), GRAINE_SIGNATURE_BYTES);
        assert_eq!(verify_graine_signature(&a.public, b"message", &sig), Ok(()));
        assert_eq!(
            verify_graine_signature(&b.public, b"message", &sig),
            Err(GraineSignatureError::Invalid)
        );
        assert_eq!(
            verify_graine_signature(&a.public, b"messagf", &sig),
            Err(GraineSignatureError::Invalid)
        );
    }

    #[test]
    fn malformed_inputs_are_typed_not_invalid() {
        let a = new_session_keypair().unwrap();
        let sig = sign_with_session_key(&a.secret, b"m").unwrap();
        assert_eq!(
            verify_graine_signature(&a.public[..31], b"m", &sig),
            Err(GraineSignatureError::MalformedPublicKey(31))
        );
        assert_eq!(
            verify_graine_signature(&a.public, b"m", &sig[..63]),
            Err(GraineSignatureError::MalformedSignature(63))
        );
        assert_eq!(
            sign_with_session_key(&[0u8; 16], b"m"),
            Err(GraineSignatureError::MalformedSecretKey(16))
        );
    }

    /// Ed25519 is deterministic, so a fixed secret over fixed bytes is a fixed signature - the value
    /// `graine.test.ts` asserts from WebCrypto and `mobile/graine.rs` from the same crate. A change
    /// of scheme or of key form breaks this before it breaks a phone.
    #[test]
    fn signs_the_shared_vector() {
        let sig = sign_with_session_key(&vector_secret(), b"canari-graine-v2 vector").unwrap();
        let hex: String = sig.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, SHARED_VECTOR_SIGNATURE_HEX);
    }

    const SHARED_VECTOR_SIGNATURE_HEX: &str = "0cbcd5afb70a886d305c0531c2d413a18e5e1290ec31b148d29b9c3e94f8aeea141f8d1c9013fc19ce9b95580944c02395d4379a8c3550df0bfd7c6250b5d209";

    fn pack(checks: &[(&[u8], &[u8], &[u8])]) -> Vec<u8> {
        let mut out = (checks.len() as u32).to_be_bytes().to_vec();
        for (p, m, s) in checks {
            for field in [p, m, s] {
                out.extend_from_slice(&(field.len() as u32).to_be_bytes());
                out.extend_from_slice(field);
            }
        }
        out
    }

    /// The batch answers, check by check, what the single verifier answers - for every verdict the
    /// single one can give - and one refused check changes nothing about its neighbours.
    #[test]
    fn a_batch_answers_each_check_exactly_as_the_single_verifier() {
        let a = new_session_keypair().unwrap();
        let b = new_session_keypair().unwrap();
        let sig = sign_with_session_key(&a.secret, b"row-1").unwrap();
        let sig2 = sign_with_session_key(&a.secret, b"row-2").unwrap();
        // A 32-byte public key that is not a curve point (y = 2 has no x on Ed25519).
        let mut not_a_point = [0u8; 32];
        not_a_point[0] = 2;
        let cases: Vec<(&[u8], &[u8], &[u8])> = vec![
            (&a.public, b"row-1", &sig),
            (&b.public, b"row-1", &sig), // another key
            (&a.public, b"row-X", &sig), // tampered bytes
            (&a.public[..31], b"row-1", &sig),
            (&a.public, b"row-1", &sig[..63]),
            (&not_a_point, b"row-1", &sig),
            (&a.public, b"row-2", &sig2),
        ];
        let packed = pack(&cases);
        let batch = verify_packed_graine_signatures(&packed).unwrap();
        let single: Vec<&str> = cases
            .iter()
            .map(|(p, m, s)| graine_verdict_code(&verify_graine_signature(p, m, s)))
            .collect();
        assert_eq!(batch, single);
        assert_eq!(batch[0], "valid");
        assert_eq!(batch[1], "invalid");
        assert_eq!(batch[2], "invalid");
        assert_eq!(batch[3], "malformed-public-key");
        assert_eq!(batch[4], "malformed-signature");
        assert_eq!(batch[6], "valid");
    }

    #[test]
    fn an_empty_batch_is_an_empty_answer() {
        assert_eq!(
            verify_packed_graine_signatures(&0u32.to_be_bytes()).unwrap(),
            Vec::<&str>::new()
        );
    }

    /// A malformed packing is a broken contract, refused whole - never a verdict about a row.
    #[test]
    fn a_malformed_packing_is_refused_whole() {
        let a = new_session_keypair().unwrap();
        let sig = sign_with_session_key(&a.secret, b"m").unwrap();
        let packed = pack(&[(&a.public, b"m", &sig)]);
        assert!(matches!(
            verify_packed_graine_signatures(&packed[..packed.len() - 1]),
            Err(GraineBatchError::Truncated(_))
        ));
        let mut trailing = packed.clone();
        trailing.push(0);
        assert_eq!(
            verify_packed_graine_signatures(&trailing),
            Err(GraineBatchError::Trailing(1))
        );
        assert!(matches!(
            verify_packed_graine_signatures(&[0, 0]),
            Err(GraineBatchError::Truncated(0))
        ));
        // A count the buffer cannot hold is refused before any allocation.
        assert!(matches!(
            verify_packed_graine_signatures(&u32::MAX.to_be_bytes()),
            Err(GraineBatchError::Truncated(_))
        ));
        // A field length past the end.
        let mut long = 1u32.to_be_bytes().to_vec();
        long.extend_from_slice(&u32::MAX.to_be_bytes());
        long.extend_from_slice(&[0u8; 8]);
        assert!(matches!(
            verify_packed_graine_signatures(&long),
            Err(GraineBatchError::Truncated(4))
        ));
    }

    /// The packing `graineV2.test.ts` asserts from `packGraineSignatureChecks`: the contract between
    /// the WebView's packer and this decoder, pinned on both sides.
    #[test]
    fn unpacks_the_shared_packing_vector() {
        let hex = shared_packing_vector_hex();
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let checks = unpack_graine_signature_checks(&bytes).unwrap();
        assert_eq!(
            checks,
            vec![
                GraineSignatureCheck {
                    public: &[1u8; 32],
                    message: b"ab",
                    signature: &[2u8; 64],
                },
                GraineSignatureCheck {
                    public: &[3],
                    message: &[],
                    signature: &[4, 5],
                },
            ]
        );
    }

    fn shared_packing_vector_hex() -> String {
        format!(
            "00000002{}{}{}{}{}{}{}",
            "00000020",
            "01".repeat(32),
            "000000026162",
            "00000040",
            "02".repeat(64),
            "0000000103",
            "00000000000000020405"
        )
    }

    /// Not a gate: what one page of 200 checks costs in this engine, run with
    /// `cargo test --release -p mls-core page_of_200 -- --ignored --nocapture`. The batch does the
    /// same 200 verifications as 200 single calls; what it removes is 199 crossings of the bridge,
    /// which no test here can run (`community-open-budget.md`, F7).
    #[test]
    #[ignore]
    fn page_of_200_cost() {
        let a = new_session_keypair().unwrap();
        let rows: Vec<(Vec<u8>, Vec<u8>)> = (0..200)
            .map(|i| {
                let m = vec![i as u8; 400];
                let s = sign_with_session_key(&a.secret, &m).unwrap();
                (m, s)
            })
            .collect();
        let cases: Vec<(&[u8], &[u8], &[u8])> = rows
            .iter()
            .map(|(m, s)| (a.public.as_slice(), m.as_slice(), s.as_slice()))
            .collect();
        let packed = pack(&cases);
        let t = std::time::Instant::now();
        for (p, m, s) in &cases {
            assert!(verify_graine_signature(p, m, s).is_ok());
        }
        let single = t.elapsed();
        let t = std::time::Instant::now();
        let batch = verify_packed_graine_signatures(&packed).unwrap();
        let batched = t.elapsed();
        assert!(batch.iter().all(|v| *v == "valid"));
        println!("200 checks: single calls {single:?}, one packed batch {batched:?}");
    }

    #[test]
    fn the_device_credential_signs_what_its_public_key_verifies() {
        let manager = MlsManager::load_or_create("alice", "dev-a", None).unwrap();
        let sig = manager.sign_with_device_credential(b"endorsement").unwrap();
        assert_eq!(
            verify_graine_signature(&manager.keypair.to_public_vec(), b"endorsement", &sig),
            Ok(())
        );
        let other = MlsManager::load_or_create("alice", "dev-b", None).unwrap();
        assert_eq!(
            verify_graine_signature(&other.keypair.to_public_vec(), b"endorsement", &sig),
            Err(GraineSignatureError::Invalid)
        );
    }
}
