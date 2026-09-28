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

impl MlsManager {
    /// Signs `message` with this device's MLS credential key - the key every group this device is in
    /// already knows it by, which is what makes an endorsement checkable from a distribution group's
    /// tree without any new key to distribute.
    ///
    /// `message` must be a Graine structure (see the module docs for why that can never collide with
    /// an MLS `SignContent`); this is not a general-purpose signing oracle and has no other caller.
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
