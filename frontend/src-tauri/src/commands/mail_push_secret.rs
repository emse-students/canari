//! The school mailbox's password, for the iOS notification extension (mail lot 5,
//! docs/wiki/mail-client-transport.md#as-built---lot-5).
//!
//! An empty mail push wakes the extension (`NotificationService.swift`, `MailPushFetch`), which signs
//! in to Partage itself to show the new mail's sender and subject. It has no page and no device key,
//! so it reads ONE Keychain item, shared with the app through the App Group access group exactly like
//! the device key's background copy (`mls_bg_key_<alias>`): `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`,
//! never synchronised, never in a backup. Its value is the JSON `{userId, account, password}`: the
//! extension shows a mail only for the account it names, and only when the cursor file of that
//! account exists.
//!
//! The page writes it (`mailPushSecret.ts`) only while "remember", the account's notifications and
//! `mail_push = cloudflare` all hold, and erases it through ONE erase every forget path reaches. Off
//! iOS both commands do nothing: the item exists nowhere else.

/// The Keychain service and account of the item. `NotificationService.swift` reads the same two
/// (`MailPushFetch.keychainService` / `keychainAccount`); `mailPushSecret.test.ts` holds them together.
#[cfg(any(target_os = "ios", test))]
pub(crate) const KEYCHAIN_SERVICE: &str = "fr.emse.canari";
/// See [`KEYCHAIN_SERVICE`].
#[cfg(any(target_os = "ios", test))]
pub(crate) const KEYCHAIN_ACCOUNT: &str = "canari_mail_push_secret";
/// The App Group access group the extension shares (its entitlements name the same group).
#[cfg(target_os = "ios")]
const ACCESS_GROUP: &str = "group.fr.emse.canari";

/// The item's value: what the extension needs to sign in, and whose it is.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn secret_json(user_id: &str, account: &str, password: &str) -> Result<String, String> {
    if user_id.is_empty() || account.is_empty() || password.is_empty() {
        return Err("an empty field".into());
    }
    serde_json::to_string(&serde_json::json!({
        "userId": user_id,
        "account": account.to_lowercase(),
        "password": password,
    }))
    .map_err(|e| format!("serialise: {e}"))
}

#[cfg(target_os = "ios")]
fn options() -> security_framework::passwords::PasswordOptions {
    let mut options = security_framework::passwords::PasswordOptions::new_generic_password(
        KEYCHAIN_SERVICE,
        KEYCHAIN_ACCOUNT,
    );
    options.set_access_group(ACCESS_GROUP);
    options
}

/// `errSecItemNotFound` (Security/SecBase.h): the item is not there.
#[cfg(target_os = "ios")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Removes the item. Idempotent: an absent item is not an error.
#[cfg(target_os = "ios")]
pub(crate) fn erase() -> Result<(), String> {
    match security_framework::passwords::delete_generic_password_options(options()) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(e) => Err(format!("keychain delete status={}", e.code())),
    }
}

/// Off iOS there is no item to remove.
#[cfg(not(target_os = "ios"))]
pub(crate) fn erase() -> Result<(), String> {
    Ok(())
}

/// The page writes the extension's copy (deleted, then added: an update cannot change the access
/// attributes of an item an older build wrote).
#[tauri::command]
pub(crate) fn mail_push_secret_store(
    user_id: String,
    account: String,
    password: String,
) -> Result<(), String> {
    log::info!("[MailPushSecret] store");
    #[cfg(target_os = "ios")]
    {
        use security_framework::access_control::{ProtectionMode, SecAccessControl};
        let value = secret_json(&user_id, &account, &password)?;
        erase()?;
        let mut options = options();
        let access = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
            0,
        )
        .map_err(|e| format!("access control status={}", e.code()))?;
        options.set_access_control(access);
        options.set_access_synchronized(Some(false));
        security_framework::passwords::set_generic_password_options(value.as_bytes(), options)
            .map_err(|e| {
                log::warn!("[MailPushSecret] keychain add failed status={}", e.code());
                format!("keychain add status={}", e.code())
            })?;
        log::info!("[MailPushSecret] written");
        Ok(())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (user_id, account, password);
        log::debug!("[MailPushSecret] not iOS - nothing written");
        Ok(())
    }
}

/// The ONE erase of the extension's copy (every forget path of the page reaches it).
#[tauri::command]
pub(crate) fn mail_push_secret_erase() -> Result<(), String> {
    erase().inspect_err(|e| log::warn!("[MailPushSecret] not erased: {e}"))?;
    log::info!("[MailPushSecret] erased");
    Ok(())
}

/// Whether the item's value names `user_id` - or names nobody readable, which a forget erases too
/// (an item it cannot read is one no extension can use). An item naming ANOTHER account is kept: the
/// forget was for a device that holds someone else's mailbox by now.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn item_is_for(value: &[u8], user_id: &str) -> bool {
    match serde_json::from_slice::<serde_json::Value>(value) {
        Ok(v) => match v.get("userId").and_then(|u| u.as_str()) {
            Some(owner) => owner == user_id,
            None => true,
        },
        Err(_) => true,
    }
}

/// THE REMOTE FORGET ON iOS (mail lot 5, D6): the server's `mail-forget` push, handled by the app's
/// silent-frame hook (`canari_push.mm`, `CanariHandleBackgroundFrame`), erases what this install keeps
/// of `user_id`'s mailbox OUTSIDE the page - the Keychain item the extension reads (when it is that
/// account's) and the shared cursor in the App Group store. The page's own copy goes at the next
/// launch, through the sign-out every refused refresh reaches (`forgetMailPassword`).
///
/// Returns 0 when both are gone (or were never there), -1 when something could not be erased
/// (logged). Idempotent.
///
/// # Safety
/// `user_id` must be a valid NUL-terminated C string, or null (refused).
#[cfg(target_os = "ios")]
#[no_mangle]
pub unsafe extern "C" fn canari_mail_forget(user_id: *const std::os::raw::c_char) -> i32 {
    if user_id.is_null() {
        log::warn!("[MailPushSecret] remote forget without an account - refused");
        return -1;
    }
    let user_id = match std::ffi::CStr::from_ptr(user_id).to_str() {
        Ok(s) => s.to_owned(),
        Err(_) => {
            log::warn!("[MailPushSecret] remote forget with an unreadable account - refused");
            return -1;
        }
    };
    let mut status = 0;
    match security_framework::passwords::generic_password(options()) {
        Ok(value) if !item_is_for(&value, &user_id) => {
            log::info!("[MailPushSecret] remote forget: the item is another account's - kept");
        }
        Ok(_) => {
            if let Err(e) = erase() {
                log::warn!("[MailPushSecret] remote forget: the item was NOT erased: {e}");
                status = -1;
            } else {
                log::info!("[MailPushSecret] remote forget: the item is erased");
            }
        }
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => {
            log::info!("[MailPushSecret] remote forget: no item");
        }
        Err(e) => {
            log::warn!(
                "[MailPushSecret] remote forget: the item could not be read status={}",
                e.code()
            );
            status = -1;
        }
    }
    match crate::app_group::app_group_dir() {
        Ok(dir) => {
            if let Err(e) = super::mail_watch::forget(&dir, &user_id) {
                log::warn!("[MailPushSecret] remote forget: the cursor was NOT erased: {e}");
                status = -1;
            }
        }
        Err(e) => {
            log::warn!("[MailPushSecret] remote forget: the App Group store is unavailable: {e}");
            status = -1;
        }
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_value_names_its_account_and_refuses_an_empty_field() {
        let json = secret_json("u1", "Prenom.Nom@etu.emse.fr", "pw").unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["userId"], "u1");
        assert_eq!(parsed["account"], "prenom.nom@etu.emse.fr");
        assert_eq!(parsed["password"], "pw");
        assert!(secret_json("", "a@b", "pw").is_err());
        assert!(secret_json("u1", "a@b", "").is_err());
        assert_eq!(KEYCHAIN_ACCOUNT, "canari_mail_push_secret");
    }

    #[test]
    fn a_remote_forget_erases_only_its_own_account_item() {
        let mine = secret_json("u1", "a@b", "pw").unwrap();
        assert!(item_is_for(mine.as_bytes(), "u1"));
        assert!(!item_is_for(mine.as_bytes(), "u2"));
        assert!(item_is_for(b"not json", "u2"));
        assert!(item_is_for(b"{}", "u2"));
    }

    #[test]
    fn erasing_off_ios_is_a_no_op() {
        assert!(erase().is_ok());
        assert!(mail_push_secret_erase().is_ok());
    }
}
