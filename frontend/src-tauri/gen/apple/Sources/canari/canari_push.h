#pragma once

#ifdef __OBJC__
#import <Foundation/Foundation.h>

/// Tauri `app_data_dir` (Application Support/fr.emse.canari) of the CALLING process.
FOUNDATION_EXPORT NSString *_Nullable CanariTauriDataDir(void);

/// Reads the push secret (Keychain, falling back to pending_push_secret.txt).
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

/// Dismisses message notifications when the app comes to the foreground.
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

/// Copies the push decrypt inputs (mls.bin, push_context.json, graine_seeds.json,
/// push_secret.txt) into the `group.fr.emse.canari` App Group container for the Notification
/// Service Extension. Call it on both foreground/background transitions.
void CanariMirrorPushStateToAppGroup(void);

/// Carries the FCM cache entries the Notification Service Extension wrote into the App Group
/// container over to the app's own file, the only one `read_and_clear_fcm_cache` reads. Call it
/// at the same transitions as the mirror above.
void CanariDrainAppGroupFcmCache(void);

#endif
