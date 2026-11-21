//! `notification_delivery_state` - what the OS lets this install's notifications do, readable by the
//! page through ONE typed command (2026-11-21).
//!
//! WHY A FILE AND NOT A CALL. The native side owns the facts (`NotificationManagerCompat`, the
//! channels, `PowerManager` on Android; `UNUserNotificationCenter` on iOS) and the page reads them
//! through Rust, which has no handle on either. So the native side writes one JSON snapshot into the
//! app data directory at every launch and every return to the foreground - the only moments the
//! answer can have changed, since a switch is flipped in the system settings, which leaves the app -
//! and this command reads it, the pattern `get_fcm_token` and `get_voip_token` already use.
//!
//! READ-ONLY, NO PROMPT: nothing here asks the OS for anything. A missing, unreadable or malformed
//! snapshot answers `None` - UNKNOWN, never "granted" - and says why at WARN, since a native writer
//! that never ran is a defect to find. Two consumers: the `register-device` report
//! (`notificationReport.ts`) and the in-app banner that will read the same shape.
//!
//! The file name and the keys are shared with `NotificationDeliveryState.kt` and `canari_ios.mm` -
//! change all three together; the shape is pinned by the tests below.

#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri::Manager;

/// The snapshot the native side writes. Shared with the two native writers.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const NOTIFICATION_STATE_FILE: &str = "notification_delivery_state.json";

/// The importance of the two channels a missing notification is read from, by name: `none`, `min`,
/// `low`, `default`, `high`, `unspecified`, or `absent` for a channel the OS does not hold.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Clone)]
pub(crate) struct ChannelImportances {
    pub messages: String,
    pub posts: String,
}

/// Android: the facts a missing notification is read from.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AndroidDeliveryState {
    /// `NotificationManagerCompat.areNotificationsEnabled()`: false when the permission is denied OR
    /// the app's notifications are switched off in the system settings.
    pub notifications_enabled: bool,
    /// `POST_NOTIFICATIONS` granted; always true below Android 13, where no such permission exists.
    pub post_notifications_granted: bool,
    pub channels: ChannelImportances,
    /// `PowerManager.isIgnoringBatteryOptimizations` - true means the app is EXEMPT from Doze limits.
    pub is_ignoring_battery_optimizations: bool,
    /// `Build.MANUFACTURER`, as the OS states it (a maker's autostart rules differ).
    pub manufacturer: String,
}

/// iOS: the facts a missing notification is read from.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IosDeliveryState {
    /// `UNAuthorizationStatus`: `not-determined`, `denied`, `granted`, `provisional`, `ephemeral`.
    pub authorization: String,
    /// `UNNotificationSetting` of each: `enabled`, `disabled`, `not-supported`.
    pub alert: String,
    pub sound: String,
    pub badge: String,
    /// `timeSensitiveSetting`, the same three terms; `not-supported` below iOS 15.
    pub time_sensitive: String,
}

/// What the command answers: the platform's block, tagged so the page never guesses which it holds.
#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Clone)]
#[serde(tag = "platform", rename_all = "camelCase")]
pub(crate) enum NotificationDeliveryState {
    Android(AndroidDeliveryState),
    Ios(IosDeliveryState),
}

/// Parses a snapshot. An error names the reason; it never answers a default.
pub(crate) fn parse_delivery_state(raw: &str) -> Result<NotificationDeliveryState, String> {
    serde_json::from_str(raw).map_err(|e| format!("snapshot unreadable: {e}"))
}

/// Reads and parses the snapshot in `data_dir`; `Ok(None)` when no writer ran yet.
#[cfg_attr(
    not(any(test, target_os = "android", target_os = "ios")),
    allow(dead_code)
)]
pub(crate) fn read_delivery_state(
    data_dir: &std::path::Path,
) -> Result<Option<NotificationDeliveryState>, String> {
    match std::fs::read_to_string(data_dir.join(NOTIFICATION_STATE_FILE)) {
        Ok(raw) => parse_delivery_state(&raw).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("snapshot not read: {e}")),
    }
}

/// The page's one door onto the OS notification state. Read-only, no prompt; `None` is unknown.
#[tauri::command]
pub(crate) fn notification_delivery_state(
    app: tauri::AppHandle,
) -> Option<NotificationDeliveryState> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let data_dir = match app.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                log::warn!("[NotifState] app_data_dir() failed: {e}");
                return None;
            }
        };
        match read_delivery_state(&data_dir) {
            Ok(Some(state)) => Some(state),
            Ok(None) => {
                log::warn!("[NotifState] no snapshot yet - the native writer has not run");
                None
            }
            Err(e) => {
                log::warn!("[NotifState] {e}");
                None
            }
        }
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANDROID: &str = r#"{"platform":"android","notificationsEnabled":true,
        "postNotificationsGranted":true,"channels":{"messages":"high","posts":"default"},
        "isIgnoringBatteryOptimizations":false,"manufacturer":"Xiaomi"}"#;
    const IOS: &str = r#"{"platform":"ios","authorization":"granted","alert":"enabled",
        "sound":"enabled","badge":"disabled","timeSensitive":"not-supported"}"#;

    #[test]
    fn the_android_snapshot_has_exactly_the_shape_the_page_reads() {
        let parsed = parse_delivery_state(ANDROID).unwrap();
        assert_eq!(
            parsed,
            NotificationDeliveryState::Android(AndroidDeliveryState {
                notifications_enabled: true,
                post_notifications_granted: true,
                channels: ChannelImportances {
                    messages: "high".into(),
                    posts: "default".into()
                },
                is_ignoring_battery_optimizations: false,
                manufacturer: "Xiaomi".into(),
            })
        );
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            back,
            serde_json::from_str::<serde_json::Value>(ANDROID).unwrap()
        );
    }

    #[test]
    fn the_ios_snapshot_has_exactly_the_shape_the_page_reads() {
        let parsed = parse_delivery_state(IOS).unwrap();
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            back,
            serde_json::from_str::<serde_json::Value>(IOS).unwrap()
        );
        assert!(matches!(parsed, NotificationDeliveryState::Ios(_)));
    }

    #[test]
    fn a_snapshot_missing_a_field_is_unreadable_never_defaulted() {
        let partial = r#"{"platform":"android","notificationsEnabled":true}"#;
        assert!(parse_delivery_state(partial).is_err());
        assert!(parse_delivery_state(r#"{"platform":"windows"}"#).is_err());
        assert!(parse_delivery_state("").is_err());
    }

    #[test]
    fn no_file_is_unknown_and_a_written_one_is_read() {
        let dir = std::env::temp_dir().join(format!("canari_notif_state_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_delivery_state(&dir).unwrap(), None);
        std::fs::write(dir.join(NOTIFICATION_STATE_FILE), IOS).unwrap();
        assert!(matches!(
            read_delivery_state(&dir).unwrap(),
            Some(NotificationDeliveryState::Ios(_))
        ));
        std::fs::write(dir.join(NOTIFICATION_STATE_FILE), "{").unwrap();
        assert!(read_delivery_state(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
