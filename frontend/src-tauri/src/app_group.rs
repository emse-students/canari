//! The `group.fr.emse.canari` App Group container: the only storage the iOS app shares with its
//! two extensions - the Notification Service Extension and the Share Extension - each of which has
//! a data container of its own and can read neither the app's `app_data_dir` nor its app-only
//! Keychain items.
//!
//! **Everything shared lives in the container's STORE directory, never at its root** (1.7.2): the
//! root refuses the backup flag, a directory of ours takes it (`backup_exclusion`, module doc).
//! [`app_group_dir`] answers the store, and is the one resolver of this crate; the app's
//! Objective-C and the notification extension reach it through `canari_app_group_store_dir`
//! (`mobile/ios_ffi.rs`), the share extension, which links no Rust, mirrors it
//! (`ShareCapture.storeDir`).
//!
//! iOS only. Its callers: `store_push_secret`, which writes the NSE's copy of the push secret at the
//! moment the server rotates it; the bench command (`commands::bench`); the share import
//! (`commands::app_group_share`, and `advance_share_epoch` for the group's copy of the epoch), which
//! carries what the Share Extension left there into the app's own directories; and every mirror the
//! extension reads.

use std::path::PathBuf;

/// The App Group container's ROOT, asked of Foundation - the only API that knows it. Nothing of ours
/// is written there: [`app_group_dir`] is the directory to use; this is for the launch verdict,
/// which reads what the root still holds (`backup_exclusion::root_state`).
///
/// Through the Objective-C runtime rather than a function of ours in `canari_push.mm`: `libapp.a`
/// is linked into the notification extension too, and a Rust reference to an app-only symbol would
/// leave the extension's link with an undefined one. Foundation is linked into both.
pub(crate) fn app_group_container() -> Result<PathBuf, String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use std::ffi::{c_char, CStr};

    log::debug!("[AppGroup] resolving the group.fr.emse.canari container");
    objc2::rc::autoreleasepool(|_| {
        let fm_class = AnyClass::get(c"NSFileManager").ok_or("NSFileManager is not loaded")?;
        let str_class = AnyClass::get(c"NSString").ok_or("NSString is not loaded")?;
        // SAFETY: plain Foundation messages with the argument and return types their headers
        // declare; every object returned is autoreleased into the pool around this block.
        unsafe {
            let fm: *mut AnyObject = msg_send![fm_class, defaultManager];
            let ident: *mut AnyObject =
                msg_send![str_class, stringWithUTF8String: c"group.fr.emse.canari".as_ptr()];
            let url: *mut AnyObject =
                msg_send![fm, containerURLForSecurityApplicationGroupIdentifier: ident];
            if url.is_null() {
                return Err("the App Group container is unavailable (entitlement missing?)".into());
            }
            let path: *mut AnyObject = msg_send![url, path];
            let utf8: *const c_char = msg_send![path, UTF8String];
            if utf8.is_null() {
                return Err("the App Group URL has no path".into());
            }
            Ok(PathBuf::from(
                CStr::from_ptr(utf8).to_string_lossy().into_owned(),
            ))
        }
    })
}

/// How this process opened the store, once it has (`backup_exclusion::StoreOpening`).
static OPENING: std::sync::OnceLock<crate::backup_exclusion::StoreOpening> =
    std::sync::OnceLock::new();

/// The App Group directory every file shared with the extensions lives in: the container's store
/// (`backup_exclusion::APP_GROUP_STORE`), excluded from backups. The FIRST call of a process opens
/// it (`backup_exclusion::open_store`: created when absent, flagged, the root's entries of ours
/// moved into it) - before that call returns, so nothing of this process ever writes where an older
/// build wrote; later calls answer the remembered path. An unavailable container, or a store that
/// cannot be created, is not remembered: the next call asks again. A refused flag or move is NOT
/// an error here - the store is answered, and the opening keeps what went wrong ([`store_opening`]).
pub(crate) fn app_group_dir() -> Result<PathBuf, String> {
    if let Some(opening) = OPENING.get() {
        return Ok(opening.path.clone());
    }
    let root = app_group_container()?;
    // The move holds a `flock` on the store in the shared container: an app suspended holding it is
    // killed (`0xdead10cc`), so the move asks for background time as the seed edit does. `None` in
    // the notification extension, which has no application and is never suspended mid-call.
    let _background = BackgroundTime::begin(c"canari-app-group-move");
    let opening = crate::backup_exclusion::open_store(&root, |store| {
        crate::native_cache::ios_exclude_from_backup(store)
    })
    .map_err(|e| format!("the App Group store could not be created: {e}"))?;
    Ok(OPENING.get_or_init(|| opening).path.clone())
}

/// How this process's first [`app_group_dir`] went - the flag and the move - or `None` before it.
/// Read by the launch verdict and by `canari_app_group_store_report`, because the move may have run
/// before any logger existed (the native bootstrap, the notification extension).
pub(crate) fn store_opening() -> Option<&'static crate::backup_exclusion::StoreOpening> {
    OPENING.get()
}

/// Background time the app holds while it edits a file of the App Group under a lock - ended when
/// dropped.
///
/// **An app suspended while it holds a lock on a file of a shared container is killed by the
/// system (`0xdead10cc`).** Since channel-encryption section 27 every foreground edit of the seed
/// mirror takes `graine_seeds.lock` IN the App Group, and an edit can start in the seconds after
/// the app leaves the screen (a frame the page absorbs on its way out). The assertion asks for the
/// time to finish; the edit holds the lock for milliseconds, so its expiry is never the expected
/// path - if it comes, it is said at ERROR and the assertion ended, as the API requires.
///
/// Through the Objective-C runtime like [`app_group_container`], for the same reason: `libapp.a` is
/// linked into the notification extension, which has no `UIApplication` to ask - and never runs
/// the foreground commands that take this, so a missing application is said and nothing is held.
pub(crate) struct BackgroundTime {
    /// The task identifier, shared with the expiration handler so exactly one of the two ends it:
    /// 0 before `begin` stored it, [`EXPIRED`] once ended (by either side).
    id: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// `UIApplication.sharedApplication`, as an address: it lives as long as the process.
    app: usize,
}

/// The value a [`BackgroundTime`]'s slot takes once its task is ended - never a task identifier
/// UIKit hands out, and not 0, which means "not stored yet".
const EXPIRED: usize = usize::MAX;

impl BackgroundTime {
    /// Begins the assertion, named for the system's diagnostics. `None` (said) when there is no
    /// application or the system grants none: the edit goes on, as it did before the assertion.
    pub(crate) fn begin(name: &std::ffi::CStr) -> Option<Self> {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let Some(app_class) = AnyClass::get(c"UIApplication") else {
            log::error!("[AppGroup] background time: UIApplication is not loaded");
            return None;
        };
        let Some(str_class) = AnyClass::get(c"NSString") else {
            log::error!("[AppGroup] background time: NSString is not loaded");
            return None;
        };
        objc2::rc::autoreleasepool(|_| {
            // SAFETY: plain UIKit/Foundation messages with the argument and return types their
            // headers declare (`UIBackgroundTaskIdentifier` is an `NSUInteger`); the block is
            // copied by UIKit, and every object returned is autoreleased into this pool.
            unsafe {
                let app: *mut AnyObject = msg_send![app_class, sharedApplication];
                if app.is_null() {
                    log::error!("[AppGroup] background time: no shared application");
                    return None;
                }
                let label: *mut AnyObject =
                    msg_send![str_class, stringWithUTF8String: name.as_ptr()];
                let id = Arc::new(AtomicUsize::new(0));
                let (expired_id, app_addr) = (Arc::clone(&id), app as usize);
                // The handler may run before `begin` has stored the task: it then marks the slot
                // EXPIRED, and the compare-exchange below sees it and ends the task itself.
                let handler = block2::RcBlock::new(move || {
                    let task = expired_id.swap(EXPIRED, Ordering::SeqCst);
                    log::error!(
                        "[AppGroup] background time EXPIRED during a locked App Group edit - ended"
                    );
                    if task != 0 && task != EXPIRED {
                        let app = app_addr as *mut AnyObject;
                        let _: () = msg_send![app, endBackgroundTask: task];
                    }
                });
                let task: usize = msg_send![
                    app,
                    beginBackgroundTaskWithName: label,
                    expirationHandler: &*handler
                ];
                if task == 0 {
                    log::warn!("[AppGroup] background time: the system granted none");
                    return None;
                }
                if id
                    .compare_exchange(0, task, Ordering::SeqCst, Ordering::SeqCst)
                    .is_err()
                {
                    // Expired before it was stored: the handler could not end it, so it ends here.
                    let _: () = msg_send![app, endBackgroundTask: task];
                    return None;
                }
                Some(Self {
                    id,
                    app: app as usize,
                })
            }
        })
    }
}

impl Drop for BackgroundTime {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;
        let task = self.id.swap(EXPIRED, Ordering::SeqCst);
        if task != 0 && task != EXPIRED {
            let app = self.app as *mut objc2::runtime::AnyObject;
            // SAFETY: the application object lives for the whole process; `task` came from it.
            unsafe {
                let _: () = objc2::msg_send![app, endBackgroundTask: task];
            }
        }
    }
}
