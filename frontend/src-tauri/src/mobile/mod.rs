//! Logique mobile partagée entre Android (JNI) et iOS (FFI C).
//!
//! Centralise le déchiffrement MLS en arrière-plan et le parsing protobuf minimal
//! utilisé par les services push natifs.

#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod background;

#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod proto_fields;

#[cfg(target_os = "ios")]
pub mod ios_ffi;
