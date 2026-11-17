//! A history answer SEALED to the device that asked for it - option B of the P1 "a new member of a
//! group conversation receives its whole past" (`docs/wiki/protocols/history-answer-addressing.md`,
//! "Sealing the answer to the asker").
//!
//! Since step A a history answer is ADDRESSED: the server routes it to the asking device alone. MLS
//! still encrypts it under the group's epoch secret, so the routing is the only thing keeping it
//! from every other member - a server that hands the row to another member's device hands it a
//! frame that device can decrypt. Sealing removes that trust in the server:
//!
//! - the ask carries a FRESH public key, minted for that ask alone ([`history_answer_keypair`]),
//!   inside the asker's MLS-signed frame - so the key is authenticated as the asker device's by the
//!   same signature that authenticates the ask;
//! - the answerer seals the answer's content to that key with HPKE (RFC 9180, base mode) -
//!   [`seal_history_answer`]; only the holder of the ask's secret can open it ([`open_history_answer`]);
//! - the secret never leaves the asking page's memory and dies with the ask, so there is nothing to
//!   store, rotate or back up.
//!
//! **HPKE, and this exact configuration**: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM -
//! the HPKE half of the MLS ciphersuite every Canari group already uses
//! (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`), through the same `openmls_rust_crypto` provider.
//! No new primitive, no new dependency, and the same code on the web (WASM) and the phones (Tauri).
//!
//! **Domain separation**: the HPKE `info` is [`HISTORY_ANSWER_INFO`], which no MLS structure uses,
//! and the AAD is the caller's binding of the answer to its context (the conversation, the ask, the
//! asker and the answerer - built in one place on the JS side, `historySealAad`). A sealed answer
//! relayed by another member under its own MLS frame, or replayed into another ask, does not open.

use openmls_rust_crypto::RustCrypto;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::random::OpenMlsRand;
use openmls_traits::types::{HpkeAeadType, HpkeCiphertext, HpkeConfig, HpkeKdfType, HpkeKemType};
use zeroize::Zeroizing;

/// An X25519 public key, as the ask carries it.
pub const HISTORY_ANSWER_PUBLIC_KEY_BYTES: usize = 32;
/// An X25519 secret key, as the asker keeps it beside its open ask.
pub const HISTORY_ANSWER_SECRET_KEY_BYTES: usize = 32;
/// The X25519 KEM's encapsulated key.
const KEM_OUTPUT_BYTES: usize = 32;
/// The first byte of a sealed answer: which framing follows. One value today.
pub const HISTORY_SEAL_VERSION: u8 = 1;
/// AES-128-GCM's tag - the shortest ciphertext a sealed empty plaintext produces.
const AEAD_TAG_BYTES: usize = 16;

/// The HPKE `info` every sealed history answer is bound to. Versioned with the framing.
pub const HISTORY_ANSWER_INFO: &[u8] = b"canari history answer v1";

/// The one HPKE configuration of a sealed answer - see the module documentation for why this one.
const CONFIG: HpkeConfig = HpkeConfig(
    HpkeKemType::DhKem25519,
    HpkeKdfType::HkdfSha256,
    HpkeAeadType::AesGcm128,
);

/// Why a key could not be minted or an answer could not be sealed or opened - a TYPE, so the JS
/// side classifies on [`HistorySealError::code`] and never on a sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HistorySealError {
    /// The public key was not [`HISTORY_ANSWER_PUBLIC_KEY_BYTES`] long, or HPKE refused it.
    #[error("malformed history answer public key ({0} bytes)")]
    MalformedPublicKey(usize),
    /// The secret key was not [`HISTORY_ANSWER_SECRET_KEY_BYTES`] long.
    #[error("malformed history answer secret key ({0} bytes)")]
    MalformedSecretKey(usize),
    /// The sealed bytes are not a framing this build reads: too short, or another version byte.
    #[error("malformed sealed history answer ({0} bytes)")]
    MalformedSealed(usize),
    /// Well-formed, and it does not open: another key, another AAD, or bytes changed since.
    #[error("sealed history answer does not open")]
    Refused,
    /// The platform could not produce randomness for a new pair.
    #[error("no randomness for a history answer key")]
    Randomness,
}

impl HistorySealError {
    /// A stable code for the JS side.
    pub fn code(&self) -> &'static str {
        match self {
            Self::MalformedPublicKey(_) => "malformed-public-key",
            Self::MalformedSecretKey(_) => "malformed-secret-key",
            Self::MalformedSealed(_) => "malformed-sealed",
            Self::Refused => "refused",
            Self::Randomness => "randomness",
        }
    }
}

/// A pair minted for ONE ask. The secret zeroizes on drop.
pub struct HistoryAnswerKeyPair {
    pub secret: Zeroizing<Vec<u8>>,
    pub public: Vec<u8>,
}

/// Mints the pair of one history ask: 32 bytes from the OS, derived into an X25519 pair by HPKE's
/// own `DeriveKeyPair` (RFC 9180 section 7.1.3), so the secret is a valid scalar by construction.
pub fn history_answer_keypair() -> Result<HistoryAnswerKeyPair, HistorySealError> {
    let crypto = RustCrypto::default();
    let ikm = Zeroizing::new(crypto.random_vec(32).map_err(|e| {
        log::error!("[HISTORY_SEAL] no randomness for an answer key: {e:?}");
        HistorySealError::Randomness
    })?);
    let pair = crypto.derive_hpke_keypair(CONFIG, &ikm).map_err(|e| {
        log::error!("[HISTORY_SEAL] answer key derivation failed: {e:?}");
        HistorySealError::Randomness
    })?;
    log::debug!("[HISTORY_SEAL] minted an answer key pair");
    Ok(HistoryAnswerKeyPair {
        secret: Zeroizing::new(pair.private.to_vec()),
        public: pair.public,
    })
}

/// Seals `plaintext` to the asker's `public` key, bound to `aad`.
///
/// The framing is `HISTORY_SEAL_VERSION || kem_output (32) || ciphertext`. Every call encapsulates
/// afresh, so two chunks of one answer share no key material.
pub fn seal_history_answer(
    public: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, HistorySealError> {
    if public.len() != HISTORY_ANSWER_PUBLIC_KEY_BYTES {
        log::warn!(
            "[HISTORY_SEAL] refusing to seal: the asker's key is {} bytes (want {HISTORY_ANSWER_PUBLIC_KEY_BYTES})",
            public.len()
        );
        return Err(HistorySealError::MalformedPublicKey(public.len()));
    }
    let sealed = RustCrypto::default()
        .hpke_seal(CONFIG, public, HISTORY_ANSWER_INFO, aad, plaintext)
        .map_err(|e| {
            log::warn!("[HISTORY_SEAL] HPKE refused the asker's key: {e:?}");
            HistorySealError::MalformedPublicKey(public.len())
        })?;
    let kem = sealed.kem_output.as_slice();
    let ct = sealed.ciphertext.as_slice();
    if kem.len() != KEM_OUTPUT_BYTES {
        // The provider's X25519 KEM always encapsulates 32 bytes; anything else is a provider
        // change this framing does not describe, and is said rather than written out.
        log::error!(
            "[HISTORY_SEAL] the KEM produced {} bytes (want {KEM_OUTPUT_BYTES}) - nothing sealed",
            kem.len()
        );
        return Err(HistorySealError::MalformedPublicKey(public.len()));
    }
    let mut out = Vec::with_capacity(1 + kem.len() + ct.len());
    out.push(HISTORY_SEAL_VERSION);
    out.extend_from_slice(kem);
    out.extend_from_slice(ct);
    log::debug!(
        "[HISTORY_SEAL] sealed {} byte(s) into {} byte(s)",
        plaintext.len(),
        out.len()
    );
    Ok(out)
}

/// Opens an answer sealed by [`seal_history_answer`] with the ask's `secret`, checking `aad`.
pub fn open_history_answer(
    secret: &[u8],
    aad: &[u8],
    sealed: &[u8],
) -> Result<Vec<u8>, HistorySealError> {
    if secret.len() != HISTORY_ANSWER_SECRET_KEY_BYTES {
        log::warn!(
            "[HISTORY_SEAL] refusing to open: the secret is {} bytes (want {HISTORY_ANSWER_SECRET_KEY_BYTES})",
            secret.len()
        );
        return Err(HistorySealError::MalformedSecretKey(secret.len()));
    }
    if sealed.len() < 1 + KEM_OUTPUT_BYTES + AEAD_TAG_BYTES || sealed[0] != HISTORY_SEAL_VERSION {
        log::warn!(
            "[HISTORY_SEAL] refusing to open: {} byte(s), not a framing this build reads",
            sealed.len()
        );
        return Err(HistorySealError::MalformedSealed(sealed.len()));
    }
    let input = HpkeCiphertext {
        kem_output: sealed[1..1 + KEM_OUTPUT_BYTES].to_vec().into(),
        ciphertext: sealed[1 + KEM_OUTPUT_BYTES..].to_vec().into(),
    };
    RustCrypto::default()
        .hpke_open(CONFIG, &input, secret, HISTORY_ANSWER_INFO, aad)
        .map_err(|e| {
            log::warn!("[HISTORY_SEAL] a sealed answer did not open: {e:?}");
            HistorySealError::Refused
        })
}

/// Opens with a secret handed over OWNED - the WASM export's shape, whose copy of the secret in linear
/// memory is zeroized on return rather than freed with the bytes still in it (review of #3775).
pub fn open_history_answer_owned(
    secret: Vec<u8>,
    aad: &[u8],
    sealed: &[u8],
) -> Result<Vec<u8>, HistorySealError> {
    let secret = Zeroizing::new(secret);
    open_history_answer(&secret, aad, sealed)
}

/// Opens with a secret that arrives as BASE64 - the Tauri bridge's shape. The string and the bytes it
/// decodes to are zeroized on drop: the secret crossed the bridge as a string once (review of #3775),
/// and nothing here keeps a copy of it beyond this call.
pub fn open_history_answer_with_b64_secret(
    secret_b64: String,
    aad: &[u8],
    sealed: &[u8],
) -> Result<Vec<u8>, HistorySealError> {
    use base64::Engine;
    let secret_b64 = Zeroizing::new(secret_b64);
    let secret = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(secret_b64.as_bytes())
            .map_err(|_| {
                log::warn!("[HISTORY_SEAL] refusing to open: the secret is not base64");
                HistorySealError::MalformedSecretKey(0)
            })?,
    );
    open_history_answer(&secret, aad, sealed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AAD: &[u8] = b"group|request|asker|answerer";

    #[test]
    fn an_answer_sealed_to_the_asker_opens_with_its_secret() {
        let pair = history_answer_keypair().unwrap();
        assert_eq!(pair.public.len(), HISTORY_ANSWER_PUBLIC_KEY_BYTES);
        assert_eq!(pair.secret.len(), HISTORY_ANSWER_SECRET_KEY_BYTES);
        let sealed = seal_history_answer(&pair.public, AAD, b"{\"messages\":[]}").unwrap();
        assert_eq!(sealed[0], HISTORY_SEAL_VERSION);
        assert_eq!(
            open_history_answer(&pair.secret, AAD, &sealed).unwrap(),
            b"{\"messages\":[]}"
        );
    }

    #[test]
    fn an_empty_plaintext_seals_and_opens() {
        let pair = history_answer_keypair().unwrap();
        let sealed = seal_history_answer(&pair.public, AAD, b"").unwrap();
        assert_eq!(sealed.len(), 1 + KEM_OUTPUT_BYTES + AEAD_TAG_BYTES);
        assert!(
            open_history_answer(&pair.secret, AAD, &sealed)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn another_members_secret_does_not_open_it() {
        let asker = history_answer_keypair().unwrap();
        let other = history_answer_keypair().unwrap();
        let sealed = seal_history_answer(&asker.public, AAD, b"past").unwrap();
        assert_eq!(
            open_history_answer(&other.secret, AAD, &sealed),
            Err(HistorySealError::Refused)
        );
    }

    #[test]
    fn a_sealed_answer_relayed_into_another_context_does_not_open() {
        let pair = history_answer_keypair().unwrap();
        let sealed = seal_history_answer(&pair.public, AAD, b"past").unwrap();
        assert_eq!(
            open_history_answer(&pair.secret, b"group|request|asker|someone-else", &sealed),
            Err(HistorySealError::Refused)
        );
    }

    #[test]
    fn a_changed_byte_does_not_open() {
        let pair = history_answer_keypair().unwrap();
        let mut sealed = seal_history_answer(&pair.public, AAD, b"past").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert_eq!(
            open_history_answer(&pair.secret, AAD, &sealed),
            Err(HistorySealError::Refused)
        );
    }

    #[test]
    fn two_seals_of_one_plaintext_differ() {
        let pair = history_answer_keypair().unwrap();
        let a = seal_history_answer(&pair.public, AAD, b"past").unwrap();
        let b = seal_history_answer(&pair.public, AAD, b"past").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn a_base64_secret_opens_what_its_bytes_open() {
        use base64::Engine;
        let pair = history_answer_keypair().unwrap();
        let sealed = seal_history_answer(&pair.public, AAD, b"past").unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(pair.secret.as_slice());
        assert_eq!(
            open_history_answer_with_b64_secret(b64, AAD, &sealed).unwrap(),
            b"past"
        );
        assert_eq!(
            open_history_answer_with_b64_secret("not base64!".to_string(), AAD, &sealed),
            Err(HistorySealError::MalformedSecretKey(0))
        );
    }

    #[test]
    fn malformed_inputs_are_typed() {
        let pair = history_answer_keypair().unwrap();
        assert_eq!(
            seal_history_answer(&[0u8; 31], AAD, b"x"),
            Err(HistorySealError::MalformedPublicKey(31))
        );
        assert_eq!(
            open_history_answer(&[0u8; 16], AAD, &[1u8; 64]),
            Err(HistorySealError::MalformedSecretKey(16))
        );
        assert_eq!(
            open_history_answer(&pair.secret, AAD, &[1u8; 10]),
            Err(HistorySealError::MalformedSealed(10))
        );
        let mut sealed = seal_history_answer(&pair.public, AAD, b"x").unwrap();
        sealed[0] = 2;
        assert_eq!(
            open_history_answer(&pair.secret, AAD, &sealed),
            Err(HistorySealError::MalformedSealed(sealed.len()))
        );
    }
}
