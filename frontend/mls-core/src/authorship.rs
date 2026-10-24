//! Authored frames: the author's signature travels INSIDE an application plaintext, so a copy of the
//! message relayed later - in a history bundle, which any member can write - is still checkable
//! against the author's key.
//!
//! MLS proves who sent a frame while the frame is live. Once a member has decrypted it the plaintext
//! is bytes in a local store; the proof is what lets a `history_bundle` say who wrote them.
//!
//! **What is signed.** `author_descriptor` = `lp("canari-mls-author-v1") lp(groupId) lp(author)
//! lp(SHA-256(body))`, where `body` is the exact `AppMessage` bytes the author sent and `author` its
//! credential identity (`userId:deviceId`). The body carries the message id, the author's timestamp
//! and the content, so all three are bound by the hash; the group id stops a proof being replayed
//! into another conversation. The device's MLS credential key signs it, which every member already
//! knows from the tree, so no new key is distributed or trusted. `lp` is the length-prefixed field
//! Graine v2 uses, and for the same reason: every descriptor starts with a `0x00` byte, which as an
//! MLS `SignContent` would be a zero-length label - so a proof can never be replayed into MLS
//! (`graine_signature.rs` has the argument).
//!
//! **Where it travels.** As `AppMessage` field 14 (`AuthorProof { version, author, signature }`),
//! appended as the LAST field of the plaintext. Protobuf parsers skip a field they do not know, so a
//! client older than this reads the message exactly as before; the proof is inside the encryption,
//! because a signature over a guessable plaintext in cleartext would let the server confirm guesses.
//!
//! **What the receiver does.** `vet_author_proof` runs on every decrypted application frame. A proof
//! that verifies against the key of the leaf MLS just authenticated the frame with, and names that
//! leaf, is KEPT in the plaintext; one that does not is STRIPPED and the line accuses. So a proof
//! that reaches the application is one this device checked, and it can never relay a bad one in
//! good faith.
//!
//! Protocol: `docs/wiki/protocols/history-reconciliation.md`, "Restored history carries its author's
//! signature".

use openmls::prelude::HashType;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::signatures::Signer;

use crate::MlsError;
use crate::graine_signature::verify_graine_signature;
use crate::state::MlsManager;

/// `AppMessage` field number of the proof (`libs/proto/canari.proto`).
pub const AUTHOR_PROOF_FIELD: u32 = 14;
/// The only proof layout this build writes or accepts.
pub const AUTHOR_PROOF_VERSION: u32 = 1;
/// The label opening every descriptor - distinct from every Graine label, so no proof verifies as a
/// Graine endorsement or the reverse.
pub const AUTHOR_DESCRIPTOR_LABEL: &str = "canari-mls-author-v1";

/// An author's proof as it travels: who claims the bytes, and their signature over the descriptor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorProof {
    pub version: u32,
    /// `userId:deviceId`, the signer's MLS credential identity.
    pub author: String,
    pub signature: Vec<u8>,
}

/// What a receiver established about an application frame's proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorVerdict {
    /// No proof: a build older than this one, or a frame that is not an `AppMessage`.
    Unsigned,
    /// The proof names the MLS sender and verifies under its leaf key. It is kept in the plaintext.
    Verified,
    /// A proof was present and was not kept: it named someone else, did not verify, or could not be
    /// checked. The reason is a fixed string, for the log line.
    Refused(&'static str),
}

impl AuthorVerdict {
    /// A stable name for the bindings (`unsigned`, `verified`, `refused`), never a sentence.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsigned => "unsigned",
            Self::Verified => "verified",
            Self::Refused(_) => "refused",
        }
    }
}

/// A frame this device sent with its proof, and the proof itself so the sender's own copy carries it.
pub struct AuthoredFrame {
    pub ciphertext: Vec<u8>,
    /// The encoded `AuthorProof` (the field's payload, not the field), as the receiver will see it.
    pub author_proof: Vec<u8>,
}

/// SHA-256, shared with `fork_check.rs`.
pub(crate) fn sha256(bytes: &[u8]) -> Vec<u8> {
    // The provider's hash cannot fail for SHA-256 on this backend; an error here is a broken build.
    RustCrypto::default()
        .hash(HashType::Sha2_256, bytes)
        .expect("SHA-256 is always available on RustCrypto")
}

/// Appends a 4-byte big-endian length then `bytes` - the descriptor field of Graine v2, shared with
/// `fork_check.rs`.
pub(crate) fn lp(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// The bytes an author signs for `body` in `group_id`. Mirrored by `messageAuthorship.ts`; the
/// shared vector in `tests/authored_frames.rs` and its TS twin hold the two together.
pub fn author_descriptor(group_id: &str, author: &str, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 * 4 + 20 + group_id.len() + author.len() + 32);
    lp(&mut out, AUTHOR_DESCRIPTOR_LABEL.as_bytes());
    lp(&mut out, group_id.as_bytes());
    lp(&mut out, author.as_bytes());
    lp(&mut out, &sha256(body));
    out
}

fn write_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn read_varint(bytes: &[u8], pos: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    let mut cur = pos;
    loop {
        if cur >= bytes.len() || shift >= 64 {
            return None;
        }
        let byte = bytes[cur] as u64;
        result |= (byte & 0x7f) << shift;
        cur += 1;
        if byte & 0x80 == 0 {
            return Some((result, cur));
        }
        shift += 7;
    }
}

/// The payload of `AuthorProof`: `version` (1, varint), `author` (2, string), `signature` (3, bytes).
pub fn encode_author_proof(proof: &AuthorProof) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + proof.author.len() + proof.signature.len());
    out.push(0x08);
    write_varint(&mut out, proof.version as u64);
    out.push(0x12);
    write_varint(&mut out, proof.author.len() as u64);
    out.extend_from_slice(proof.author.as_bytes());
    out.push(0x1a);
    write_varint(&mut out, proof.signature.len() as u64);
    out.extend_from_slice(&proof.signature);
    out
}

fn decode_author_proof(inner: &[u8]) -> Option<AuthorProof> {
    let mut version = None;
    let mut author = None;
    let mut signature = None;
    let mut pos = 0;
    while pos < inner.len() {
        let (tag, after) = read_varint(inner, pos)?;
        pos = after;
        match (tag >> 3, tag & 0x7) {
            (1, 0) => {
                let (v, next) = read_varint(inner, pos)?;
                version = Some(u32::try_from(v).ok()?);
                pos = next;
            }
            (2, 2) | (3, 2) => {
                let (len, after_len) = read_varint(inner, pos)?;
                let end = after_len.checked_add(usize::try_from(len).ok()?)?;
                let value = inner.get(after_len..end)?;
                if tag >> 3 == 2 {
                    author = Some(String::from_utf8(value.to_vec()).ok()?);
                } else {
                    signature = Some(value.to_vec());
                }
                pos = end;
            }
            _ => return None,
        }
    }
    Some(AuthorProof {
        version: version?,
        author: author?,
        signature: signature?,
    })
}

/// `body` with the proof appended as its last field. Protobuf merges fields, so the result is
/// `body` plus one field an older parser skips.
pub fn append_author_proof(body: &[u8], proof_payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + proof_payload.len() + 4);
    out.extend_from_slice(body);
    write_varint(&mut out, ((AUTHOR_PROOF_FIELD as u64) << 3) | 2);
    write_varint(&mut out, proof_payload.len() as u64);
    out.extend_from_slice(proof_payload);
    out
}

/// Finds a proof appended as the LAST field of `plaintext`, returning the length of the body before
/// it and the proof. `None` when the plaintext is not protobuf, has no field 14 at its end, or the
/// field does not decode - a field 14 anywhere but last is not the trailer an author appended.
pub fn split_author_proof(plaintext: &[u8]) -> Option<(usize, AuthorProof)> {
    let mut pos = 0usize;
    let mut last: Option<(usize, u64, std::ops::Range<usize>)> = None;
    while pos < plaintext.len() {
        let start = pos;
        let (tag, after_tag) = read_varint(plaintext, pos)?;
        pos = after_tag;
        let range = match tag & 0x7 {
            0 => {
                let (_, next) = read_varint(plaintext, pos)?;
                pos..next
            }
            1 => pos..pos.checked_add(8)?,
            2 => {
                let (len, after_len) = read_varint(plaintext, pos)?;
                after_len..after_len.checked_add(usize::try_from(len).ok()?)?
            }
            5 => pos..pos.checked_add(4)?,
            _ => return None,
        };
        if range.end > plaintext.len() {
            return None;
        }
        pos = range.end;
        last = Some((start, tag, range));
    }
    let (start, tag, range) = last?;
    if tag != (((AUTHOR_PROOF_FIELD as u64) << 3) | 2) {
        return None;
    }
    decode_author_proof(&plaintext[range]).map(|proof| (start, proof))
}

/// Decides what to do with the proof of a decrypted application frame - KEEP it (it names the MLS
/// sender and verifies under that leaf's key) or STRIP it - and says which.
///
/// `sender_identity` and `sender_key` are the leaf MLS authenticated the frame with. A proof that
/// cannot be checked against them is stripped like a forged one: the application only ever sees a
/// proof this device verified, so it cannot relay a bad one and be accused of forging it.
pub(crate) fn vet_author_proof(
    plaintext: Vec<u8>,
    group_id: &str,
    sender_identity: Option<&str>,
    sender_key: Option<&[u8]>,
) -> (Vec<u8>, AuthorVerdict) {
    let Some((body_len, proof)) = split_author_proof(&plaintext) else {
        return (plaintext, AuthorVerdict::Unsigned);
    };
    let refusal = if proof.version != AUTHOR_PROOF_VERSION {
        Some("unknown proof version")
    } else if sender_identity != Some(proof.author.as_str()) {
        Some("the proof names another author than the MLS sender")
    } else if let Some(key) = sender_key {
        let descriptor = author_descriptor(group_id, &proof.author, &plaintext[..body_len]);
        match verify_graine_signature(key, &descriptor, &proof.signature) {
            Ok(()) => None,
            Err(_) => Some("the signature does not verify under the sender's leaf key"),
        }
    } else {
        Some("the sender's leaf key is not readable")
    };
    match refusal {
        None => (plaintext, AuthorVerdict::Verified),
        Some(why) => {
            log::error!(
                "[AUTHORSHIP] REFUSED the author proof of a frame on group {} from {:?} (claims {}): \
                 {why} - the proof is stripped, the message is kept as the MLS sender's",
                group_id,
                sender_identity,
                proof.author
            );
            let mut body = plaintext;
            body.truncate(body_len);
            (body, AuthorVerdict::Refused(why))
        }
    }
}

impl MlsManager {
    /// This device's credential identity, `userId:deviceId` - the name its leaf carries everywhere.
    pub(crate) fn own_identity(&self) -> String {
        String::from_utf8_lossy(self.credential.identity()).to_string()
    }

    /// The encoded `AuthorProof` this device would append to `body` in `group_id`. Deterministic
    /// (Ed25519), so it is also how a sender's own copy of a message carries the proof it sent.
    pub fn author_proof_for(&self, group_id: &str, body: &[u8]) -> Result<Vec<u8>, MlsError> {
        let author = self.own_identity();
        let descriptor = author_descriptor(group_id, &author, body);
        let signature = self.keypair.sign(&descriptor).map_err(|e| {
            log::error!("[AUTHORSHIP] could not sign a frame for {group_id}: {e:?}");
            MlsError::OpenMls(format!("author_proof_for: {e:?}"))
        })?;
        Ok(encode_author_proof(&AuthorProof {
            version: AUTHOR_PROOF_VERSION,
            author,
            signature,
        }))
    }

    /// Encrypts `body` with this device's author proof appended - the send every application
    /// message of the app goes through, on every platform. Returns the proof beside the ciphertext.
    pub fn send_authored_message(
        &mut self,
        group_id: &str,
        body: &[u8],
    ) -> Result<AuthoredFrame, MlsError> {
        let author_proof = self.author_proof_for(group_id, body)?;
        let plaintext = append_author_proof(body, &author_proof);
        let ciphertext = self.send_message(group_id, &plaintext)?;
        log::debug!(
            "[AUTHORSHIP] signed frame for {} ({} body bytes)",
            group_id.chars().take(8).collect::<String>(),
            body.len()
        );
        Ok(AuthoredFrame {
            ciphertext,
            author_proof,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_proof_round_trips() {
        let proof = AuthorProof {
            version: 1,
            author: "alice:dev-a".into(),
            signature: vec![9u8; 64],
        };
        let body = b"\x0a\x02\x0a\x00".to_vec();
        let signed = append_author_proof(&body, &encode_author_proof(&proof));
        let (len, back) = split_author_proof(&signed).unwrap();
        assert_eq!(len, body.len());
        assert_eq!(back, proof);
    }

    #[test]
    fn a_proof_missing_a_field_does_not_decode() {
        // version only: no author, no signature.
        let inner = vec![0x08, 0x01];
        assert!(decode_author_proof(&inner).is_none());
    }
}
