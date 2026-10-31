//! Which ERROR lines a client console is entitled to show, and which are a duplicate.
//!
//! The rule this pins exists because two crates log at ERROR into one console and only one of them
//! knows what it is talking about. See `mls_core::logging` for the measurement and the argument.
//! The rule reads the EMITTER only, never the text: a rule keyed on prose drifts with every upstream
//! rewording, and the one text rule this file used to pin (a spent generation, demoted by its
//! marker) was deleted when that case was classified at the throw instead (#2466).

use log::Level;
use mls_core::logging::console_level;

/// The emitting module paths of openmls 0.9 lines that this crate re-reports with context.
const OPENMLS_TARGET: &str = "openmls::framing::private_message_in";
const VALIDATION_TARGET: &str = "openmls::group::public_group::validation";
const OURS: &str = "mls_core::messaging";

#[test]
fn openmls_narrating_its_own_failure_is_not_an_error_here() {
    // `Sender data decryption error`, `Wrong Epoch: ...`, `Ciphertext decryption error`: no group,
    // no epoch, no frame - and this crate reports the same event a line later with all three.
    assert_eq!(console_level(Level::Error, OPENMLS_TARGET), Level::Debug);
    assert_eq!(console_level(Level::Error, VALIDATION_TARGET), Level::Debug);
}

#[test]
fn our_own_errors_keep_their_level_whatever_they_say() {
    // `MLS decryption failed at exactly its own epoch ...` is the line the upstream one duplicates,
    // and a line of ours that quotes openmls prose, or carries `SecretReuseError`, is still ours:
    // nothing it says moves its level.
    assert_eq!(console_level(Level::Error, OURS), Level::Error);
}

#[test]
fn a_crate_merely_named_like_the_narrator_is_not_the_narrator() {
    // `starts_with` on a module path: a crate whose name merely contains the narrator's keeps its level.
    assert_eq!(
        console_level(Level::Error, "my_openmls_wrapper::x"),
        Level::Error
    );
}

#[test]
fn nothing_below_error_is_touched_whoever_wrote_it() {
    for level in [Level::Warn, Level::Info, Level::Debug, Level::Trace] {
        assert_eq!(console_level(level, OPENMLS_TARGET), level);
        assert_eq!(console_level(level, OURS), level);
    }
}
