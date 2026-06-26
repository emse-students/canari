#pragma once

#ifdef __OBJC__
#import <Foundation/Foundation.h>

/// Repertoire Tauri `app_data_dir` (Application Support/fr.emse.canari).
FOUNDATION_EXPORT NSString *_Nullable CanariTauriDataDir(void);

/// Lit le push secret (Keychain, fallback pending_push_secret.txt).
FOUNDATION_EXPORT NSString *_Nullable CanariRetrievePushSecret(void);

/// Initialise le handler push (FCM delegate + UNUserNotificationCenter).
void CanariPushSetup(void);

/// Retire les notifications de messages au premier plan.
void CanariPushCancelMessageNotifications(void);

#endif
