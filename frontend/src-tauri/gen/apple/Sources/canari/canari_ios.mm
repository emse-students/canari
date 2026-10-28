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

/// The install's native cache key (Rust `native_cache`, the only copy of the design): a random
/// 32-byte key sealing `graine_seeds.json` and the push cache at rest. Kept exactly like the device
/// key's background copy - a Keychain item `mls_bg_key_<alias>` shared with the notification
/// extension through the App Group access group, AfterFirstUnlockThisDeviceOnly, never synchronised
/// and never in a backup - so the extension and the app (through the keystore plugin's unattended
/// read) both find it. CREATED HERE AND NOWHERE ELSE: one creator, so one file is never sealed under
/// two keys. Created only on errSecItemNotFound; any other status (a locked device before its first
/// unlock) leaves everything as it is and says so. Android twin: NativeCacheKey.ensure.
static void CanariEnsureNativeCacheKey(void) {
  NSString *account = @"mls_bg_key_canari_native_cache_key";
  NSDictionary *probe = @{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : @"fr.emse.canari",
    (__bridge id)kSecAttrAccount : account,
    (__bridge id)kSecAttrAccessGroup : @"group.fr.emse.canari",
  };
  OSStatus found = SecItemCopyMatching((__bridge CFDictionaryRef)probe, nil);
  if (found == errSecSuccess) {
    NSLog(@"[CanariIOS] nativeCacheKey: present");
    return;
  }
  if (found != errSecItemNotFound) {
    NSLog(@"[CanariIOS] nativeCacheKey: ERROR Keychain unreadable (status=%d) - left as it is", (int)found);
    return;
  }
  NSMutableData *key = [NSMutableData dataWithLength:32];
  if (SecRandomCopyBytes(kSecRandomDefault, 32, key.mutableBytes) != errSecSuccess) {
    NSLog(@"[CanariIOS] nativeCacheKey: ERROR no random bytes - not created");
    return;
  }
  NSMutableDictionary *add = [probe mutableCopy];
  add[(__bridge id)kSecValueData] = key;
  add[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
  OSStatus status = SecItemAdd((__bridge CFDictionaryRef)add, nil);
  [key resetBytesInRange:NSMakeRange(0, key.length)];
  if (status == errSecSuccess) {
    NSLog(@"[CanariIOS] nativeCacheKey: created");
  } else if (status == errSecDuplicateItem) {
    NSLog(@"[CanariIOS] nativeCacheKey: present (created meanwhile)");
  } else {
    NSLog(@"[CanariIOS] nativeCacheKey: ERROR creation failed (status=%d) - the native caches stay unwritten", (int)status);
  }
}

/// Keeps the two native caches - `graine_seeds.json` and the push cache - out of every backup, in
/// the app's data directory and in the App Group container the notification extension reads. THE
/// CACHES ONLY, NEVER THEIR DIRECTORY: it also holds `mls.bin`, `push_context.json` and the identity
/// files, and those must come back with a restore together with WebKit's IndexedDB: one without the
/// other would look like a damaged MLS state. (On a phone whose at-rest key is hardware-held, a
/// restore onto ANOTHER phone brings the files without the key, and the at-rest marker that rides
/// along makes that a typed lost-key state - auth.md.) The caches gain nothing from a restore:
/// their key is a ThisDeviceOnly Keychain item that does not travel. Per file, so every writer
/// re-applies it after its atomic write; this pass at bootstrap and activation covers a file an
/// older build wrote. Android excludes its data domain (`data_extraction_rules.xml`).
static void CanariExcludeNativeCachesFromBackup(void) {
  CanariExcludeNativeCacheFilesFromBackup(CanariTauriDataDir());
  CanariExcludeNativeCacheFilesFromBackup([[NSFileManager defaultManager]
      containerURLForSecurityApplicationGroupIdentifier:@"group.fr.emse.canari"]
                                              .path);
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
                                  CanariErrorReason(error));
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
static void CanariPublishDynamicType(void);

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

/// One line per settled keyboard change: the scroll view's offset and range as UIKit holds them, beside
/// the document's scroll and viewport and the composer's top as the PAGE reads them.
///
/// A REPORT, NOT A REPAIR. iPhone 12, `v1.2.9-alpha.7`, 2026-10-17: in a DM whose last message is a
/// tall video, the keyboard's rise left every native glass piece one keyboard overlap (301 pt) above
/// its web twin - the "+" mid-thread, the header off the top of the screen - while the web layer was
/// drawn where it belongs. The salon, same keyboard, was right; and a later keyboard change in the same
/// DM (the emoji keyboard, 301 -> 388) put everything back. The native pieces are placed at the page's
/// `getBoundingClientRect()` (`nativeGlassPiece.svelte.ts`), so the page's coordinates and the screen
/// disagreed by exactly the overlap. Three causes fit that and the source cannot choose between them:
/// the page believes the document scrolled while UIKit's offset is 0 (`scrollY` 301, `offset` 0); the
/// document kept a range and the offset sits legally inside it (`content` - `bounds` = 301, which the
/// clamp above never touches); or the page laid the composer out at 186 itself (`composerTop` 186,
/// both scrolls 0). This line separates the three on the next build, from the bench's syslog alone,
/// since a store build's WebView cannot be inspected (docs/wiki/device-verification.md).
static void CanariReportSettledKeyboardGeometry(WKWebView *webView) {
  UIScrollView *scrollView = webView.scrollView;
  CGFloat offset = scrollView.contentOffset.y;
  CGFloat content = scrollView.contentSize.height;
  CGFloat bounds = CGRectGetHeight(scrollView.bounds);
  NSString *js =
      @"(function(){var s=document.scrollingElement,v=window.visualViewport,"
       "f=document.querySelector('.chat-composer-footer');"
       "function r(n){return Math.round(n*10)/10}"
       "return 'scrollY='+r(window.scrollY)+' scrollHeight='+(s?r(s.scrollHeight):'none')+"
       "' innerHeight='+r(window.innerHeight)+' vvHeight='+(v?r(v.height):'none')+"
       "' vvOffsetTop='+(v?r(v.offsetTop):'none')+' vvPageTop='+(v?r(v.pageTop):'none')+"
       "' composerTop='+(f?r(f.getBoundingClientRect().top):'none')})()";
  [webView evaluateJavaScript:js
            completionHandler:^(id result, NSError *error) {
              if (error != nil || ![result isKindOfClass:[NSString class]]) {
                NSLog(@"[CanariIOS] keyboard settled: native offset=%.1f content=%.1f bounds=%.1f | "
                      @"page geometry NOT read: %@",
                      offset, content, bounds, error);
                return;
              }
              NSLog(@"[CanariIOS] keyboard settled: native offset=%.1f content=%.1f bounds=%.1f | page %@",
                    offset, content, bounds, result);
            }];
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
                     CanariReportSettledKeyboardGeometry(webView);
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
    CanariPublishDynamicType();
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

/// Hands the page the user's Dynamic Type body size, as `canari:dynamic-type` (detail `bodyPx`) and
/// `window.__canariDynamicTypeBodyPx` - `followIosDynamicType` in `lib/utils/textZoom.ts` turns it
/// into `--type-scale`.
///
/// WHY NATIVE SAYS IT, when a `-apple-system-body` probe reads the same size at start-up: a size
/// changed while the app was in the background applied only after a cold start, 3 of 3 (iPhone 12,
/// 1.2.9-alpha.1, 2026-10-15) - the page re-read its probe on `visibilitychange` and either was not
/// told or read WebKit's size before WebKit had learnt the new one. UIKit KNOWS the size when it
/// posts the change, so the value is carried from there instead of re-derived through a probe
/// (docs/wiki/frontend/mobile.md, Dynamic Type). Points are CSS pixels at the page's 1:1 viewport.
/// Sent on the change itself, on every activation (a change made while suspended), and after every
/// page load (a reloaded page starts from its probe again).
static void CanariPublishDynamicType(void) {
  static CGFloat published = -1;
  WKWebView *webView = CanariFindWebView();
  if (webView == nil) {
    return;
  }
  CGFloat bodyPt = [UIFont preferredFontForTextStyle:UIFontTextStyleBody].pointSize;
  NSString *js = [NSString
      stringWithFormat:@"window.__canariDynamicTypeBodyPx=%.2f;"
                        "window.dispatchEvent(new CustomEvent('canari:dynamic-type',{detail:{bodyPx:%.2f}}));",
                       bodyPt, bodyPt];
  [webView evaluateJavaScript:js completionHandler:nil];
  if (bodyPt != published) {
    published = bodyPt;
    NSLog(@"[CanariIOS] Dynamic Type body published to the page: %.1f pt (%@)", bodyPt,
          [UIApplication sharedApplication].preferredContentSizeCategory);
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
  static const char *kSubclassName = "CanariNoInputAccessoryContentView";
  Class subclass = NSClassFromString([NSString stringWithUTF8String:kSubclassName]);
  UIView *content = nil;
  for (UIView *candidate in webView.scrollView.subviews) {
    // ALREADY DONE is the common case: every activation after the first lands here. The swap renames
    // the view's class, so the `WKContent` prefix below no longer matches it - which logged "NOT
    // removed" on every return to the foreground of a bar that WAS removed (7 times in one session,
    // iPhone 12, 2026-10-15).
    if (subclass != Nil && [candidate isMemberOfClass:subclass]) {
      return;
    }
    if ([NSStringFromClass([candidate class]) hasPrefix:@"WKContent"]) {
      content = candidate;
      break;
    }
  }
  if (content == nil) {
    NSLog(@"[CanariIOS] keyboard accessory bar NOT removed: no WKContent view under the WebView's scroll view");
    return;
  }
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

/// Mirrors `g_isInForeground` into the App Group as a file the Notification Service Extension
/// reads (`appInForegroundFile`): in the foreground the app tells a new device on the account in
/// its own alert, and the extension posts nothing. A separate process cannot read the static.
static void CanariSetAppGroupForegroundFlag(BOOL inForeground) {
  NSURL *container = [[NSFileManager defaultManager]
      containerURLForSecurityApplicationGroupIdentifier:@"group.fr.emse.canari"];
  if (!container) {
    NSLog(@"[CanariIOS] App Group unavailable - foreground flag not written");
    return;
  }
  NSURL *flag = [container URLByAppendingPathComponent:@"app_in_foreground"];
  if (inForeground) {
    if (![[NSData data] writeToURL:flag atomically:YES]) {
      NSLog(@"[CanariIOS] foreground flag not written");
    }
  } else {
    NSError *error = nil;
    if (![[NSFileManager defaultManager] removeItemAtURL:flag error:&error] &&
        error.code != NSFileNoSuchFileError) {
      NSLog(@"[CanariIOS] foreground flag not removed: %@", error);
    }
  }
}

/// The Share Extension's banner (`canari_Share/ShareViewController.swift`), removed once its share is
/// in the app: it has done its one job.
static NSString *const kCanariShareNotificationId = @"canari.share.ready";

/// The Darwin notification the Share Extension posts when a share waits in the App Group.
static CFStringRef const kCanariShareReadyNotification = CFSTR("fr.emse.canari.share-ready");

/// Whether a share manifest waits in `dir` - a STAT, never a read, so it answers while the device is
/// locked too (Data Protection guards a file's contents, not its name). NO for a nil `dir`.
static BOOL CanariShareManifestWaits(NSString *dir) {
  if (dir == nil) {
    return NO;
  }
  NSString *manifest = [dir stringByAppendingPathComponent:[NSString stringWithUTF8String:CANARI_SHARE_PENDING_FILE]];
  return [[NSFileManager defaultManager] fileExistsAtPath:manifest];
}

/// The App Group container's path, or nil when it is unavailable.
static NSString *CanariShareAppGroupDir(void) {
  return [[NSFileManager defaultManager]
             containerURLForSecurityApplicationGroupIdentifier:@"group.fr.emse.canari"]
      .path;
}

/// Tells a live page a share waits in the app data directory - `canari:incoming-share`, the event
/// Android's MainActivity dispatches - so it drains it now. A page not loaded yet drains the file at
/// mount instead. `why` names the call site in the log.
static void CanariTellPageOfShare(NSString *why) {
  WKWebView *webView = CanariFindWebView();
  if (webView == nil) {
    NSLog(@"[CanariShare] a share waits (%@) before the WebView: the page drains it at mount", why);
    return;
  }
  [webView evaluateJavaScript:@"window.dispatchEvent(new CustomEvent('canari:incoming-share'));"
            completionHandler:^(__unused id result, NSError *error) {
              if (error != nil) {
                NSLog(@"[CanariShare] the page was not told of the share (%@): it drains at its next mount",
                      CanariErrorReason(error));
              }
            }];
  NSLog(@"[CanariShare] a share waits (%@), the page was told", why);
}

/// Carries a share another app made INTO Canari out of the App Group, where the Share Extension left
/// it, into the app's own handoff (`canari_ios_import_app_group_share`, commands/app_group_share.rs),
/// then tells a live page. YES when a share was imported (and the page told).
///
/// NO UIKIT HERE: the bootstrap calls it before the application object exists, where
/// `[UIApplication sharedApplication]` is nil and any question put to it answers NO. A locked device
/// is Rust's to answer, and it answers it safely: `CANARI_SHARE_IMPORT_PROTECTED`, nothing moved and
/// nothing deleted (docs/wiki/frontend/sharing.md, "At rest").
static BOOL CanariImportAppGroupShare(NSString *why) {
  NSString *dataDir = CanariTauriDataDir();
  NSString *cacheDir = CanariTauriCacheDir();
  if (dataDir == nil || cacheDir == nil) {
    NSLog(@"[CanariShare] import (%@) NOT run: the app data or cache directory is unresolved", why);
    return NO;
  }
  int code = canari_ios_import_app_group_share(dataDir.UTF8String, cacheDir.UTF8String);
  // The CODE is the log: the launch call runs before the Rust logger exists.
  switch (code) {
    case CANARI_SHARE_IMPORT_IMPORTED:
      break;
    case CANARI_SHARE_IMPORT_NOTHING:
      return NO;
    case CANARI_SHARE_IMPORT_BUSY:
      NSLog(@"[CanariShare] import (%@): the Share Extension is copying - imported at the next activation", why);
      return NO;
    case CANARI_SHARE_IMPORT_DROPPED:
      NSLog(@"[CanariShare] import (%@) ERROR: the App Group manifest was unreadable and was dropped", why);
      return NO;
    case CANARI_SHARE_IMPORT_PROTECTED:
      NSLog(@"[CanariShare] import (%@): the share is locked with the device - imported once it is unlocked", why);
      return NO;
    case CANARI_SHARE_IMPORT_DROPPED_OVER_LOCKED:
      // A LOSS, and at launch this is its only trace: the Rust logger does not exist yet.
      NSLog(@"[CanariShare] import (%@) ERROR: the share was dropped - the share already waiting is locked with the device and was kept", why);
      return NO;
    case CANARI_SHARE_IMPORT_NO_DIRS:
      NSLog(@"[CanariShare] import (%@) ERROR: the directories did not reach Rust", why);
      return NO;
    case CANARI_SHARE_IMPORT_NO_GROUP:
      NSLog(@"[CanariShare] import (%@) ERROR: the App Group container is unavailable", why);
      return NO;
    case CANARI_SHARE_IMPORT_FAILED:
      NSLog(@"[CanariShare] import (%@) ERROR: the share could not be moved or handed over", why);
      return NO;
    default:
      NSLog(@"[CanariShare] import (%@) ERROR: unknown code %d", why, code);
      return NO;
  }
  [[UNUserNotificationCenter currentNotificationCenter]
      removeDeliveredNotificationsWithIdentifiers:@[ kCanariShareNotificationId ]];
  NSLog(@"[CanariShare] share imported (%@)", why);
  CanariTellPageOfShare(why);
  return YES;
}

/// The import where the application object EXISTS (an activation, the extension's "share ready"),
/// which may therefore ask whether protected data is available. While the device is locked a waiting
/// share cannot be read: the import is not tried - the unlock imports it
/// (`CanariOnProtectedDataAvailable`) - and the deferral is said only when a share waits, so a locked
/// phone that has none logs nothing.
static void CanariImportAppGroupShareIfUnlocked(NSString *why) {
  if (![UIApplication sharedApplication].isProtectedDataAvailable) {
    if (CanariShareManifestWaits(CanariShareAppGroupDir())) {
      NSLog(@"[CanariShare] import (%@) deferred: the device is locked - imported once it is unlocked", why);
    }
    return;
  }
  CanariImportAppGroupShare(why);
}

/// THE UNLOCK (`UIApplicationProtectedDataDidBecomeAvailable`, which iOS also delivers to an app it
/// resumes after the unlock): what Data Protection held back is readable now. The App Group share is
/// imported, and a share already in the app data directory - one a drain found locked, after a
/// locked launch - is offered to the page: no activation and no import would tell it otherwise, and
/// the page drains only at its mount and on `canari:incoming-share`. An event, not a retry.
static void CanariOnProtectedDataAvailable(void) {
  if (CanariImportAppGroupShare(@"unlock")) {
    return;
  }
  if (CanariShareManifestWaits(CanariTauriDataDir())) {
    CanariTellPageOfShare(@"unlock");
  }
}

/// Says what the launch sweep did: it runs before the Rust logger exists, so its report is the
/// only trace (commands/app_group_share.rs, `CanariShareSweep`). Every failure bit is an ERROR line.
static void CanariLogShareSweep(CanariShareSweep sweep) {
  NSLog(@"[CanariShare] launch sweep: %d orphan share(s), %d leftover file(s) deleted, flags 0x%x",
        sweep.deleted, sweep.leftovers, sweep.flags);
  const uint32_t bits[] = {
      CANARI_SHARE_SWEEP_ALREADY_RAN,
      CANARI_SHARE_SWEEP_NO_DIRS,
      CANARI_SHARE_SWEEP_NO_GROUP,
      CANARI_SHARE_SWEEP_GROUP_BUSY,
      CANARI_SHARE_SWEEP_GROUP_LOCK_FAILED,
      CANARI_SHARE_SWEEP_EPOCH_UNREADABLE,
      CANARI_SHARE_SWEEP_EPOCH_REPAIRED,
      CANARI_SHARE_SWEEP_EPOCH_REPAIR_FAILED,
      CANARI_SHARE_SWEEP_LEFTOVER_FAILED,
      CANARI_SHARE_SWEEP_PROTECTED,
      CANARI_SHARE_SWEEP_CLAIM_RESTORED,
      CANARI_SHARE_SWEEP_CLAIM_LOST,
  };
  NSArray<NSString *> *whats = @[
    @"already ran in this process - nothing done",
    @"ERROR: the directories did not reach Rust - nothing done",
    @"ERROR: the App Group is unavailable - only the app cache was swept",
    @"a capture is running - the App Group is swept next process",
    @"ERROR: the App Group lock failed - not swept",
    @"ERROR: the share epoch is unreadable - every waiting share treated as stale",
    @"ERROR: the App Group epoch was behind the app's (a sign-out's copy had failed) - rewritten",
    @"ERROR: the App Group epoch is behind the app's and could NOT be rewritten",
    @"ERROR: a leftover claim or staging file could not be put back or deleted",
    @"a waiting share is locked with the device - its inbox was left whole",
    @"a share a dead process had claimed was put back - it is offered again",
    @"ERROR: a share a dead process had claimed was deleted - a newer one waits, so it is lost",
  ];
  for (NSUInteger i = 0; i < whats.count; i++) {
    if (sweep.flags & bits[i]) {
      NSLog(@"[CanariShare] launch sweep: %@", whats[i]);
    }
  }
}

/// The extension's "share ready" signal, for an app that is running when the share finishes (an
/// iPad beside the sending app). Darwin notifications arrive on an arbitrary thread.
static void CanariOnShareReady(__unused CFNotificationCenterRef center, __unused void *observer,
                               __unused CFNotificationName name, __unused const void *object,
                               __unused CFDictionaryRef userInfo) {
  dispatch_async(dispatch_get_main_queue(), ^{
    CanariImportAppGroupShareIfUnlocked(@"share ready");
  });
}

static void CanariOnDidBecomeActive(__unused NSNotification *note) {
  g_isInForeground = true;
  CanariSetAppGroupForegroundFlag(YES);
  canari_ios_on_resume();
  CanariApplyWebViewTransparency();
  CanariApplyEdgeToEdge();
  CanariObserveDocumentScrollRange();
  CanariObserveTheme();
  CanariHideKeyboardAccessoryBar();
  CanariPublishSafeAreaInsets();
  CanariPublishDynamicType();
  CanariProcessPendingPushSecret();
  CanariCheckKeystoreHealth();
  // Before the frontend's first take of the push cache: the key that seals it, and the backup
  // exclusion of where it lives. Both idempotent; the bootstrap ran them already when it could.
  CanariEnsureNativeCacheKey();
  CanariExcludeNativeCachesFromBackup();
  CanariPushCancelMessageNotifications();
  // Pick up whatever the NSE decrypted while we were killed or backgrounded. It writes into the
  // App Group because an extension cannot reach the app's data container; this is the hop that
  // puts those entries where take_fcm_cache will find them, and it must happen before
  // the frontend asks for the cache at login.
  CanariDrainAppGroupFcmCache();
  // A share the Share Extension made while Canari was away - the banner's tap lands here.
  CanariImportAppGroupShareIfUnlocked(@"activation");
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
  CanariSetAppGroupForegroundFlag(NO);
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

// ════════════════════════════════════════════════════════════════════════════
// THE LAUNCH URL OF A COLD START - handed to tao's scene delegate, which never reads it
// ════════════════════════════════════════════════════════════════════════════
//
// tao 0.37 (tauri 2.12, #1609) answers `application:configurationForConnectingSceneSession:` for
// every app, so Canari runs on the SCENE lifecycle although its Info.plist declares no scene
// manifest. On that lifecycle a link that LAUNCHES the app arrives once, in the connection options
// of `scene:willConnectToSession:options:` (`URLContexts` for `fr.emse.canari://`, `userActivities`
// for a Universal Link) - never through `application:openURL:options:` or `scene:openURLContexts:`.
// tao's `TaoSceneDelegate` ignores those options, so no `RunEvent::Opened` was ever emitted, the
// deep-link plugin's `getCurrent()` answered null, and every cold-start link opened the app on its
// default page: "Ouvrir dans l'application", a Universal Link, a `post/<id>` deep link (iPhone 12,
// 1.2.3-alpha.5, 2026-10-14). tao 0.35 only answered that configuration for a multi-scene plist,
// which kept the app on the classic lifecycle where `application:openURL:options:` carried it.
//
// The fix hands the options to the two methods tao already implements for a RUNNING app, after its
// own `willConnect` has run. The event loop is already up by then - with no scene manifest tao runs
// `on_app_ready()` from `didFinishLaunching`, and its `connect_scene` skips it - so `willConnect`
// only gives the scene its window, and `Opened` lands exactly as it does for a running app.
// Protocol: docs/wiki/frontend/mobile.md#a-cold-start-on-the-scene-lifecycle-lost-its-link.

typedef void (*CanariSceneWillConnectIMP)(id, SEL, UIScene *, UISceneSession *, UISceneConnectionOptions *);
static CanariSceneWillConnectIMP CanariOrigSceneWillConnect = NULL;

static void CanariSceneWillConnect(id self, SEL _cmd, UIScene *scene, UISceneSession *session,
                                   UISceneConnectionOptions *options) {
  CanariOrigSceneWillConnect(self, _cmd, scene, session, options);
  NSSet<UIOpenURLContext *> *urls = options.URLContexts;
  NSUInteger webActivities = 0;
  for (NSUserActivity *activity in options.userActivities) {
    if ([activity.activityType isEqualToString:NSUserActivityTypeBrowsingWeb]) webActivities++;
  }
  // The count, never the URL: a link may carry a join token.
  NSLog(@"[CanariDeepLink] scene connected with %lu launch url(s) and %lu web activit(ies)",
        (unsigned long)urls.count, (unsigned long)webActivities);
  if (urls.count > 0) {
    if ([self respondsToSelector:@selector(scene:openURLContexts:)]) {
      [(id<UISceneDelegate>)self scene:scene openURLContexts:urls];
    } else {
      NSLog(@"[CanariDeepLink] ERROR: the scene delegate has no scene:openURLContexts: - the launch url is LOST");
    }
  }
  for (NSUserActivity *activity in options.userActivities) {
    if (![activity.activityType isEqualToString:NSUserActivityTypeBrowsingWeb]) continue;
    if ([self respondsToSelector:@selector(scene:continueUserActivity:)]) {
      [(id<UISceneDelegate>)self scene:scene continueUserActivity:activity];
    } else {
      NSLog(@"[CanariDeepLink] ERROR: the scene delegate has no scene:continueUserActivity: - the Universal Link is LOST");
    }
  }
}

/// Wraps `TaoSceneDelegate`'s `scene:willConnectToSession:options:`. Called on
/// UIApplicationDidFinishLaunching, SYNCHRONOUSLY (`queue:nil`): tao registers the class inside
/// `ffi::start_app()`, so it does not exist at bootstrap, and UIKit connects the first scene right
/// after that notification - a block queued on the main queue would run after the link was gone.
static void CanariInstallSceneLaunchUrlHook(void) {
  Class cls = NSClassFromString(@"TaoSceneDelegate");
  Method method = cls ? class_getInstanceMethod(cls, @selector(scene:willConnectToSession:options:)) : NULL;
  if (method == NULL) {
    NSLog(@"[CanariDeepLink] ERROR: TaoSceneDelegate scene:willConnectToSession:options: not found - a cold-start link is LOST");
    return;
  }
  if (CanariOrigSceneWillConnect != NULL) return;
  CanariOrigSceneWillConnect =
      (CanariSceneWillConnectIMP)method_setImplementation(method, (IMP)CanariSceneWillConnect);
  // The proof it came in time is the NEXT line: `scene connected with ...` on every launch. A launch
  // that prints this one and not that one connected its scene first, and lost its link.
  NSLog(@"[CanariDeepLink] launch-url hook installed on TaoSceneDelegate");
}

void canari_ios_bootstrap(void) {
  NSLog(@"[CanariIOS] bootstrap dataDir=%@", CanariTauriDataDir());
  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserverForName:UIApplicationDidFinishLaunchingNotification
                  object:nil
                   queue:nil
              usingBlock:^(__unused NSNotification *note) {
                CanariInstallSceneLaunchUrlHook();
              }];
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
  // The change itself. Activations already cover a size changed in Settings or Control Center
  // (dismissing Control Center fires didBecomeActive); this observer is extra coverage for any
  // change that reaches the app without one.
  [nc addObserverForName:UIContentSizeCategoryDidChangeNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                CanariPublishDynamicType();
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
  // The native cache key before any push can be handled by this process, and the backup exclusion
  // of where the caches live (see each; the activation runs them again).
  CanariEnsureNativeCacheKey();
  CanariExcludeNativeCachesFromBackup();
  // Cold start: drain before the WebView exists, so the very first take_fcm_cache of
  // this launch already sees the pushes handled while the app was killed.
  CanariDrainAppGroupFcmCache();
  // A share into Canari: first the sweep, once per process and before any page exists to be staging
  // a copy (Android sweeps at its first onCreate for the same reason), then the import, so the
  // page's first drain finds it.
  // NO UIKIT QUESTION HERE: the application object does not exist yet (`ffi::start_app()` creates
  // it), so asking it whether protected data is available answers NO on every launch. A launch
  // while the device is locked (a push) is Rust's to answer: a locked manifest leaves its inbox
  // whole (SWEEP_PROTECTED) and its share in place (CANARI_SHARE_IMPORT_PROTECTED).
  NSString *shareDataDir = CanariTauriDataDir();
  NSString *shareCacheDir = CanariTauriCacheDir();
  if (shareDataDir != nil && shareCacheDir != nil) {
    CanariShareSweep sweep = canari_ios_sweep_shared_inboxes(shareDataDir.UTF8String, shareCacheDir.UTF8String);
    CanariLogShareSweep(sweep);
  } else {
    NSLog(@"[CanariShare] launch sweep NOT run: the app data or cache directory is unresolved");
  }
  CanariImportAppGroupShare(@"launch");
  [nc addObserverForName:UIApplicationProtectedDataDidBecomeAvailable
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *note) {
                CanariOnProtectedDataAvailable();
              }];
  CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(), NULL, CanariOnShareReady,
                                  kCanariShareReadyNotification, NULL,
                                  CFNotificationSuspensionBehaviorDeliverImmediately);
  // Start the keyboard media bridge (WP-XP-6). The WKWebView is not yet created at this point
  // (Tauri/wry creates it inside ffi::start_app() which runs after us), so we pass nil and the
  // bridge will find the WebView lazily on the first UIApplicationDidBecomeActiveNotification.
  CanariKeyboardMediaStart(nil);
}

bool canari_ios_is_in_foreground(void) { return g_isInForeground; }
