//! Mobile logic shared between Android (JNI) and iOS (C FFI).
//!
//! Centralizes background MLS decryption and the minimal protobuf parsing used by the native push
//! services.
//!
//! Compiled on a host `cargo test` too (see the gate on `mod mobile` in `lib.rs`), so the shared
//! logic is covered without a device build. In that configuration the only callers are the tests,
//! and everything else here is reached from the JNI / C-FFI entry points, which stay platform-gated
//! - hence the dead-code allowance, which is scoped to exactly that build.
#![cfg_attr(
    all(test, not(any(target_os = "android", target_os = "ios"))),
    allow(dead_code)
)]

#[cfg(any(target_os = "android", target_os = "ios", test))]
pub mod background;

#[cfg(any(target_os = "android", target_os = "ios", test))]
pub mod graine;

#[cfg(any(target_os = "android", target_os = "ios", test))]
pub mod proto_fields;

// The cross-version gate for `aes-gcm`, and the only module here that is TEST-ONLY: it asserts
// against committed bytes rather than shipping anything. It lives inside the crate rather than
// under `tests/` because `mod mobile` exists only under `cfg(test)` on a host build, so an
// integration test would link an rlib that does not contain the function it is about.
#[cfg(test)]
mod cross_version_push;

#[cfg(target_os = "ios")]
pub mod ios_ffi;
