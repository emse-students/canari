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
