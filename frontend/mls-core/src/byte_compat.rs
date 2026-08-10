//! CBOR byte-string encoding for the persisted MLS state, with a reader for the legacy encoding.
//!
//! # Why this exists
//!
//! `serde` has no dedicated `Vec<u8>`: the derived impls route it through the GENERIC sequence
//! path, so `ciborium` wrote every byte buffer as a CBOR ARRAY OF INTEGERS and read it back one
//! integer at a time - `Vec<u8>::deserialize` -> `deserialize_seq` -> `VecVisitor<u8>::visit_seq`
//! -> `SeqAccess::next_element::<u8>` -> `Decoder::pull` -> `Header::try_from`, i.e. **one CBOR
//! header parse per byte**. On a 2.67 MB `mls.bin` that burned 58.6 s of CPU on a Pixel 6a and
//! ANRed the app from `CanariBootReceiver`, which runs after every store update (WP-ANR-1).
//!
//! It is also roughly twice the size it needs to be: any byte >= 24 costs two bytes as a CBOR
//! integer, against one inside a byte string. So this wins on disk as well as on CPU.
//!
//! # The compatibility contract, which is not optional
//!
//! Changing how state is written is an AT-REST FORMAT CHANGE, and the durable rule is that a
//! reader for the previous format ships in the SAME commit. [`ByteBuf`] therefore accepts BOTH
//! encodings on the way in and emits only the new one on the way out, so:
//!
//! - an `mls.bin` written by any previous version loads unchanged, and is rewritten in the new
//!   encoding at the next save;
//! - a device that has already migrated cannot be read by a build older than this commit. That is
//!   a deliberate, one-way step (decision taken 2026-08-11): the frontend must not be rolled back
//!   past it, or every migrated user loses their identity and every group.
//!
//! Nothing here is MLS-aware: it changes only how opaque bytes are framed. Keys are never
//! inspected, transformed or re-derived.

use serde::de::{Deserializer, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq, Serializer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// A byte buffer that SERIALIZES as a CBOR byte string and DESERIALIZES from either a byte string
/// or the legacy array of integers.
///
/// `Hash`/`Eq` are required because it stands in for the key type of the OpenMLS keystore map.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub(crate) struct ByteBuf(pub(crate) Vec<u8>);

impl Serialize for ByteBuf {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(&self.0)
    }
}

struct ByteBufVisitor;

impl<'de> Visitor<'de> for ByteBufVisitor {
    type Value = ByteBuf;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a byte string, or a legacy array of byte-valued integers")
    }

    fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
        Ok(ByteBuf(v.to_vec()))
    }

    fn visit_byte_buf<E: serde::de::Error>(self, v: Vec<u8>) -> Result<Self::Value, E> {
        Ok(ByteBuf(v))
    }

    /// The legacy path. Kept deliberately: it is the ONLY thing that lets an existing install load.
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        // `size_hint` is absent for an indefinite-length CBOR array, so this is a hint, not a rule.
        let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0));
        while let Some(byte) = seq.next_element::<u8>()? {
            out.push(byte);
        }
        Ok(ByteBuf(out))
    }
}

impl<'de> Deserialize<'de> for ByteBuf {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // `deserialize_byte_buf` is what makes ciborium hand over a byte string whole. A decoder
        // that finds an array there still drives `visit_seq`, which is what reads legacy files.
        deserializer.deserialize_byte_buf(ByteBufVisitor)
    }
}

/// `#[serde(with = ...)]` for an owned `Vec<u8>` field.
pub(crate) mod bytes {
    use super::*;

    pub(crate) fn serialize<S: Serializer>(v: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(v)
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        Ok(ByteBuf::deserialize(d)?.0)
    }
}

/// `#[serde(with = ...)]` for a `Vec<Vec<u8>>` field, and for the `&[Vec<u8>]` that writes it.
pub(crate) mod bytes_vec {
    use super::*;

    pub(crate) fn serialize<S: Serializer>(
        v: &[Vec<u8>],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(v.len()))?;
        for item in v {
            seq.serialize_element(&ByteBuf(item.clone()))?;
        }
        seq.end()
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<Vec<u8>>, D::Error> {
        Ok(Vec::<ByteBuf>::deserialize(d)?
            .into_iter()
            .map(|b| b.0)
            .collect())
    }
}

/// `#[serde(with = ...)]` for the OpenMLS keystore map - the bulk of the file, and so the whole
/// point of this module. Both the key and the value are byte buffers.
pub(crate) mod bytes_map {
    use super::*;

    pub(crate) fn serialize<S: Serializer>(
        v: &HashMap<Vec<u8>, Vec<u8>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(v.len()))?;
        for (k, val) in v {
            // `serialize_entry` borrows, so no buffer is copied here - only the two thin newtype
            // wrappers are built, which is what keeps the "no HashMap::clone" property of
            // `serialize_state` intact.
            map.serialize_entry(&ByteBufRef(k), &ByteBufRef(val))?;
        }
        map.end()
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<HashMap<Vec<u8>, Vec<u8>>, D::Error> {
        Ok(HashMap::<ByteBuf, ByteBuf>::deserialize(d)?
            .into_iter()
            .map(|(k, v)| (k.0, v.0))
            .collect())
    }
}

/// Borrowed twin of [`ByteBuf`] for the write path, so serializing never copies a buffer.
pub(crate) struct ByteBufRef<'a>(pub(crate) &'a [u8]);

impl Serialize for ByteBufRef<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ciborium::{de::from_reader, ser::into_writer};

    /// The shape of the persisted state, reduced to the fields whose encoding changed.
    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct Sample {
        #[serde(with = "bytes")]
        blob: Vec<u8>,
        #[serde(with = "bytes_map")]
        map: HashMap<Vec<u8>, Vec<u8>>,
        #[serde(with = "bytes_vec")]
        list: Vec<Vec<u8>>,
    }

    /// The LEGACY shape: identical fields, all on serde's generic `Vec<u8>` path. This is what
    /// every `mls.bin` in the field was written with, so it is the fixture the reader must accept.
    #[derive(Serialize)]
    struct LegacySample {
        blob: Vec<u8>,
        map: HashMap<Vec<u8>, Vec<u8>>,
        list: Vec<Vec<u8>>,
    }

    /// The three field shapes under test, in the order `Sample` declares them.
    type Fixture = (Vec<u8>, HashMap<Vec<u8>, Vec<u8>>, Vec<Vec<u8>>);

    fn fixture() -> Fixture {
        // Values on both sides of 24, which is where a CBOR integer stops fitting in one byte -
        // the reason the legacy encoding is also ~2x larger.
        let blob = vec![0u8, 1, 23, 24, 127, 128, 255];
        let mut map = HashMap::new();
        map.insert(vec![1u8, 2, 3], vec![250u8, 251, 252]);
        map.insert(vec![0u8], vec![]);
        let list = vec![vec![9u8, 8, 7], vec![]];
        (blob, map, list)
    }

    #[test]
    fn round_trips_through_the_new_encoding() {
        let (blob, map, list) = fixture();
        let sample = Sample { blob, map, list };

        let mut bytes = Vec::new();
        into_writer(&sample, &mut bytes).unwrap();
        let back: Sample = from_reader(bytes.as_slice()).unwrap();

        assert_eq!(back, sample);
    }

    #[test]
    fn reads_a_legacy_array_of_integers_file() {
        // The compatibility contract. If this ever fails, every existing install loses its
        // identity and every group on upgrade - there is no recovery path.
        let (blob, map, list) = fixture();
        let legacy = LegacySample {
            blob: blob.clone(),
            map: map.clone(),
            list: list.clone(),
        };

        let mut legacy_bytes = Vec::new();
        into_writer(&legacy, &mut legacy_bytes).unwrap();
        let back: Sample = from_reader(legacy_bytes.as_slice()).unwrap();

        assert_eq!(back.blob, blob);
        assert_eq!(back.map, map);
        assert_eq!(back.list, list);
    }

    #[test]
    fn the_new_encoding_is_smaller_than_the_legacy_one() {
        // Not a micro-optimisation: the size ratio is why `mls.bin` was 2.67 MB, and the decode
        // cost is proportional to it. A regression here means the byte-string path was lost.
        let (blob, map, list) = fixture();
        let mut new_bytes = Vec::new();
        into_writer(
            &Sample {
                blob: blob.clone(),
                map: map.clone(),
                list: list.clone(),
            },
            &mut new_bytes,
        )
        .unwrap();
        let mut legacy_bytes = Vec::new();
        into_writer(&LegacySample { blob, map, list }, &mut legacy_bytes).unwrap();

        assert!(
            new_bytes.len() < legacy_bytes.len(),
            "new={} legacy={}",
            new_bytes.len(),
            legacy_bytes.len()
        );
    }

    #[test]
    fn an_empty_buffer_survives_both_encodings() {
        #[derive(Serialize)]
        struct LegacyEmpty {
            blob: Vec<u8>,
        }
        #[derive(Deserialize)]
        struct NewEmpty {
            #[serde(with = "bytes")]
            blob: Vec<u8>,
        }

        let mut legacy_bytes = Vec::new();
        into_writer(&LegacyEmpty { blob: Vec::new() }, &mut legacy_bytes).unwrap();
        let back: NewEmpty = from_reader(legacy_bytes.as_slice()).unwrap();
        assert!(back.blob.is_empty());
    }
}
