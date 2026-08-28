#import "KeyboardMediaBridge.h"
#import "canari_ios.h"

#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <WebKit/WebKit.h>

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

WKWebView * _Nullable CanariFindWebView(void) {
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

// ─── Pasteboard event handling ──────────────────────────────────────────────

/// Called on `UIPasteboardChangedNotification` - the real event a 0.5 s `NSTimer` poll used to
/// stand in for (docs/wiki/frontend/android-ios-parity.md#2.1). A third-party iOS keyboard has
/// no direct content-commit API into a host app the way Android's IME does; it mediates through
/// the pasteboard, so this notification - fired exactly when that write happens - IS the commit
/// signal, not an approximation of one. Edge-triggered by construction: unlike the poll, it
/// cannot fire for content that was already on the pasteboard before this handler was attached,
/// so no changeCount bookkeeping is needed to reject stale content.
static void OnPasteboardChanged(__unused NSNotification *note) {
  if (!canari_ios_is_in_foreground()) return;
  WKWebView *webView = g_targetWebView;
  if (webView == nil) {
    // WKWebView was deallocated (e.g. app terminated abnormally). Try to re-acquire once.
    webView = CanariFindWebView();
    if (webView != nil) {
      g_targetWebView = webView;
    } else {
      return;
    }
  }

  UIPasteboard *pb = [UIPasteboard generalPasteboard];
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

/// Called when the app becomes active. Re-acquires the target WebView if it was deallocated
/// while backgrounded (e.g. the app was terminated and relaunched).
static void OnAppDidBecomeActive(__unused NSNotification *note) {
  if (g_targetWebView == nil) {
    g_targetWebView = CanariFindWebView();
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

void CanariKeyboardMediaStart(WKWebView *webView) {
  if (webView == nil) {
    NSLog(@"[KeyboardMediaBridge] start called with nil WebView, will try to find one later");
    // Try to find it ourselves.
    webView = CanariFindWebView();
    if (webView == nil) {
      NSLog(@"[KeyboardMediaBridge] no WKWebView found – keyboard media bridge disabled");
      return;
    }
  }

  g_targetWebView = webView;

  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  [nc addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                OnAppDidBecomeActive(note);
              }];
  [nc addObserverForName:UIPasteboardChangedNotification
                  object:[UIPasteboard generalPasteboard]
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *note) {
                OnPasteboardChanged(note);
              }];

  NSLog(@"[KeyboardMediaBridge] initialized, listening for UIPasteboardChangedNotification (target WebView=%p)",
        (__bridge void *)webView);
}

