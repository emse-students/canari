//! Mobile logic shared between Android (JNI) and iOS (C FFI).
//!
//! Centralizes background MLS decryption and the minimal protobuf parsing used by the native push
//! services.

#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod background;

#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod proto_fields;

#[cfg(target_os = "ios")]
pub mod ios_ffi;
