//! What severity a Rust log record deserves once it reaches a client's console.
//!
//! # Why this is a decision and not a passthrough
//!
//! Two crates emit at ERROR into the same console: this one, which knows the group, both epochs
//! and the marker every consumer keys on - and `openmls`, which logs from deep inside its framing
//! and validation code, where it knows none of that. `Sender data decryption error` names no group,
//! no epoch and no frame. `Wrong Epoch: message.epoch() 1 > 10 self.group_context().epoch()` names
//! epochs with no group. Every path that produces one of those is wrapped here, and reports the
//! SAME event one line later with everything a reader needs - or returns a typed [`crate::MlsError`]
//! the caller surfaces. So the upstream line is a duplicate of a better line, at a level that
//! accuses, and a line its reader learns to skip is the one that hides the next defect.
//!
//! Measured on production 2026-09-12: six `[RUST::ERROR] Sender data decryption error` in a single
//! idle window, each immediately followed by this crate's own classified report of the same frame.
//!
//! # Why it keys on the emitter
//!
//! The two rules this replaces were text matches on another crate's prose (`Wrong Epoch`,
//! `wrong epoch`), kept in TWO places that had drifted apart - the wasm logger and the JS bridge
//! above it. A text match breaks on any upstream rewording, and it would swallow one of our own
//! lines that happened to quote the same words. `target()` is the emitting module path, decided at
//! compile time, and cannot drift.
//!
//! # Why it lives here rather than in `mls-wasm`
//!
//! `mls-wasm` builds for `wasm32-unknown-unknown` and CI never runs a test in it - a `#[cfg(test)]`
//! module there is a gate that is never opened. This crate is the one that is tested, and it is
//! also the crate whose reports make the upstream ones redundant, so the argument and the code sit
//! together. See `tests/console_levels.rs`.

use log::Level;

/// Crate prefix whose own narration this crate already re-reports with context.
const UPSTREAM_NARRATOR: &str = "openmls";

/// The level `record` should be PRINTED at, given the level it was emitted at, its `target`
/// (the emitting module path) and its formatted `message`.
///
/// Never raises a level and never drops a line: the most it does is demote a duplicate to
/// [`Level::Debug`], where it stays available to anyone reading the full console.
pub fn console_level(emitted: Level, target: &str, message: &str) -> Level {
    if emitted != Level::Error {
        return emitted;
    }
    // Another crate's account of a failure this one reports properly.
    if target.starts_with(UPSTREAM_NARRATOR) {
        return Level::Debug;
    }
    // OURS, AND A DIFFERENT QUESTION. A spent generation is expected after a reload - the send
    // ratchet is restored from a ledger kept outside the snapshot - and `messaging.rs` says in as
    // many words why `SecretReuseError` is deliberately NOT classified away at the throw: every
    // caller must still receive it as `DecryptErrorKind::SecretReuse` and acknowledge the frame.
    // Only the console severity is at stake here, and it must not be folded into the rule above:
    // that one declines to repeat a foreign line, this one demotes a line we chose to write.
    if message.contains("SecretReuseError") {
        return Level::Debug;
    }
    emitted
}
