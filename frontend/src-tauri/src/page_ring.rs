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
//! all, so the statement of the previous one is void the moment a document starts loading
//! ([`forget_on_page_load`]), whether or not that page could still say so.

use std::sync::atomic::{AtomicBool, Ordering};

/// True while the page holds an open gateway socket - the page rings an incoming call itself.
fn holds_socket() -> &'static AtomicBool {
    static HOLDS: AtomicBool = AtomicBool::new(false);
    &HOLDS
}

/// Records the page's statement; logs a change, never a repeat.
fn record(held: bool, why: &str) {
    let before = holds_socket().swap(held, Ordering::SeqCst);
    if before != held {
        log::debug!(
            "[CALL_RING] {} ({why})",
            if held {
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
    holds_socket().load(Ordering::SeqCst)
}

/// A document started loading: it holds no socket yet, and the previous one's statement went with
/// it - even when that page left without saying so (a renderer that died, a reload with no
/// `pagehide`).
pub(crate) fn forget_on_page_load() {
    record(false, "a document started loading");
}

/// The page's statement, made by the setter of its gateway socket: `held` is whether it holds one
/// now. Synchronous, so two statements are applied in the order the page made them.
#[tauri::command]
pub(crate) fn set_page_gateway_socket(held: bool) {
    record(held, "the page said so");
}

#[cfg(test)]
mod tests {
    use super::*;

    // One test, because the fact is process-wide and tests share the process.
    #[test]
    fn the_page_states_it_and_a_new_document_voids_it() {
        set_page_gateway_socket(false);
        assert!(
            !page_rings_in_app(),
            "no socket: the native ring covers the call"
        );
        set_page_gateway_socket(true);
        assert!(
            page_rings_in_app(),
            "a socket: the page rings, the native ring stands back"
        );
        set_page_gateway_socket(true);
        assert!(page_rings_in_app(), "a repeated statement changes nothing");
        forget_on_page_load();
        assert!(
            !page_rings_in_app(),
            "a new document holds no socket, whatever the previous one said"
        );
    }
}
