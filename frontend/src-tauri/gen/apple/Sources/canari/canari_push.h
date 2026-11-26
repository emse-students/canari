#pragma once

#ifdef __OBJC__
#import <Foundation/Foundation.h>

/// What a native log line says of an NSError: its domain and code, never its text. A
/// `localizedDescription` often quotes the file it failed on (a shared file's name, a path), and
/// NSLog redacts nothing (`nativeLogContent.test.ts`, docs/wiki/frontend/mobile.md).
static inline NSString *_Nonnull CanariErrorReason(NSError *_Nullable error) {
  if (error == nil) {
    return @"no error";
  }
  return [NSString stringWithFormat:@"%@ %ld", error.domain, (long)error.code];
}

/// Tauri `app_data_dir` (Application Support/fr.emse.canari) of the CALLING process.
FOUNDATION_EXPORT NSString *_Nullable CanariTauriDataDir(void);

/// Tauri `app_cache_dir` (Library/Caches/fr.emse.canari) of the CALLING process: where the copies of
/// a share into Canari are moved for `take_picked_file` to read.
FOUNDATION_EXPORT NSString *_Nullable CanariTauriCacheDir(void);

/// Reads the push secret. pending_push_secret.txt WINS over the Keychain when present -
/// it is newer by construction; see the implementation for why the reverse order 403s.
FOUNDATION_EXPORT NSString *_Nullable CanariRetrievePushSecret(void);

/// Installs the push handler (FCM delegate + UNUserNotificationCenter).
void CanariPushSetup(void);

/// Fetches the current FCM token and persists it, but ONLY once APNs has handed one over.
///
/// The precondition is the whole point. FIRMessaging cannot mint an FCM token before an APNs token
/// exists, and on iOS that token arrives asynchronously after `registerForRemoteNotifications` -
/// which cannot run until launch completes. So a fetch at bootstrap is guaranteed to fail, and this
/// is called from `didBecomeActive` instead, where the answer can be yes. Guarded on
/// `FIRMessaging.APNSToken` rather than on a delay: it either exists or the next activation asks
/// again. A no-op when Firebase is not linked.
void CanariSyncFcmTokenIfApnsReady(void);

/// On activation: retires the ring alerts the open app takes over and recomputes the badge. It removes NO conversation banner (owner, 2026-11-21).
void CanariPushCancelMessageNotifications(void);

/// Re-registers the message quick actions in the language currently mirrored in push_context.json,
/// and does nothing when that language has not moved. Call it when the app leaves the foreground:
/// that is the last moment before a notification can be seen, which is the only moment the titles
/// are read. Called by CanariPushSetup for the initial registration.
void CanariRefreshNotificationCategories(void);

/// Registers the BGProcessingTask handler (background MLS cleanup).
/// Must be called BEFORE launch completes (from canari_ios_bootstrap, before start_app).
void CanariRegisterBackgroundTasks(void);

/// Schedules a background cleanup window. Call it when entering the background.
void CanariScheduleBackgroundCleanupTask(void);

/// WP-XP-8: schedules an automatic background retry of the outbox drain (BGProcessingTask).
/// Called from CanariMaybeNotifyPendingSync when the opportunistic drain fails.
void CanariScheduleOutboxRetryTask(void);

/// The App Group directory every file shared with the extensions lives in: the container's STORE,
/// excluded from backups, never its root (`backup_exclusion.rs`); nil without the entitlement. The
/// ONE resolver of the app's Objective-C - a direct `containerURLForSecurityApplicationGroupIdentifier`
/// would write where no flag reaches.
FOUNDATION_EXPORT NSString *_Nullable CanariAppGroupPath(void);

/// Copies the push decrypt inputs (mls.bin, push_context.json, push_secret.txt) into the
/// `group.fr.emse.canari` App Group container for the Notification Service Extension. Call it on
/// both foreground/background transitions. NOT graine_seeds.json: the seed mirror lives in the App
/// Group already, written by the app and the extension alike (channel-encryption section 27). The extension's mls.bin
/// does not wait for it: every write of the state copies it along (`write_slot_mls_bin`).
void CanariMirrorPushStateToAppGroup(void);

/// Carries the FCM cache entries the Notification Service Extension wrote into the App Group
/// container over to the app's own file, the only one `take_fcm_cache` reads. Call it
/// at the same transitions as the mirror above.
void CanariDrainAppGroupFcmCache(void);

#endif
