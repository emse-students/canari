#import "canari_ios.h"
#import "canari_push.h"
#import "canari_rust_bridge.h"
#import "KeyboardMediaBridge.h"

#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>

static volatile bool g_isInForeground = false;

#if __has_include(<FirebaseCore/FirebaseCore.h>)
#import <FirebaseCore/FirebaseCore.h>
#endif

/// WP-SEC-1 one-shot migration: existing installs hold the device key only in
/// push_context.json. Promote it to the Keychain (background-accessible item,
/// AfterFirstUnlockThisDeviceOnly, shared via group.fr.emse.canari), then strip
/// the field from the JSON and re-mirror. The NSE never falls back to the JSON —
/// if the app has not run since the update, one push falls back to the generic
/// text and the next launch fixes it permanently.
static void CanariMigrateDeviceKeyFromJson(void) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return;
  }
  NSString *path = [dir stringByAppendingPathComponent:@"push_context.json"];
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (data == nil) {
    return;
  }
  id json = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil];
  if (![json isKindOfClass:[NSMutableDictionary class]]) {
    return;
  }
  NSMutableDictionary *dict = (NSMutableDictionary *)json;
  NSString *deviceKeyB64 = [dict[@"deviceKeyB64"] isKindOfClass:[NSString class]] ? dict[@"deviceKeyB64"] : @"";
  if (deviceKeyB64.length == 0) {
    return;
  }
  NSString *userId = [dict[@"userId"] isKindOfClass:[NSString class]] ? dict[@"userId"] : @"";
  NSString *deviceId = [dict[@"deviceId"] isKindOfClass:[NSString class]] ? dict[@"deviceId"] : @"";
  if (userId.length == 0 || deviceId.length == 0) {
    return;
  }

  // Write the background-accessible Keychain item (mirrors KeystorePlugin.swift's bg item).
  NSString *alias = [NSString stringWithFormat:@"mls_device_key_%@_%@", userId, deviceId];
  NSString *account = [NSString stringWithFormat:@"mls_bg_key_%@", alias];
  // RAW bytes, matching what KeystorePlugin.storeKeyBytes writes at login - it
  // base64-decodes before hitting the Keychain, and the readers base64-encode on the way
  // out. Storing the base64 TEXT here would make a migrated install disagree with a
  // freshly logged-in one, and the readers would hand the FFI a double-encoded key.
  NSData *keyData = [[NSData alloc] initWithBase64EncodedString:deviceKeyB64 options:0];
  if (keyData.length != 32) {
    NSLog(@"[CanariIOS] migrateDeviceKey: deviceKeyB64 is not 32 bytes - keeping JSON field");
    return;
  }

  NSDictionary *deleteQuery = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @"fr.emse.canari",
    (__bridge id)kSecAttrAccount : account,
  };
  SecItemDelete((__bridge CFDictionaryRef)deleteQuery);

  NSDictionary *addQuery = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @"fr.emse.canari",
    (__bridge id)kSecAttrAccount : account,
    (__bridge id)kSecValueData : keyData,
    (__bridge id)kSecAttrAccessGroup : @"group.fr.emse.canari",
    (__bridge id)kSecAttrAccessible : (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
  };
  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)addQuery, nil);
  if (status != errSecSuccess) {
    NSLog(@"[CanariIOS] migrateDeviceKey: Keychain write failed (status=%d) — keeping JSON field", (int)status);
    return;
  }

  // Strip the field and rewrite.
  [dict removeObjectForKey:@"deviceKeyB64"];
  NSData *outData = [NSJSONSerialization dataWithJSONObject:dict options:0 error:nil];
  if (outData != nil) {
    [outData writeToFile:path atomically:YES];
  }

  // Delete the stale App Group mirror so the NSE copy stops carrying the key.
  NSURL *container = [[NSFileManager defaultManager]
      containerURLForSecurityApplicationGroupIdentifier:@"group.fr.emse.canari"];
  if (container != nil) {
    [[NSFileManager defaultManager]
        removeItemAtURL:[container URLByAppendingPathComponent:@"push_context.json"]
                  error:nil];
  }

  NSLog(@"[CanariIOS] migrateDeviceKey: key promoted to Keychain, JSON stripped, App Group mirror deleted");
}

static void CanariProcessPendingPushSecret(void) {
  NSString *secret = CanariRetrievePushSecret();
  if (secret != nil) {
    NSLog(@"[CanariIOS] processPendingPushSecret: Keychain pret");
  }
}

static void CanariCheckKeystoreHealth(void) {
  NSString *dir = CanariTauriDataDir();
  if (dir == nil) {
    return;
  }
  NSString *contextPath = [dir stringByAppendingPathComponent:@"push_context.json"];
  if (![[NSFileManager defaultManager] fileExistsAtPath:contextPath]) {
    return;
  }
  NSString *flagPath = [dir stringByAppendingPathComponent:@"keystore_ok.flag"];
  if (CanariRetrievePushSecret() != nil) {
    [@"ok" writeToFile:flagPath atomically:YES encoding:NSUTF8StringEncoding error:nil];
    NSLog(@"[CanariIOS] checkKeystoreHealth: Keychain operationnel");
  } else {
    [[NSFileManager defaultManager] removeItemAtPath:flagPath error:nil];
    NSLog(@"[CanariIOS] checkKeystoreHealth: Keychain perdu");
  }
}

static void CanariRequestNotificationPermission(void) {
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound |
                                             UNAuthorizationOptionBadge)
                        completionHandler:^(BOOL granted, NSError *_Nullable error) {
                          if (error != nil) {
                            NSLog(@"[CanariIOS] notification permission error: %@",
                                  error.localizedDescription);
                            return;
                          }
                          NSLog(@"[CanariIOS] notification permission granted=%d", granted);
                        }];
}

static void CanariSetupFirebaseIfAvailable(void) {
#if __has_include(<FirebaseCore/FirebaseCore.h>)
  NSString *plistPath =
      [[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"];
  if (plistPath == nil) {
    NSLog(@"[CanariIOS] GoogleService-Info.plist absent - Firebase desactive");
    return;
  }
  [FIRApp configure];
  NSLog(@"[CanariIOS] Firebase initialise");
#else
  NSLog(@"[CanariIOS] Firebase SDK absent (pod install requis pour push FCM)");
#endif
}

static void CanariOnDidBecomeActive(__unused NSNotification *note) {
  g_isInForeground = true;
  canari_ios_on_resume();
  CanariProcessPendingPushSecret();
  CanariMigrateDeviceKeyFromJson();
  CanariCheckKeystoreHealth();
  CanariPushCancelMessageNotifications();
  // Refresh the App Group mirror so the NSE decrypts against the state as of the app's last
  // active moment (the foreground advances mls.bin; there is no Rust write hook to mirror on).
  CanariMirrorPushStateToAppGroup();
  NSLog(@"[CanariIOS] didBecomeActive");
}

static void CanariOnWillResignActive(__unused NSNotification *note) {
  g_isInForeground = false;
  canari_ios_on_pause();
  // Snapshot the latest decrypt state into the App Group container before suspending, so a push
  // arriving while backgrounded is decrypted by the NSE against fresh state.
  CanariMirrorPushStateToAppGroup();
  // Queue a background-processing window now that the app is leaving the foreground, so the OS
  // can drain mls_pending.db while suspended (best-effort; never runs for a force-quit app).
  CanariScheduleBackgroundCleanupTask();
  NSLog(@"[CanariIOS] willResignActive");
}

void canari_ios_bootstrap(void) {
  NSLog(@"[CanariIOS] bootstrap dataDir=%@", CanariTauriDataDir());
  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                CanariOnDidBecomeActive(note);
              }];
  [nc addObserverForName:UIApplicationWillResignActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                CanariOnWillResignActive(note);
              }];
  CanariRequestNotificationPermission();
  CanariSetupFirebaseIfAvailable();
  CanariPushSetup();
  // Register the BGProcessingTask handler here (before ffi::start_app()/UIApplicationMain):
  // BGTaskScheduler requires every launch handler to be registered before the app finishes
  // launching, and registering later (e.g. from the DidFinishLaunching observer) would throw.
  CanariRegisterBackgroundTasks();
  [nc addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                dispatch_async(dispatch_get_main_queue(), ^{
                  [[UIApplication sharedApplication] registerForRemoteNotifications];
                  NSLog(@"[CanariIOS] registerForRemoteNotifications");
                });
              }];
  CanariProcessPendingPushSecret();
  CanariCheckKeystoreHealth();
  // Start the keyboard media bridge (WP-XP-6). The WKWebView is not yet created at this point
  // (Tauri/wry creates it inside ffi::start_app() which runs after us), so we pass nil and the
  // bridge will find the WebView lazily on the first UIApplicationDidBecomeActiveNotification.
  CanariKeyboardMediaStart(nil);
}

bool canari_ios_is_in_foreground(void) { return g_isInForeground; }
