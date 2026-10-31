//! WHETHER THE PAGE RINGS AN INCOMING CALL ITSELF - the facts the native ring needs to know when
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
//! **TWO FACTS, FOR TWO QUESTIONS.**
//! - *Will the page ring a call that arrives now?* - it holds the gateway socket
//!   ([`set_page_gateway_socket`], from the one setter of `TauriMlsService.ws`). Asked when a push
//!   arrives, before the invite: the socket is the only predictor there is.
//! - *Does the page ring THIS call?* - its `CallService` is `incoming` on that call id
//!   ([`set_page_ringing_call`], from the service's own state). Asked by the iPhone's handover before
//!   it ends an UNANSWERED CallKit ring: a page that holds a socket may still have missed that
//!   invite (skipped while the page sat at the PIN gate, before the unlock opened the socket), and
//!   ending the CallKit ring then ended the call's only ring (review of #2785).
//!
//! **A SET OF HOLDERS, NEVER ONE BOOLEAN.** Each `TauriMlsService` and each `CallService` instance
//! states its own fact under its own holder id: two instances that overlap (an account switch builds
//! the next service before the last one has let go) would otherwise let the first one's `false`
//! erase the second one's `true`.
//!
//! **EVERY STATEMENT CARRIES ITS DOCUMENT.** A new document holds no socket and rings no call, so
//! every statement of the previous one is void the moment a document starts loading
//! ([`forget_on_page_load`]), whether or not that page could still say so - and the document
//! generation moves on. A statement still in flight from the previous document (a late
//! `set_page_gateway_socket(.., true)` sent just before a navigation committed) names the old
//! generation and is ignored, rather than leaving a holder nobody will ever withdraw. A page learns
//! its generation once, from [`page_ring_document`], at its first statement.
//!
//! A page that dies with its web content process (iOS) is replaced by a reload, which starts a
//! document too; the termination handler clears the facts first all the same
//! ([`forget_on_web_content_terminated`]), so no moment exists in which a dead page is counted.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

/// What the current document stated, and which document that is.
#[derive(Debug, Default)]
struct PageRing {
    /// The current document's generation: moved on by every document start and web content death.
    document: u64,
    /// The holders that state an open gateway socket.
    sockets: BTreeSet<String>,
    /// The call each holder's `CallService` is ringing (`incoming` on it), by holder.
    ringing: BTreeMap<String, String>,
}

/// Whether a statement was applied, and if not why.
#[derive(Debug, PartialEq, Eq)]
enum Applied {
    /// Recorded; `changed` says whether the answer it feeds changed.
    Yes { changed: bool },
    /// Made by a previous document (`stated` is its generation), and ignored.
    StaleDocument { stated: u64 },
}

impl PageRing {
    const fn new() -> Self {
        Self {
            document: 0,
            sockets: BTreeSet::new(),
            ringing: BTreeMap::new(),
        }
    }

    /// The page will ring a call that arrives now: some holder holds the gateway socket.
    fn rings_in_app(&self) -> bool {
        !self.sockets.is_empty()
    }

    /// The page rings `call_id` right now: some holder's `CallService` is `incoming` on it.
    #[cfg(any(target_os = "ios", test))]
    fn rings_call(&self, call_id: &str) -> bool {
        !call_id.is_empty() && self.ringing.values().any(|c| c == call_id)
    }

    /// A new document (or none): every statement goes, and later ones of the old document are void.
    fn forget(&mut self) {
        self.document = self.document.wrapping_add(1);
        self.sockets.clear();
        self.ringing.clear();
    }

    fn state_socket(&mut self, document: u64, holder: &str, held: bool) -> Applied {
        if document != self.document {
            return Applied::StaleDocument { stated: document };
        }
        let before = self.rings_in_app();
        if held {
            self.sockets.insert(holder.to_owned());
        } else {
            self.sockets.remove(holder);
        }
        Applied::Yes {
            changed: before != self.rings_in_app(),
        }
    }

    fn state_ringing(&mut self, document: u64, holder: &str, call_id: Option<&str>) -> Applied {
        if document != self.document {
            return Applied::StaleDocument { stated: document };
        }
        let before = self.ringing.get(holder).cloned();
        match call_id.filter(|c| !c.is_empty()) {
            Some(c) => {
                self.ringing.insert(holder.to_owned(), c.to_owned());
            }
            None => {
                self.ringing.remove(holder);
            }
        }
        Applied::Yes {
            changed: before.as_deref() != self.ringing.get(holder).map(String::as_str),
        }
    }
}

static PAGE_RING: Mutex<PageRing> = Mutex::new(PageRing::new());

fn with_page_ring<T>(f: impl FnOnce(&mut PageRing) -> T) -> T {
    let mut ring = PAGE_RING.lock().unwrap_or_else(|poisoned| {
        log::error!(
            "[CALL_RING] the page ring facts were POISONED - taken anyway, they are plain sets"
        );
        poisoned.into_inner()
    });
    f(&mut ring)
}

/// Logs a statement of a previous document, which is ignored: the race it closes is real, so it is
/// said, once per statement.
fn log_stale(what: &str, holder: &str, stated: u64) {
    let current = with_page_ring(|r| r.document);
    log::info!(
        "[CALL_RING] {what} of {holder} names document {stated}, the page is document {current} - a \
         previous page's statement, ignored"
    );
}

/// Whether the page rings an incoming call itself: read by the native ring (Android's
/// `CanariFirebaseMessagingService`, iOS's `canari_push.mm`) together with the app being in front.
#[cfg(any(target_os = "android", target_os = "ios", test))]
pub(crate) fn page_rings_in_app() -> bool {
    with_page_ring(|r| r.rings_in_app())
}

/// Whether the page is ringing `call_id` itself right now (its `CallService` is `incoming` on it):
/// read by the iPhone's handover before it ends an unanswered CallKit ring of that call.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn page_rings_call(call_id: &str) -> bool {
    with_page_ring(|r| r.rings_call(call_id))
}

fn forget(why: &str) {
    let (had_socket, had_ringing, document) = with_page_ring(|r| {
        let had = (r.rings_in_app(), !r.ringing.is_empty());
        r.forget();
        (had.0, had.1, r.document)
    });
    if had_socket || had_ringing {
        log::debug!(
            "[CALL_RING] {why}: the page holds no gateway socket and rings no call (document \
             {document}) - an incoming call rings natively"
        );
    }
}

/// A document started loading: it holds no socket and rings no call yet, and every statement of the
/// previous one went with it - even when that page left without saying so (a renderer that died, a
/// reload with no `pagehide`).
pub(crate) fn forget_on_page_load() {
    forget("a document started loading");
}

/// The web content process died, and its page with it (WKWebView). Cleared here, before the reload
/// the handler asks for, so a ring arriving in between is rung natively.
#[cfg(any(target_os = "ios", target_os = "macos", test))]
pub(crate) fn forget_on_web_content_terminated() {
    forget("the web content process terminated");
}

/// The generation of the current document, which the page names in every statement it makes, so a
/// statement still in flight across a navigation is told apart from one of the new page.
#[tauri::command]
pub(crate) fn page_ring_document() -> u64 {
    with_page_ring(|r| r.document)
}

/// The statement of one holder (one `TauriMlsService` instance), made by the setter of its gateway
/// socket: `held` is whether it holds one now. Synchronous, so the statements of one page are
/// applied in the order it made them.
#[tauri::command]
pub(crate) fn set_page_gateway_socket(document: u64, holder: String, held: bool) {
    match with_page_ring(|r| r.state_socket(document, &holder, held)) {
        Applied::Yes { changed: false } => {}
        Applied::Yes { changed: true } => log::debug!(
            "[CALL_RING] {} ({holder} said so)",
            if held {
                "the page holds the gateway socket - an incoming call rings in the page"
            } else {
                "the page holds no gateway socket - an incoming call rings natively"
            }
        ),
        Applied::StaleDocument { stated } => log_stale("a socket statement", &holder, stated),
    }
}

/// The statement of one holder (one `CallService` instance): `call_id` is the call it rings now
/// (`incoming` on it), `None` when it rings none.
#[tauri::command]
pub(crate) fn set_page_ringing_call(document: u64, holder: String, call_id: Option<String>) {
    match with_page_ring(|r| r.state_ringing(document, &holder, call_id.as_deref())) {
        Applied::Yes { changed: false } => {}
        Applied::Yes { changed: true } => {
            log::debug!(
                "[CALL_RING] {holder} {}",
                match &call_id {
                    Some(c) => format!("rings call={c} in the page"),
                    None => "rings no call in the page".to_owned(),
                }
            );
            #[cfg(any(target_os = "ios", test))]
            if let Some(c) = call_id.as_deref().filter(|c| !c.is_empty()) {
                tell_page_started_ringing(c);
            }
        }
        Applied::StaleDocument { stated } => log_stale("a ringing statement", &holder, stated),
    }
}

/// The native function told that the page started ringing a call: on iOS, `canari_push.mm`'s
/// `CanariPageStartedRinging`, which ends that call's UNANSWERED CallKit ring when the app is active.
/// Without it, a call rung by CallKit (the page had no socket) and then by the page (the unlock came
/// in time for the invite) rang twice while the app was active: the handover runs only on an
/// activation, and an app already active sees none. The id is valid for the call only.
///
/// REGISTERED, NEVER LINKED: this crate is linked into the notification extension too, where
/// `canari_push.mm` is not, so naming its symbol here would break that link (`native_cache.rs`).
#[cfg(any(target_os = "ios", test))]
pub(crate) type PageRingingListener = extern "C" fn(call_id: *const std::os::raw::c_char);

#[cfg(any(target_os = "ios", test))]
static PAGE_RINGING_LISTENER: Mutex<Option<PageRingingListener>> = Mutex::new(None);

/// Registers (or, with `None`, removes) the native listener of [`PageRingingListener`].
#[cfg(any(target_os = "ios", test))]
pub(crate) fn set_page_ringing_listener(listener: Option<PageRingingListener>) {
    *PAGE_RINGING_LISTENER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = listener;
    log::debug!(
        "[CALL_RING] page ringing listener {}",
        if listener.is_some() {
            "registered"
        } else {
            "removed"
        }
    );
}

/// Tells the native listener the page started ringing `call_id`, outside every lock of this module
/// (the listener only copies the id and queues the rest on the main queue).
#[cfg(any(target_os = "ios", test))]
fn tell_page_started_ringing(call_id: &str) {
    let listener = *PAGE_RINGING_LISTENER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Some(listener) = listener else {
        log::warn!(
            "[CALL_RING] the page rings call={call_id} and no native listener is registered - a \
             CallKit ring of it is judged at the next activation only"
        );
        return;
    };
    match std::ffi::CString::new(call_id) {
        Ok(c) => listener(c.as_ptr()),
        Err(e) => log::error!("[CALL_RING] call id {call_id:?} has a NUL byte, not told: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holders_state_the_socket_and_overlapping_ones_never_erase_each_other() {
        let mut r = PageRing::new();
        assert!(
            !r.rings_in_app(),
            "no socket: the native ring covers the call"
        );
        assert_eq!(r.state_socket(0, "a", true), Applied::Yes { changed: true });
        assert!(r.rings_in_app(), "a socket: the native ring stands back");
        assert_eq!(
            r.state_socket(0, "a", true),
            Applied::Yes { changed: false },
            "a repeated statement changes nothing"
        );
        r.state_socket(0, "b", true);
        assert_eq!(
            r.state_socket(0, "a", false),
            Applied::Yes { changed: false }
        );
        assert!(r.rings_in_app(), "b still holds its socket");
        assert_eq!(
            r.state_socket(0, "b", false),
            Applied::Yes { changed: true }
        );
        assert!(!r.rings_in_app(), "nobody holds one");
    }

    #[test]
    fn a_socket_is_not_a_ring_of_this_call() {
        let mut r = PageRing::new();
        r.state_socket(0, "mls-1", true);
        assert!(r.rings_in_app());
        assert!(
            !r.rings_call("call-1"),
            "a page holding a socket that skipped this invite does not ring it"
        );
        assert_eq!(
            r.state_ringing(0, "svc-1", Some("call-1")),
            Applied::Yes { changed: true }
        );
        assert!(r.rings_call("call-1"));
        assert!(!r.rings_call("call-2"), "only the call it rings");
        assert!(!r.rings_call(""), "no call id names no call");
        assert_eq!(
            r.state_ringing(0, "svc-1", Some("call-1")),
            Applied::Yes { changed: false }
        );
        // Two services overlap: one leaving `incoming` does not erase the other's ring.
        r.state_ringing(0, "svc-2", Some("call-1"));
        r.state_ringing(0, "svc-1", None);
        assert!(r.rings_call("call-1"), "the second service still rings it");
        r.state_ringing(0, "svc-2", Some(""));
        assert!(!r.rings_call("call-1"), "an empty call id is no call");
    }

    #[test]
    fn a_new_document_voids_every_statement_and_ignores_the_old_ones_in_flight() {
        let mut r = PageRing::new();
        r.state_socket(0, "mls-1", true);
        r.state_ringing(0, "call-1", Some("c"));
        r.forget();
        assert_eq!(r.document, 1);
        assert!(!r.rings_in_app(), "a new document holds no socket");
        assert!(!r.rings_call("c"), "and rings no call");

        // The previous document's IPC, in flight across the navigation commit, lands now.
        assert_eq!(
            r.state_socket(0, "mls-1", true),
            Applied::StaleDocument { stated: 0 }
        );
        assert_eq!(
            r.state_ringing(0, "call-1", Some("c")),
            Applied::StaleDocument { stated: 0 }
        );
        assert!(!r.rings_in_app(), "no stale holder is left behind");
        assert!(!r.rings_call("c"));

        // The new document's own statements count.
        assert_eq!(
            r.state_socket(1, "mls-1", true),
            Applied::Yes { changed: true }
        );
        assert!(r.rings_in_app());
    }

    #[test]
    fn the_generation_wraps_rather_than_panics() {
        let mut r = PageRing::new();
        r.document = u64::MAX;
        r.forget();
        assert_eq!(r.document, 0);
    }

    // The process-wide wrappers, in ONE test: the state is shared by every test of the process.
    #[test]
    fn the_commands_and_the_page_load_drive_the_process_wide_facts() {
        forget_on_page_load();
        let doc = page_ring_document();
        assert!(!page_rings_in_app());
        set_page_gateway_socket(doc, "a".into(), true);
        set_page_ringing_call(doc, "s".into(), Some("call-9".into()));
        assert!(page_rings_in_app());
        assert!(page_rings_call("call-9"));

        forget_on_page_load();
        assert_ne!(
            page_ring_document(),
            doc,
            "a new document is a new generation"
        );
        set_page_gateway_socket(doc, "a".into(), true);
        assert!(
            !page_rings_in_app(),
            "the old document's late statement is ignored"
        );

        let doc = page_ring_document();
        set_page_gateway_socket(doc, "a".into(), true);
        forget_on_web_content_terminated();
        assert!(
            !page_rings_in_app(),
            "a dead web content process holds nothing"
        );
        assert!(!page_rings_call("call-9"));

        // The native listener hears of a call the page STARTS ringing - once, never a withdrawal, a
        // repeat or a previous document's statement.
        set_page_ringing_listener(Some(record_told));
        let doc = page_ring_document();
        set_page_ringing_call(doc, "s".into(), Some("call-10".into()));
        set_page_ringing_call(doc, "s".into(), Some("call-10".into()));
        set_page_ringing_call(doc, "s".into(), None);
        set_page_ringing_call(doc.wrapping_sub(1), "s".into(), Some("call-11".into()));
        set_page_ringing_call(doc, "s".into(), Some(String::new()));
        set_page_ringing_call(doc, "s".into(), Some("call-12".into()));
        set_page_ringing_listener(None);
        set_page_ringing_call(doc, "s".into(), Some("call-13".into()));
        assert_eq!(
            *TOLD.lock().unwrap(),
            vec!["call-10".to_owned(), "call-12".to_owned()]
        );
    }

    static TOLD: Mutex<Vec<String>> = Mutex::new(Vec::new());

    extern "C" fn record_told(call_id: *const std::os::raw::c_char) {
        // SAFETY: the listener contract - a valid NUL-terminated string for the call's duration.
        let id = unsafe { std::ffi::CStr::from_ptr(call_id) };
        TOLD.lock().unwrap().push(id.to_string_lossy().into_owned());
    }
}
