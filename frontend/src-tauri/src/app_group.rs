//! The `group.fr.emse.canari` App Group container: the only storage the iOS app shares with its
//! two extensions - the Notification Service Extension and the Share Extension - each of which has
//! a data container of its own and can read neither the app's `app_data_dir` nor its app-only
//! Keychain items.
//!
//! iOS only. Its callers: `store_push_secret`, which writes the NSE's copy of the push secret at the
//! moment the server rotates it; the bench command (`commands::bench`); and the share import
//! (`commands::app_group_share`, and `advance_share_epoch` for the group's copy of the epoch), which
//! carries what the Share Extension left there into the app's own directories.

use std::path::PathBuf;

/// The App Group container's path, asked of Foundation - the only API that knows it.
///
/// Through the Objective-C runtime rather than a function of ours in `canari_push.mm`: `libapp.a`
/// is linked into the notification extension too, and a Rust reference to an app-only symbol would
/// leave the extension's link with an undefined one. Foundation is linked into both.
pub(crate) fn app_group_dir() -> Result<PathBuf, String> {
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
/// Through the Objective-C runtime like [`app_group_dir`], for the same reason: `libapp.a` is
/// linked into the notification extension, which has no `UIApplication` to ask - and never runs
/// the foreground commands that take this, so a missing application is said and nothing is held.
pub(crate) struct BackgroundTime {
    /// The task identifier, 0 (`UIBackgroundTaskInvalid`) once ended - shared with the expiration
    /// handler, so exactly one of the two ends it.
    id: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// `UIApplication.sharedApplication`, as an address: it lives as long as the process.
    app: usize,
}

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
        let str_class = AnyClass::get(c"NSString")?;
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
                let handler = block2::RcBlock::new(move || {
                    let task = expired_id.swap(0, Ordering::SeqCst);
                    if task != 0 {
                        log::error!(
                            "[AppGroup] background time EXPIRED during a locked App Group edit - ended"
                        );
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
                id.store(task, Ordering::SeqCst);
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
        let task = self.id.swap(0, Ordering::SeqCst);
        if task != 0 {
            let app = self.app as *mut objc2::runtime::AnyObject;
            // SAFETY: the application object lives for the whole process; `task` came from it.
            unsafe {
                let _: () = objc2::msg_send![app, endBackgroundTask: task];
            }
        }
    }
}
