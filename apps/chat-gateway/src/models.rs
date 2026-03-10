use prost::Message as ProstMessage;
use serde::{Deserialize, Serialize};

// ── Protobuf generated types ────────────────────────────────────────────────
// Generated from libs/proto/canari.proto by prost-build (build.rs).
// protoc is supplied by the protoc-bin-vendored crate — no system install needed.
#[allow(dead_code, unused_imports)]
pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/canari.rs"));
}

pub use proto::{InboundMsg, Recipient};

// ── JWT / REST serde types (unchanged) ──────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

#[derive(Deserialize)]
pub struct AuthParams {
    pub token: String,
    pub device_id: Option<String>,
}

/// REST payload for Ratchet-Tree storage (unchanged).
#[derive(Serialize, Deserialize)]
pub struct RatchetTreePayload {
    pub data: String,
    pub version: u64,
}

// ── Codec helpers ────────────────────────────────────────────────────────────

/// Encode an `InboundMsg` to wire bytes (for Redis pub/sub → WS send).
pub fn encode_inbound(msg: &InboundMsg) -> Vec<u8> {
    msg.encode_to_vec()
}
