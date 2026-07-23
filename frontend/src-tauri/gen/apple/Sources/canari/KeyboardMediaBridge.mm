#import "KeyboardMediaBridge.h"
#import "canari_ios.h"

#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <WebKit/WebKit.h>

/// Polling interval in seconds. 0.5 s is low enough to feel instant and high enough to be
/// negligible for battery (NSTimer is coalesced by the system when idle).
static const NSTimeInterval kPollInterval = 0.5;

/// Maximum payload size in bytes (12 MiB, matching KeyboardMediaBridge.kt).
static const NSUInteger kMaxBytes = 12 * 1024 * 1024;

/// UTType identifiers we dispatch to the frontend (Gboard GIFs, stickers, and pasted photos).
static NSArray<NSString *> *kImageTypes(void) {
  static NSArray<NSString *> *types = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    types = @[ UTTypeGIF.identifier,
               UTTypePNG.identifier,
               UTTypeJPEG.identifier,
               UTTypeWebP.identifier ];
  });
  return types;
}

// ─── Private state ───────────────────────────────────────────────────────────

/// The target WKWebView (weak – owned by the view hierarchy, not by us).
static __weak WKWebView *g_targetWebView = nil;

/// Last known changeCount of UIPasteboard.general. We only dispatch when this value changes,
/// avoiding re-detection of the same pasteboard content without clearing it.
static NSInteger g_lastChangeCount = -1;

/// The repeating timer that drives the pasteboard poll.
static NSTimer *g_pollTimer = nil;

// ─── Internal helpers ────────────────────────────────────────────────────────

/// Recursively finds the first WKWebView in the given view's subview hierarchy.
static WKWebView * _Nullable FindWebViewInHierarchy(UIView *view) {
  if ([view isKindOfClass:[WKWebView class]]) {
    return (WKWebView *)view;
  }
  for (UIView *subview in view.subviews) {
    WKWebView *found = FindWebViewInHierarchy(subview);
    if (found != nil) return found;
  }
  return nil;
}

/// Finds the WKWebView by traversing all connected window scenes.
static WKWebView * _Nullable FindWebView(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      WKWebView *found = FindWebViewInHierarchy(window);
      if (found != nil) return found;
    }
  }
  return nil;
}

/// Synchronously loads data from an NSItemProvider for a given type identifier.
/// Uses a semaphore with a 2-second timeout.
static NSData * _Nullable LoadDataSync(NSItemProvider *provider, NSString *typeIdentifier) {
  __block NSData *result = nil;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);
  [provider loadDataRepresentationForTypeIdentifier:typeIdentifier
                                  completionHandler:^(NSData * _Nullable data, NSError * _Nullable error) {
    if (error == nil) result = data;
    dispatch_semaphore_signal(sem);
  }];
  dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  return result;
}

/// Returns the first item index in the pasteboard that carries a supported image type,
/// or NSNotFound.
static NSInteger IndexOfImageItem(UIPasteboard *pasteboard) {
  NSArray<NSItemProvider *> *providers = pasteboard.itemProviders;
  for (NSInteger i = 0; i < (NSInteger)providers.count; i++) {
    NSItemProvider *provider = providers[i];
    for (NSString *typeIdentifier in kImageTypes()) {
      if ([provider hasItemConformingToTypeIdentifier:typeIdentifier]) {
        return i;
      }
    }
  }
  return NSNotFound;
}

/// Reads the image data from `pasteboard` at `itemIndex`, preferring the first available type
/// that yields non-nil data. Returns nil on failure.
static NSData * _Nullable ReadImageData(UIPasteboard *pasteboard, NSInteger itemIndex) {
  NSArray<NSItemProvider *> *providers = pasteboard.itemProviders;
  if (itemIndex < 0 || itemIndex >= (NSInteger)providers.count) return nil;
  NSItemProvider *provider = providers[itemIndex];

  // Try image/png first (lossless for stickers), then jpeg, then gif, then webp.
  NSArray<NSString *> *preferred = @[ UTTypePNG.identifier,
                                       UTTypeJPEG.identifier,
                                       UTTypeGIF.identifier,
                                       UTTypeWebP.identifier ];
  for (NSString *typeIdentifier in preferred) {
    if ([provider hasItemConformingToTypeIdentifier:typeIdentifier]) {
      NSData *data = LoadDataSync(provider, typeIdentifier);
      if (data != nil) return data;
    }
  }

  // Last resort: load as UIImage and re-encode as PNG.
  if ([provider hasItemConformingToTypeIdentifier:UTTypeImage.identifier]) {
    __block UIImage *image = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [provider loadObjectOfClass:UIImage.class
              completionHandler:^(id<NSItemProviderReading> _Nullable obj, NSError * _Nullable error) {
      if (error == nil && [obj isKindOfClass:UIImage.class]) image = (UIImage *)obj;
      dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    if (image != nil) return UIImagePNGRepresentation(image);
  }

  return nil;
}

/// Guesses a MIME type from the pasteboard's first available image type at the given index.
static NSString *MimeFromPasteboard(UIPasteboard *pasteboard, NSInteger itemIndex) {
  NSArray<NSItemProvider *> *providers = pasteboard.itemProviders;
  if (itemIndex < 0 || itemIndex >= (NSInteger)providers.count) return @"image/png";
  NSItemProvider *provider = providers[itemIndex];

  for (NSString *typeIdentifier in kImageTypes()) {
    if ([provider hasItemConformingToTypeIdentifier:typeIdentifier]) {
      UTType *utType = [UTType typeWithIdentifier:typeIdentifier];
      NSString *mime = utType.preferredMIMEType;
      return mime ?: @"image/png";
    }
  }
  return @"image/png";
}

/// Generates a filename from the current timestamp.
static NSString *KeyboardMediaFilename(NSString *mime) {
  NSString *ext = [mime componentsSeparatedByString:@"/"].lastObject ?: @"png";
  return [NSString stringWithFormat:@"keyboard-%lld.%@",
          (long long)([[NSDate date] timeIntervalSince1970] * 1000), ext];
}

/// Dispatches the base64-encoded image data to the frontend as a `canari-keyboard-media` DOM
/// event, matching the exact JSON shape produced by KeyboardMediaBridge.kt on Android.
static void DispatchToWeb(WKWebView *webView, NSString *mime, NSString *name, NSString *dataB64) {
  // Use JSONObject-style string building (no dependency on NSJSONSerialization for a fixed
  // shape). base64 contains no characters needing extra JS escaping.
  NSString *detail = [NSString stringWithFormat:@"{\"mime\":\"%@\",\"name\":\"%@\",\"data\":\"%@\"}",
                      mime, name, dataB64];
  NSString *script = [NSString stringWithFormat:
                      @"window.dispatchEvent(new CustomEvent('canari-keyboard-media',{detail:%@}))",
                      detail];
  dispatch_async(dispatch_get_main_queue(), ^{
    [webView evaluateJavaScript:script completionHandler:nil];
  });
}

// ─── Poll logic ──────────────────────────────────────────────────────────────

/// Called by the repeating timer. Reads the pasteboard if changeCount has advanced and an
/// image is available.
static void PollPasteboard(__unused NSTimer *timer) {
  if (!canari_ios_is_in_foreground()) return;
  WKWebView *webView = g_targetWebView;
  if (webView == nil) {
    // WKWebView was deallocated (e.g. app terminated abnormally). Try to re-acquire once.
    webView = FindWebView();
    if (webView != nil) {
      g_targetWebView = webView;
    } else {
      return;
    }
  }

  UIPasteboard *pb = [UIPasteboard generalPasteboard];
  NSInteger currentCount = pb.changeCount;
  if (currentCount == g_lastChangeCount) return;
  g_lastChangeCount = currentCount;

  NSInteger imageIdx = IndexOfImageItem(pb);
  if (imageIdx == NSNotFound) return;

  NSData *data = ReadImageData(pb, imageIdx);
  if (data == nil || data.length == 0) return;
  if (data.length > kMaxBytes) {
    NSLog(@"[KeyboardMediaBridge] image too large (%lu bytes), skipped", (unsigned long)data.length);
    return;
  }

  NSString *mime = MimeFromPasteboard(pb, imageIdx);
  NSString *name = KeyboardMediaFilename(mime);
  NSString *dataB64 = [data base64EncodedStringWithOptions:0];

  NSLog(@"[KeyboardMediaBridge] dispatching %@ (%lu bytes) as '%@'", mime, (unsigned long)data.length, name);
  DispatchToWeb(webView, mime, name, dataB64);
}

/// Starts the repeating poll timer on the main run loop.
static void StartPolling(void) {
  if (g_pollTimer != nil) return;
  g_pollTimer = [NSTimer scheduledTimerWithTimeInterval:kPollInterval
                                                repeats:YES
                                                  block:^(__unused NSTimer *timer) {
                                                    PollPasteboard(timer);
                                                  }];
  // Allow the timer to fire while scrolling (keyboard may be open over a scroll view).
  [[NSRunLoop mainRunLoop] addTimer:g_pollTimer forMode:NSRunLoopCommonModes];
  NSLog(@"[KeyboardMediaBridge] polling started (interval=%.1fs)", kPollInterval);
}

/// Stops the poll timer.
static void StopPolling(void) {
  if (g_pollTimer == nil) return;
  [g_pollTimer invalidate];
  g_pollTimer = nil;
  NSLog(@"[KeyboardMediaBridge] polling stopped");
}

/// Called when the app becomes active. Resumes polling and snaps the current changeCount so
/// any pasteboard content that arrived while backgrounded is not treated as a keyboard commit.
static void OnAppDidBecomeActive(__unused NSNotification *note) {
  WKWebView *webView = g_targetWebView;
  if (webView == nil) {
    webView = FindWebView();
    g_targetWebView = webView;
  }
  // Snap the changeCount to now – anything already in the pasteboard before the app came
  // to the foreground is NOT a keyboard commit.
  if (webView != nil) {
    g_lastChangeCount = [UIPasteboard generalPasteboard].changeCount;
  }
  StartPolling();
}

/// Called when the app resigns active. Pauses polling to save CPU while backgrounded.
static void OnAppWillResignActive(__unused NSNotification *note) {
  StopPolling();
}

// ─── Public API ──────────────────────────────────────────────────────────────

void CanariKeyboardMediaStart(WKWebView *webView) {
  if (webView == nil) {
    NSLog(@"[KeyboardMediaBridge] start called with nil WebView, will try to find one later");
    // Try to find it ourselves.
    webView = FindWebView();
    if (webView == nil) {
      NSLog(@"[KeyboardMediaBridge] no WKWebView found – keyboard media bridge disabled");
      return;
    }
  }

  g_targetWebView = webView;
  g_lastChangeCount = [UIPasteboard generalPasteboard].changeCount;

  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                OnAppDidBecomeActive(note);
              }];
  [nc addObserverForName:UIApplicationWillResignActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                OnAppWillResignActive(note);
              }];

  // Start immediately if already in the foreground.
  if (canari_ios_is_in_foreground()) {
    StartPolling();
  }

  NSLog(@"[KeyboardMediaBridge] initialized (target WebView=%p)", (__bridge void *)webView);
}

