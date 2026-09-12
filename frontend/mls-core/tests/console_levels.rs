//! Which ERROR lines a client console is entitled to show, and which are a duplicate.
//!
//! The rule this pins exists because two crates log at ERROR into one console and only one of them
//! knows what it is talking about. See `mls_core::logging` for the measurement and the argument.

use log::Level;
use mls_core::logging::console_level;

/// The exact strings openmls 0.8.1 emits at ERROR, copied from its source. If an upgrade changes
/// them, this test keeps passing - which is the whole point of keying on the target instead.
const OPENMLS_TARGET: &str = "openmls::framing::private_message_in";
const VALIDATION_TARGET: &str = "openmls::group::public_group::validation";
const OURS: &str = "mls_core::messaging";

#[test]
fn openmls_narrating_its_own_failure_is_not_an_error_here() {
    assert_eq!(
        console_level(Level::Error, OPENMLS_TARGET, "Sender data decryption error"),
        Level::Debug,
        "the six-per-idle-window line that started this: no group, no epoch, no frame"
    );
    assert_eq!(
        console_level(
            Level::Error,
            VALIDATION_TARGET,
            "Wrong Epoch: message.epoch() 1 > 10 self.group_context().epoch()"
        ),
        Level::Debug
    );
    assert_eq!(
        console_level(
            Level::Error,
            OPENMLS_TARGET,
            "  Ciphertext decryption error"
        ),
        Level::Debug,
        "the rule is about the emitter, so a line nobody has met yet is covered too"
    );
}

#[test]
fn our_own_report_of_the_same_frame_keeps_its_level() {
    // This is the line the upstream one duplicates, and it is the one worth reading: it names the
    // group, both epochs and the marker every consumer keys on. Demoting the foreign line must
    // never reach it.
    let ours = "MLS decryption failed at exactly its own epoch, so no redelivery can help: \
                group=abc msg_epoch=4 group_epoch=4 err=ValidationError(UnableToDecrypt(AeadError))";
    assert_eq!(console_level(Level::Error, OURS, ours), Level::Error);
}

#[test]
fn a_crate_merely_named_like_the_narrator_is_not_the_narrator() {
    // `starts_with` on a module path, not a substring search anywhere in the text: a line of ours
    // that quotes openmls prose must keep its level.
    assert_eq!(
        console_level(
            Level::Error,
            OURS,
            "openmls refused the commit: Wrong Epoch"
        ),
        Level::Error
    );
}

#[test]
fn a_spent_generation_is_demoted_by_its_marker_and_only_at_error() {
    // Ours, expected after a reload, repaired by the send-ratchet ledger - and still REPORTED as
    // `DecryptErrorKind::SecretReuse` to every caller. Only the console severity moves.
    let reuse = "Process error: same-epoch refusal SecretTreeError(SecretReuseError) \
                 [msg_epoch=4, group_epoch=4]";
    assert_eq!(console_level(Level::Error, OURS, reuse), Level::Debug);
    assert_eq!(console_level(Level::Warn, OURS, reuse), Level::Warn);
}

#[test]
fn nothing_below_error_is_touched_whoever_wrote_it() {
    for level in [Level::Warn, Level::Info, Level::Debug, Level::Trace] {
        assert_eq!(console_level(level, OPENMLS_TARGET, "anything"), level);
        assert_eq!(console_level(level, OURS, "anything"), level);
    }
}
