#import "canari_ios.h"
#import "canari_push.h"
#import "canari_rust_bridge.h"

#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>

static volatile bool g_isInForeground = false;

#if __has_include(<FirebaseCore/FirebaseCore.h>)
#import <FirebaseCore/FirebaseCore.h>
#endif

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
  CanariCheckKeystoreHealth();
  CanariPushCancelMessageNotifications();
  NSLog(@"[CanariIOS] didBecomeActive");
}

static void CanariOnWillResignActive(__unused NSNotification *note) {
  g_isInForeground = false;
  canari_ios_on_pause();
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
}

bool canari_ios_is_in_foreground(void) { return g_isInForeground; }
