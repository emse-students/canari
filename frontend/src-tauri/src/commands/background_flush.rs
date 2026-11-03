//! THE PAGE'S LAST WORK BEFORE iOS SUSPENDS IT, HELD OPEN BY A BACKGROUND TASK (2026-11-02).
//!
//! A read the user made inside the 2 s window before leaving the app is delivered when the app
//! leaves the screen (`readMarks.flush()` in `MainChatPage`), into the outbox, whose send is an
//! encrypt and a POST - and nothing held the process for it. iOS suspends an app seconds after it
//! leaves the screen, so that read reached the other devices only at the next open.
//!
//! The page asks for the hold FIRST ([`begin_background_flush`]), does the work, and ends it
//! ([`end_background_flush`]) with the outcome. The task is begun and ended by the native shell
//! (`canari_push.mm`, `CanariBeginLeaveFlush` / `CanariEndLeaveFlush`), which registers two
//! listeners here at setup - registered rather than linked, since this crate is also linked into the
//! notification extension (the quick reply's acknowledgement does the same). NO TIMER: the hold ends
//! when the page says so, or when iOS ends the background time, which the shell logs as an ERROR -
//! the mark then stays owed (durable, and mirrored) and leaves with the next drain.
//!
//! Every other platform registers nothing, so the commands answer "no hold" and do nothing.
//! docs/wiki/frontend/modules/chat.md, "Read state between devices".

use std::os::raw::c_char;
use std::sync::Mutex;

/// Begins a hold for `reason`; returns its id, 0 when iOS refused one (`UIBackgroundTaskInvalid`).
pub(crate) type BeginListener = extern "C" fn(reason: *const c_char) -> u64;
/// Ends the hold `id`, saying how the page's work `outcome` ended.
pub(crate) type EndListener = extern "C" fn(id: u64, outcome: *const c_char);

static LISTENERS: Mutex<Option<(BeginListener, EndListener)>> = Mutex::new(None);

/// Registers (or removes) the native shell's two listeners.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn set_background_flush_listeners(listeners: Option<(BeginListener, EndListener)>) {
    *LISTENERS.lock().unwrap_or_else(|p| p.into_inner()) = listeners;
    log::debug!(
        "[LEAVE_FLUSH] native listeners {}",
        if listeners.is_some() {
            "registered"
        } else {
            "removed"
        }
    );
}

fn listeners() -> Option<(BeginListener, EndListener)> {
    *LISTENERS.lock().unwrap_or_else(|p| p.into_inner())
}

/// `text` as a C string, or `None` (said) when it carries a NUL byte.
fn c_text(what: &str, text: &str) -> Option<std::ffi::CString> {
    match std::ffi::CString::new(text) {
        Ok(c) => Some(c),
        Err(e) => {
            log::error!(
                "[LEAVE_FLUSH] {what} ({} bytes) has a NUL byte: {e}",
                text.len()
            );
            None
        }
    }
}

/// Asks the shell for a hold. `None` where no shell listens (every platform but iOS), or when iOS
/// refused one - the work then runs unheld, as it always did, and the refusal is said.
pub(crate) fn begin(reason: &str) -> Option<u64> {
    let (begin, _) = listeners()?;
    let reason_c = c_text("reason", reason)?;
    let id = begin(reason_c.as_ptr());
    if id == 0 {
        log::warn!(
            "[LEAVE_FLUSH] iOS refused a background task for {reason} - the work runs unheld"
        );
        return None;
    }
    log::debug!("[LEAVE_FLUSH] hold {id} begun for {reason}");
    Some(id)
}

/// Ends hold `id`. False when nobody could be told - then iOS ends it at its own deadline.
pub(crate) fn end(id: u64, outcome: &str) -> bool {
    let Some((_, end)) = listeners() else {
        log::error!(
            "[LEAVE_FLUSH] hold {id} settled ({outcome}) and no native listener is registered"
        );
        return false;
    };
    let Some(outcome_c) = c_text("outcome", outcome) else {
        return false;
    };
    end(id, outcome_c.as_ptr());
    log::debug!("[LEAVE_FLUSH] hold {id} ended: {outcome}");
    true
}

/// The page is about to deliver what it owes before leaving the screen: hold the process for it.
/// Returns the hold's id for [`end_background_flush`], or `None` when there is no hold to end.
#[tauri::command]
pub(crate) fn begin_background_flush(reason: String) -> Option<u64> {
    begin(&reason)
}

/// The page's work is done (`outcome`: `sent`, `owed`, `failed`): end the hold it asked for.
#[tauri::command]
pub(crate) fn end_background_flush(hold: u64, outcome: String) {
    end(hold, &outcome);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The listeners are one process-wide slot: the tests that set it run one at a time.
    static SLOT: Mutex<()> = Mutex::new(());
    static ENDED: Mutex<Vec<(u64, String)>> = Mutex::new(Vec::new());

    extern "C" fn grant(_reason: *const c_char) -> u64 {
        42
    }
    extern "C" fn refuse(_reason: *const c_char) -> u64 {
        0
    }
    extern "C" fn record_end(id: u64, outcome: *const c_char) {
        let outcome = unsafe { std::ffi::CStr::from_ptr(outcome) }
            .to_string_lossy()
            .into_owned();
        ENDED.lock().unwrap().push((id, outcome));
    }

    #[test]
    fn no_shell_means_no_hold_and_nothing_to_end() {
        let _g = SLOT.lock().unwrap_or_else(|p| p.into_inner());
        set_background_flush_listeners(None);
        assert_eq!(begin("leave"), None);
        assert!(!end(7, "sent"));
    }

    #[test]
    fn a_granted_hold_is_ended_with_its_outcome() {
        let _g = SLOT.lock().unwrap_or_else(|p| p.into_inner());
        ENDED.lock().unwrap().clear();
        set_background_flush_listeners(Some((grant, record_end)));
        let id = begin("leave");
        assert_eq!(id, Some(42));
        assert!(end(42, "sent"));
        assert_eq!(*ENDED.lock().unwrap(), vec![(42, "sent".to_string())]);
        set_background_flush_listeners(None);
    }

    #[test]
    fn a_refused_hold_is_none_so_the_page_ends_nothing() {
        let _g = SLOT.lock().unwrap_or_else(|p| p.into_inner());
        set_background_flush_listeners(Some((refuse, record_end)));
        assert_eq!(begin("leave"), None);
        set_background_flush_listeners(None);
    }

    #[test]
    fn a_nul_byte_is_refused_before_the_shell_is_called() {
        let _g = SLOT.lock().unwrap_or_else(|p| p.into_inner());
        ENDED.lock().unwrap().clear();
        set_background_flush_listeners(Some((grant, record_end)));
        assert_eq!(begin("le\0ave"), None);
        assert!(!end(42, "se\0nt"));
        assert!(ENDED.lock().unwrap().is_empty());
        set_background_flush_listeners(None);
    }
}
