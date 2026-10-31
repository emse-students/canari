//! WHETHER THE PAGE RINGS AN INCOMING CALL ITSELF - the one fact the native ring needs to know when
//! the app is open.
//!
//! A call reaches an open app twice: the server's `call_ring` push (FCM on Android, a VoIP push or
//! FCM on iOS), and the caller's MLS `call_invite`, a TRANSPORT frame the server hands only to a
//! device whose gateway socket is open when it is sent (`TRANSPORT_SKIPPED_OFFLINE`). The page rings
//! from the invite; the native ring from the push. So the page rings a call exactly when it holds
//! the gateway socket, and the native ring must cover exactly the rest.
//!
//! **THE APP BEING IN THE FOREGROUND DOES NOT SAY THE PAGE RINGS.** At the PIN gate the page holds no
//! socket (it opens only after the unlock), so the invite is skipped and nothing rings - while the
//! native side dropped the push because the app was in front (Mi 9T, 1.5.2-alpha.3, 2026-10-31).
//! Nor does a loaded MLS manager (`concurrency::live_manager_in_process`): it answers whether there
//! is memory to protect, and outlives its page - a document reloaded over a warm manager draws the
//! PIN gate with the manager still loaded (same reading, 09:53:25).
//!
//! The page states the fact where it is known, at the one seam that holds its socket
//! (`TauriMlsService.ws`), through [`set_page_gateway_socket`]. A new document holds no socket at
//! all, so the statements of the previous one are void the moment a document starts loading
//! ([`forget_on_page_load`]), whether or not that page could still say so.
//!
//! **A SET OF HOLDERS, NEVER ONE BOOLEAN.** Each `TauriMlsService` instance states its own socket
//! under its own holder id: two instances that overlap (an account switch builds the next service
//! before the last one has let go) would otherwise let the first one's `false` erase the second
//! one's `true`. The page rings while ANY holder holds a socket.
//!
//! A page that dies with its web content process (iOS) is replaced by a reload, which starts a
//! document too; the termination handler clears the set first all the same
//! ([`forget_on_web_content_terminated`]), so no moment exists in which a dead page is counted.

use std::collections::BTreeSet;
use std::sync::Mutex;

/// The holders that state an open gateway socket: the page rings an incoming call itself while
/// this is not empty.
fn holders() -> &'static Mutex<BTreeSet<String>> {
    static HOLDERS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    &HOLDERS
}

fn with_holders<T>(f: impl FnOnce(&mut BTreeSet<String>) -> T) -> T {
    let mut set = holders().lock().unwrap_or_else(|poisoned| {
        log::error!("[CALL_RING] the holder set was POISONED - taken anyway, it is a plain set");
        poisoned.into_inner()
    });
    f(&mut set)
}

/// Applies one statement (`None` clears every holder) and logs a change of the answer, never a
/// repeat.
fn record(holder: Option<&str>, held: bool, why: &str) {
    let (before, after, count) = with_holders(|set| {
        let before = !set.is_empty();
        match holder {
            Some(h) if held => {
                set.insert(h.to_owned());
            }
            Some(h) => {
                set.remove(h);
            }
            None => set.clear(),
        }
        (before, !set.is_empty(), set.len())
    });
    if before != after {
        log::debug!(
            "[CALL_RING] {} ({why}; {count} holder(s))",
            if after {
                "the page holds the gateway socket - an incoming call rings in the page"
            } else {
                "the page holds no gateway socket - an incoming call rings natively"
            }
        );
    }
}

/// Whether the page rings an incoming call itself: read by the native ring (Android's
/// `CanariFirebaseMessagingService`, iOS's `canari_push.mm`) together with the app being in front.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn page_rings_in_app() -> bool {
    with_holders(|set| !set.is_empty())
}

/// A document started loading: it holds no socket yet, and every statement of the previous one
/// went with it - even when that page left without saying so (a renderer that died, a reload with
/// no `pagehide`).
pub(crate) fn forget_on_page_load() {
    record(None, false, "a document started loading");
}

/// The web content process died, and its page with it (WKWebView). Cleared here, before the reload
/// the handler asks for, so a ring arriving in between is rung natively.
#[cfg(any(target_os = "ios", target_os = "macos", test))]
pub(crate) fn forget_on_web_content_terminated() {
    record(None, false, "the web content process terminated");
}

/// The statement of one holder (one `TauriMlsService` instance), made by the setter of its gateway
/// socket: `held` is whether it holds one now. Synchronous, so the statements of one page are
/// applied in the order it made them.
#[tauri::command]
pub(crate) fn set_page_gateway_socket(holder: String, held: bool) {
    record(Some(&holder), held, "the page said so");
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test, because the set is process-wide and tests share the process.
    #[test]
    fn holders_state_it_and_a_new_document_or_a_dead_process_voids_it() {
        forget_on_page_load();
        assert!(
            !page_rings_in_app(),
            "no socket: the native ring covers the call"
        );
        set_page_gateway_socket("a".into(), true);
        assert!(page_rings_in_app(), "a socket: the native ring stands back");
        set_page_gateway_socket("a".into(), true);
        assert!(page_rings_in_app(), "a repeated statement changes nothing");

        // Overlapping holders: the first one letting go does not erase the second one's socket.
        set_page_gateway_socket("b".into(), true);
        set_page_gateway_socket("a".into(), false);
        assert!(page_rings_in_app(), "b still holds its socket");
        set_page_gateway_socket("b".into(), false);
        assert!(!page_rings_in_app(), "nobody holds one");

        set_page_gateway_socket("a".into(), true);
        forget_on_page_load();
        assert!(
            !page_rings_in_app(),
            "a new document holds no socket, whatever the previous one said"
        );

        set_page_gateway_socket("a".into(), true);
        forget_on_web_content_terminated();
        assert!(
            !page_rings_in_app(),
            "a dead web content process holds nothing"
        );
    }
}
