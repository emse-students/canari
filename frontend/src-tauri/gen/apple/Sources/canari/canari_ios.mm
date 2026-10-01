#import "canari_ios.h"
#import "canari_push.h"
#import "canari_rust_bridge.h"
#import "KeyboardMediaBridge.h"

#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <UIKit/UIKit.h>
#import <UserNotifications/UserNotifications.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

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
    NSLog(@"[CanariIOS] processPendingPushSecret: Keychain ready");
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
    NSLog(@"[CanariIOS] checkKeystoreHealth: Keychain healthy");
  } else {
    [[NSFileManager defaultManager] removeItemAtPath:flagPath error:nil];
    NSLog(@"[CanariIOS] checkKeystoreHealth: Keychain lost");
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
    NSLog(@"[CanariIOS] GoogleService-Info.plist missing - Firebase disabled");
    return;
  }
  [FIRApp configure];
  NSLog(@"[CanariIOS] Firebase initialised");
#else
  NSLog(@"[CanariIOS] Firebase SDK missing (pod install required for FCM push)");
#endif
}

static void CanariPublishSafeAreaInsets(void);

/// Puts the WebView's own scroll view back inside its content whenever it has left it.
///
/// The app never scrolls the DOCUMENT: the shell is pinned to the viewport and every list scrolls
/// in its own element, so the WKWebView's scroll view has no range at all. WebKit still moves it
/// when the keyboard changes the geometry - revealing a focused field against a frame that
/// `CanariApplyKeyboardLayout` is shrinking at that moment - and nothing moves it back once the
/// content shrinks under it. Measured on an iPhone 12 (2026-10-01): with the keyboard up on the chat
/// list the scroll view sat ~56 pt off, INVISIBLE to the page (no `scroll` event, the rects
/// unchanged), so the header left the screen, the window's ground showed in the status strip, and
/// every native glass piece - placed at the page's rects - was off by that much.
///
/// Event-driven, never timed: this runs on every change of the offset AND of the content size (the
/// shrink is what strands the offset), and leaves the user's own gestures alone - a drag, its
/// deceleration and its bounce are UIKit's, which returns inside the range by itself. An offset
/// inside the range is never touched, so a page that does scroll scrolls as before.
static void CanariClampDocumentScroll(UIScrollView *scrollView) {
  if (scrollView.tracking || scrollView.dragging || scrollView.decelerating) {
    return;
  }
  UIEdgeInsets inset = scrollView.adjustedContentInset;
  CGFloat minY = -inset.top;
  CGFloat maxY =
      MAX(minY, scrollView.contentSize.height - CGRectGetHeight(scrollView.bounds) + inset.bottom);
  CGFloat y = scrollView.contentOffset.y;
  if (y >= minY - 0.5 && y <= maxY + 0.5) {
    return;
  }
  CGFloat clamped = MIN(MAX(y, minY), maxY);
  NSLog(@"[CanariIOS] WebView scroll view off its content (y=%.1f, range %.1f..%.1f) - put back to %.1f",
        y, minY, maxY, clamped);
  scrollView.contentOffset = CGPointMake(scrollView.contentOffset.x, clamped);
}

@interface CanariScrollRangeObserver : NSObject
@end
@implementation CanariScrollRangeObserver
- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary *)change
                       context:(void *)context {
  CanariClampDocumentScroll((UIScrollView *)object);
}
@end

/// Installs the observer above on the WebView's scroll view, once; the WebView only exists after
/// `start_app()`, so this is called from every activation like the other WebView setups.
static void CanariObserveDocumentScrollRange(void) {
  static CanariScrollRangeObserver *observer = nil;
  WKWebView *webView = CanariFindWebView();
  if (webView == nil || observer != nil) {
    return;
  }
  observer = [CanariScrollRangeObserver new];
  [webView.scrollView addObserver:observer forKeyPath:@"contentOffset" options:0 context:NULL];
  [webView.scrollView addObserver:observer forKeyPath:@"contentSize" options:0 context:NULL];
  NSLog(@"[CanariIOS] watching the WebView scroll view's range");
}

/// Shrinks the WebView to the space the soft keyboard leaves - the iOS peer of Android's
/// `MainActivity.applyKeyboardInsets`, taken for the same reason and with the same shape.
///
/// WKWebView is never resized for the keyboard: it keeps its full height and only the VISUAL
/// viewport shrinks. The web layer sees that and pins the app shell to the visible height
/// (`keyboardViewport.svelte.ts`), but the document is still full height, so a keyboard-tall empty
/// band opens below the shell - and the page, auto-scrolled by WebKit to reveal the focused field,
/// is scrolled straight onto it. That band is the large empty zone the composer sits above.
///
/// The fix is the one Android already took: move the LAYOUT viewport instead of papering over it
/// with a margin. Changing the WebView's frame changes `window.innerHeight` itself, so shell height
/// and document height agree again - and `computeSnapshot` then reports `layoutInsetBottom: 0`
/// with no web change at all, because that branch was already written for a native resize iOS
/// never performed.
///
/// It settles the safe area for free, which on Android needed a second mechanism: a WebView whose
/// bottom edge no longer reaches the home indicator is given `safeAreaInsets.bottom == 0` by
/// UIKit, so `env(safe-area-inset-bottom)` stops reserving a strip that is now behind the keyboard.
///
/// Stateless on purpose: the target is recomputed from the superview's bounds on every event, so
/// there is no remembered "original frame" to restore and nothing that can drift out of step.
/// `UIKeyboardWillChangeFrame` alone covers appearing, disappearing, height changes (predictive
/// bar, accessory views) and interactive dismissal - on the way out the end frame is off-screen,
/// the intersection is empty and the overlap is zero, so one path serves both directions.
static void CanariApplyKeyboardLayout(NSNotification *note) {
  WKWebView *webView = CanariFindWebView();
  UIView *parent = webView.superview;
  if (parent == nil) {
    // Before start_app() there is no WebView; the next keyboard event finds one.
    return;
  }

  CGRect keyboardEnd = [note.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue];
  CGRect overlapRect =
      CGRectIntersection(parent.bounds, [parent convertRect:keyboardEnd fromView:nil]);
  CGFloat overlap = CGRectIsNull(overlapRect) ? 0.0 : CGRectGetHeight(overlapRect);

  CGRect target = parent.bounds;
  target.size.height -= overlap;
  if (CGRectEqualToRect(webView.frame, target)) {
    return;
  }

  NSNumber *duration = note.userInfo[UIKeyboardAnimationDurationUserInfoKey];
  NSNumber *curve = note.userInfo[UIKeyboardAnimationCurveUserInfoKey];
  NSLog(@"[CanariIOS] keyboard overlap=%.0f -> webview height %.0f", overlap, target.size.height);
  // Ride the keyboard's own curve rather than a guessed one: the shift is then a single motion
  // instead of the layout snapping ahead of the keys it is making room for.
  [UIView animateWithDuration:duration.doubleValue
                        delay:0
                      options:(UIViewAnimationOptions)(curve.unsignedIntegerValue << 16)
                   animations:^{
                     webView.frame = target;
                   }
                   completion:^(__unused BOOL finished) {
                     CanariClampDocumentScroll(webView.scrollView);
                     CanariPublishSafeAreaInsets();
                   }];
}

/// Makes the WKWebView transparent so the window's background shows through while SvelteKit
/// hydrates - the iOS peer of Android's `onWebViewCreate` / `Color.TRANSPARENT`
/// (docs/wiki/frontend/android-ios-parity.md#1.4). There is no iOS equivalent of
/// `onWebViewCreate`: wry creates the WKWebView inside `ffi::start_app()`, so - like the
/// keyboard media bridge above - this is applied lazily on the first `didBecomeActive` rather
/// than at creation time. Idempotent, so re-applying on every activation costs nothing.
static void CanariApplyWebViewTransparency(void) {
  WKWebView *webView = CanariFindWebView();
  if (webView == nil) {
    return;
  }
  webView.opaque = NO;
  webView.backgroundColor = [UIColor clearColor];
  webView.scrollView.backgroundColor = [UIColor clearColor];
}

/// Makes the page draw edge to edge, UNDER the status bar - what Android already does and what
/// `Info.plist` has declared since 2026-08-28 (docs/wiki/frontend/android-ios-parity.md#1.1).
///
/// By default UIKit insets the WKWebView's scroll view by the status bar, so the page stopped 47 pt
/// below the top and the strip above it showed the window's black: a black bar over a light app
/// (user, 2026-09-30: "je veux une experience belle et immersive"). `.never` lets the page reach the
/// top, and the inset it then owes the layout is published as `--safe-area-inset-top` beside the
/// bottom one (WebKit reports `env(safe-area-inset-*)` as 0 here, so nothing else can tell the page).
/// Measured on its own this was a defect - the page drew under the clock with no inset to avoid it -
/// which is why the two halves ship together and the top consumers read the variable, not env().
static void CanariApplyEdgeToEdge(void) {
  WKWebView *webView = CanariFindWebView();
  if (webView == nil) {
    return;
  }
  webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
}

/// Makes the system chrome follow the APP's theme, not the phone's. The status bar is
/// `UIStatusBarStyleDefault` (Info.plist), which picks dark or light content from the window's
/// trait collection - so with the page now behind it, a light Canari on a dark-mode phone would show
/// a white clock on a pale header. Overriding the window's interface style also themes the keyboard,
/// the native tab bar and every alert, which is wanted. `theme` is `"dark"` or `"light"`, the value of
/// `html[data-theme]`; anything else is logged and ignored.
static void CanariApplyTheme(NSString *theme) {
  WKWebView *webView = CanariFindWebView();
  UIWindow *window = webView.window;
  if (window == nil) {
    return;
  }
  UIUserInterfaceStyle style;
  if ([theme isEqualToString:@"dark"]) {
    style = UIUserInterfaceStyleDark;
  } else if ([theme isEqualToString:@"light"]) {
    style = UIUserInterfaceStyleLight;
  } else {
    NSLog(@"[CanariIOS] theme ignored, unknown value: %@", theme);
    return;
  }
  if (window.overrideUserInterfaceStyle != style) {
    window.overrideUserInterfaceStyle = style;
    NSLog(@"[CanariIOS] interface style follows the app theme: %@", theme);
  }
  // THE WINDOW'S OWN GROUND, in the app's: it shows wherever the WebView is not - the band between a
  // keyboard-shrunk page and the keyboard, and the keyboard's rounded top corners (user, 2026-09-30:
  // "la barre noire au dessus [du clavier] avec le coin"). These are `app.html`'s two literals.
  UIColor *ground = style == UIUserInterfaceStyleDark
                        ? [UIColor blackColor]
                        : [UIColor colorWithRed:240.0 / 255.0 green:242.0 / 255.0 blue:245.0 / 255.0 alpha:1.0];
  window.backgroundColor = ground;
  window.rootViewController.view.backgroundColor = ground;
}

/// The page tells native its theme through `webkit.messageHandlers.canariTheme.postMessage(...)`
/// (`themeStore.svelte.ts`), at startup and at every change.
@interface CanariThemeHandler : NSObject <WKScriptMessageHandler>
@end
@implementation CanariThemeHandler
- (void)userContentController:(WKUserContentController *)controller
      didReceiveScriptMessage:(WKScriptMessage *)message {
  CanariApplyTheme([message.body isKindOfClass:[NSString class]] ? message.body : @"");
}
@end

static void CanariObserveTheme(void) {
  static CanariThemeHandler *handler = nil;
  WKWebView *webView = CanariFindWebView();
  if (webView == nil || handler != nil) {
    return;
  }
  handler = [CanariThemeHandler new];
  [webView.configuration.userContentController addScriptMessageHandler:handler name:@"canariTheme"];
  NSLog(@"[CanariIOS] listening for the app theme");
}

/// Publishes the home indicator's inset to the page as `--safe-area-inset-bottom` - the iOS peer of
/// what Android's window insets give the same 35 consumers (`app.html` names that variable "the one
/// place this is decided").
///
/// WebKit reports EVERY `env(safe-area-inset-*)` as 0 in this WebView, the bottom included: the page
/// reaches the screen's bottom edge (`innerHeight` 797 of 844 because UIKit insets the top by the
/// status bar and the bottom by nothing), so nothing on the web side could keep a control out of the
/// home indicator - the post composer's "Publier" sat 26 pt into it. Measured over the bench's CDP
/// on an iPhone 12, 2026-09-30. `contentInsetAdjustmentBehavior = .never` was tried and is WRONG:
/// the viewport became the whole screen, the insets stayed 0, and the page drew under the status bar.
/// So the top stays UIKit's (the page starts below the bar) and only the bottom is told to the page.
///
/// The inset is the window's bottom safe area MINUS the part of it the WebView no longer reaches,
/// so a WebView shrunk above the keyboard publishes 0 - the same outcome `.keyboard-open` has on
/// Android, and what the old comment on CanariApplyKeyboardLayout relied on UIKit to do through env().
/// Re-read at every activation (a reload of the page loses the property) and after every keyboard
/// resize; portrait only on iPhone, so there is no rotation to follow.
/// Republishes the inset when a page finishes loading: a document that loads after the publish
/// starts without the property (seen on a cold start, where the first `didBecomeActive` precedes the
/// end of the initial load - syslog showed 34 pt published and the page still read 0).
@interface CanariLoadObserver : NSObject
@end
@implementation CanariLoadObserver
- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary *)change
                       context:(void *)context {
  if ([keyPath isEqualToString:@"loading"] && ![(WKWebView *)object isLoading]) {
    CanariPublishSafeAreaInsets();
  }
}
@end

static void CanariPublishSafeAreaInsets(void) {
  static CGFloat published = -1;
  static CanariLoadObserver *loadObserver = nil;
  WKWebView *webView = CanariFindWebView();
  UIWindow *window = webView.window;
  if (webView == nil || window == nil) {
    return;
  }
  if (loadObserver == nil) {
    loadObserver = [CanariLoadObserver new];
    [webView addObserver:loadObserver forKeyPath:@"loading" options:0 context:NULL];
  }
  CGRect inWindow = [webView.superview convertRect:webView.frame toView:nil];
  CGFloat unreached = MAX(0.0, CGRectGetHeight(window.bounds) - CGRectGetMaxY(inWindow));
  CGFloat inset = MAX(0.0, window.safeAreaInsets.bottom - unreached);
  // The top mirrors the bottom: the window's top safe area minus the part the WebView's frame
  // starts below. With the page edge to edge (CanariApplyEdgeToEdge) the frame starts at the screen's
  // top, so that is the status bar's whole height.
  CGFloat top = MAX(0.0, window.safeAreaInsets.top - MAX(0.0, CGRectGetMinY(inWindow)));
  NSString *js = [NSString
      stringWithFormat:@"document.documentElement.style.setProperty('--safe-area-inset-bottom', '%.0fpx');"
                        "document.documentElement.style.setProperty('--safe-area-inset-top', '%.0fpx');"
                        "(document.documentElement.dataset.theme || '')",
                       inset, top];
  [webView evaluateJavaScript:js
            completionHandler:^(id result, NSError *error) {
              // The same round trip reads the theme the page started with: a page that loads after
              // the handler was registered posted nothing native could hear.
              if ([result isKindOfClass:[NSString class]] && [(NSString *)result length] > 0) {
                CanariApplyTheme(result);
              }
            }];
  if (inset != published) {
    published = inset;
    NSLog(@"[CanariIOS] safe area published to the page: bottom %.0f pt, top %.0f pt", inset, top);
  }
}

/// Removes the form accessory bar WebKit draws above the keyboard on every text field - the up and
/// down arrows and "OK", about 45 pt that the composer, the search box and every form lose while
/// typing (finding E of docs/wiki/phone-comparison.md). Canari has no use for field-to-field
/// navigation, and Android's keyboard carries no such bar, so the two phones now type in the same
/// space.
///
/// The bar is the WebView's content view's `inputAccessoryView`. WKWebView exposes no switch for it, so
/// that one object is given a subclass answering nil - the shape every iOS app that hides this bar
/// uses. `WKContentView` is WebKit's own class and is found by its name PREFIX, not imported; when a
/// future iOS renames it the bar comes back, which is a cosmetic regression and is LOGGED rather than
/// hidden. Idempotent, like the transparency above, and applied on every activation because the
/// content view only exists once the page has been created.
static void CanariHideKeyboardAccessoryBar(void) {
  WKWebView *webView = CanariFindWebView();
  if (webView == nil) {
    return;
  }
  UIView *content = nil;
  for (UIView *candidate in webView.scrollView.subviews) {
    if ([NSStringFromClass([candidate class]) hasPrefix:@"WKContent"]) {
      content = candidate;
      break;
    }
  }
  if (content == nil) {
    NSLog(@"[CanariIOS] keyboard accessory bar NOT removed: no WKContent view under the WebView's scroll view");
    return;
  }
  static const char *kSubclassName = "CanariNoInputAccessoryContentView";
  Class subclass = NSClassFromString([NSString stringWithUTF8String:kSubclassName]);
  if (subclass == nil) {
    subclass = objc_allocateClassPair([content class], kSubclassName, 0);
    if (subclass == Nil) {
      NSLog(@"[CanariIOS] keyboard accessory bar NOT removed: could not derive a subclass of %@", [content class]);
      return;
    }
    IMP noAccessory = imp_implementationWithBlock(^id(__unused id self) {
      return nil;
    });
    class_addMethod(subclass, @selector(inputAccessoryView), noAccessory, "@@:");
    objc_registerClassPair(subclass);
  }
  if (![content isMemberOfClass:subclass]) {
    object_setClass(content, subclass);
    NSLog(@"[CanariIOS] keyboard accessory bar removed from %@", NSStringFromClass([content class]));
  }
}

static void CanariOnDidBecomeActive(__unused NSNotification *note) {
  g_isInForeground = true;
  canari_ios_on_resume();
  CanariApplyWebViewTransparency();
  CanariApplyEdgeToEdge();
  CanariObserveDocumentScrollRange();
  CanariObserveTheme();
  CanariHideKeyboardAccessoryBar();
  CanariPublishSafeAreaInsets();
  CanariProcessPendingPushSecret();
  CanariMigrateDeviceKeyFromJson();
  CanariCheckKeystoreHealth();
  CanariPushCancelMessageNotifications();
  // Pick up whatever the NSE decrypted while we were killed or backgrounded. It writes into the
  // App Group because an extension cannot reach the app's data container; this is the hop that
  // puts those entries where read_and_clear_fcm_cache will find them, and it must happen before
  // the frontend asks for the cache at login.
  CanariDrainAppGroupFcmCache();
  // Refresh the App Group mirror so the NSE decrypts against the state as of the app's last
  // active moment (the foreground advances mls.bin; there is no Rust write hook to mirror on).
  CanariMirrorPushStateToAppGroup();
  // The FCM token, asked for HERE and not at bootstrap. By the time the app is active,
  // registerForRemoteNotifications has run and APNs has usually answered - which is the
  // precondition FIRMessaging has and Android does not, and the one the old bootstrap call could
  // not possibly satisfy. It self-corrects without a timer: this fires on every activation, and the
  // function returns immediately while the APNs token is still absent.
  CanariSyncFcmTokenIfApnsReady();
  NSLog(@"[CanariIOS] didBecomeActive");
}

static void CanariOnWillResignActive(__unused NSNotification *note) {
  g_isInForeground = false;
  canari_ios_on_pause();
  // Snapshot the latest decrypt state into the App Group container before suspending, so a push
  // arriving while backgrounded is decrypted by the NSE against fresh state.
  CanariMirrorPushStateToAppGroup();
  // The quick-action titles are the one native string iOS lets us re-register, and this is the last
  // moment before a notification can be seen - so a language changed in the foreground reaches the
  // buttons before anything shows them. No-op when the locale has not moved.
  CanariRefreshNotificationCategories();
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
  [nc addObserverForName:UIKeyboardWillChangeFrameNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                CanariApplyKeyboardLayout(note);
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
  // Cold start: drain before the WebView exists, so the very first read_and_clear_fcm_cache of
  // this launch already sees the pushes handled while the app was killed.
  CanariDrainAppGroupFcmCache();
  // Start the keyboard media bridge (WP-XP-6). The WKWebView is not yet created at this point
  // (Tauri/wry creates it inside ffi::start_app() which runs after us), so we pass nil and the
  // bridge will find the WebView lazily on the first UIApplicationDidBecomeActiveNotification.
  CanariKeyboardMediaStart(nil);
}

bool canari_ios_is_in_foreground(void) { return g_isInForeground; }
